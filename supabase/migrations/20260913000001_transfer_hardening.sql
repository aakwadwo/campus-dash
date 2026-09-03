-- ============================================================================
-- Paystack transfer hardening — retry references, amount checks, reversals
-- ============================================================================
-- Three defects found by the transfer-readiness audit. All of them are latent
-- while PAYSTACK_TRANSFERS_ENABLED is false, and all of them bite the moment it
-- is not.
--
--   D1  A retried payout re-used its payout id as the Paystack reference.
--       Paystack requires transfer references to be unique, so the retry — the
--       ONLY recovery mechanism, since nothing retries automatically — would be
--       refused for any payout that had already reached them.
--
--   D2  transfer.success was applied without checking the amount. Collections
--       have had that guard since the beginning (confirm_payment raises on a
--       mismatch); transfers did not.
--
--   D3  transfer.reversed was mapped onto the ordinary failure path, and
--       fail_payout deliberately refuses to touch a PAID payout — correct for a
--       LATE FAILURE, wrong for a REVERSAL, where the money genuinely came
--       back. The payout stayed PAID and the allocations stayed SETTLED while
--       Campus Dash still owed the money.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Schema: the two smallest additions that make the above representable
-- ---------------------------------------------------------------------------
-- A reversal is not a failure and it is not a payment. It is its own outcome:
-- money that left and came back. Folding it into FAILED would lose the fact
-- that a transfer really did complete first, which is exactly what someone
-- investigating needs to know.
alter type public.payout_status add value if not exists 'REVERSED';

-- Which attempt we are on. The Paystack reference is derived from this, so
-- every attempt carries a reference Paystack has not seen before, while our own
-- payout id and idempotency key stay exactly as they were.
alter table public.payouts
  add column if not exists transfer_attempt integer not null default 0;

comment on column public.payouts.transfer_attempt is
  'Number of transfer attempts made. Drives the provider reference so a retry is never a duplicate; our payout id and idempotency_key are unchanged by it.';

-- ---------------------------------------------------------------------------
-- D1 — a retry gets a reference Paystack has never seen
-- ---------------------------------------------------------------------------
-- The attempt counter moves here, in the same statement that puts the payout
-- back to PENDING, so a retry cannot be prepared without also being given a
-- fresh reference. The body is otherwise the reclaim logic exactly as it was.
create or replace function public.retry_payout(p_payout_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
  v_run    public.settlement_runs%rowtype;
  v_sum    bigint;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    return (false, 'payout not found')::public.transition_result;
  end if;
  if v_payout.status = 'PAID' then
    return (false, 'this payout is already paid')::public.transition_result;
  end if;
  -- A reversal is not retried here. The allocations went back into the pool, so
  -- the money is settled again by the NEXT run, under a new payout — never by
  -- re-sending a transfer that already completed once.
  if v_payout.status = 'REVERSED' then
    return (false,
      'this payout was reversed; the money is owed again and the next run will settle it')
      ::public.transition_result;
  end if;
  if v_payout.status <> 'FAILED' then
    return (false, 'only a failed payout is retried')::public.transition_result;
  end if;

  select * into v_run from public.settlement_runs where id = v_payout.settlement_run_id;

  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = v_payout.payee_type
     and a.payee_id   = v_payout.payee_id
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at >= v_run.period_start
     and o.created_at <  v_run.period_end;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where settlement_run_id = v_run.id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id;

  if v_sum <> v_payout.amount_pesewas then
    update public.allocations
       set settlement_run_id = null, status = 'ELIGIBLE'
     where settlement_run_id = v_run.id
       and payee_type = v_payout.payee_type
       and payee_id   = v_payout.payee_id
       and status = 'SETTLING';
    return (false,
      'the allocations behind this payout have moved to another run; settle it there')
      ::public.transition_result;
  end if;

  update public.payouts
     set status = 'PENDING', failure_reason = null,
         provider_transfer_id = null,
         -- The next attempt therefore builds a DIFFERENT provider reference.
         transfer_attempt = transfer_attempt + 1
   where id = p_payout_id and status = 'FAILED';

  return (true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- payout_for_transfer — understands a retry reference
-- ---------------------------------------------------------------------------
-- References are '<payout uuid>' on the first attempt and '<payout uuid>-r<n>'
-- afterwards, so the uuid is taken from the front rather than assuming the
-- whole string is one.
create or replace function public.payout_for_transfer(
  p_provider             text,
  p_provider_transfer_id text,
  p_reference            text default null
)
returns public.payouts
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
  v_id     text;
begin
  perform public.assert_service_or_admin();

  if p_provider_transfer_id is not null then
    select * into v_payout from public.payouts
     where provider = p_provider and provider_transfer_id = p_provider_transfer_id;
    if found then
      return v_payout;
    end if;
  end if;

  if p_reference is not null then
    v_id := substring(p_reference from '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})');
    if v_id is not null then
      select * into v_payout from public.payouts where id = v_id::uuid;
    end if;
  end if;

  return v_payout;
end;
$$;

-- ---------------------------------------------------------------------------
-- D2 — a transfer is only PAID for the amount we actually owed
-- ---------------------------------------------------------------------------
-- Replaces the three-argument form rather than sitting beside it, for the same
-- reason as everywhere else: two overloads is how one of them quietly keeps
-- being called.
--
-- p_amount_pesewas is NULL-able on purpose. A synchronous provider that returns
-- SUCCEEDED from the transfer call itself reports no independent amount, and a
-- guard cannot be invented out of the number we just sent. Webhooks DO carry
-- one, and that is the path this exists for.
drop function if exists public.mark_payout_paid(uuid, text, text);

create or replace function public.mark_payout_paid(
  p_payout_id            uuid,
  p_provider             text,
  p_provider_transfer_id text,
  p_amount_pesewas       bigint default null
)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  if v_payout.status = 'PAID' then
    return v_payout;  -- idempotent replay
  end if;

  -- The provider must have moved exactly what was owed. A mismatch is a
  -- reconciliation incident, not something to paper over — the same rule
  -- confirm_payment applies to money coming in.
  if p_amount_pesewas is not null and p_amount_pesewas <> v_payout.amount_pesewas then
    raise exception 'payout amount mismatch: provider reported % but payout is %',
      p_amount_pesewas, v_payout.amount_pesewas using errcode = 'check_violation';
  end if;

  update public.payouts
     set status = 'PAID', provider = p_provider,
         provider_transfer_id = p_provider_transfer_id, paid_at = now()
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not payable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'SETTLED', settled_at = now()
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id = v_payout.payee_id;

  return v_payout;
end;
$$;

-- ---------------------------------------------------------------------------
-- D3 — a reversal is its own outcome
-- ---------------------------------------------------------------------------
-- fail_payout is left exactly as it is. A late transfer.failed against a PAID
-- payout must still be ignored: money that left is not un-sent by an event that
-- arrived out of order.
--
-- A REVERSAL is the opposite case and needs saying out loud: the transfer
-- completed, and then the money came back. So the payout becomes REVERSED
-- rather than FAILED — the distinction a person investigating actually needs —
-- and the liability is restored by putting the allocations back into the pool,
-- unclaimed and ELIGIBLE, exactly as a failure does. The next settlement run
-- picks them up under a new payout.
--
-- Reconciliation sees it from both ends: the payout reads REVERSED, and the
-- money reappears in admin_pending_settlement as owed.
create or replace function public.reverse_payout(p_payout_id uuid, p_reason text default null)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent: a provider that sends the reversal five times reverses once.
  if v_payout.status = 'REVERSED' then
    return v_payout;
  end if;

  -- A reversal that arrives for a payout which never reached PAID is simply a
  -- failure, and is recorded as one. Nothing was settled, so there is nothing
  -- to unwind beyond releasing the claim.
  if v_payout.status in ('PENDING', 'PROCESSING') then
    return public.fail_payout(p_payout_id, coalesce(p_reason, 'provider reported REVERSED'));
  end if;

  if v_payout.status <> 'PAID' then
    return v_payout;  -- FAILED or CANCELLED: already not owed to anybody
  end if;

  update public.payouts
     set status = 'REVERSED',
         failure_reason = coalesce(p_reason, 'provider reversed this transfer'),
         paid_at = null
   where id = p_payout_id and status = 'PAID'
  returning * into v_payout;

  if not found then
    raise exception 'payout was not reversible' using errcode = 'check_violation';
  end if;

  -- The liability comes back. These were SETTLED by mark_payout_paid; they are
  -- owed again, so they return to the pool for the next run.
  update public.allocations
     set status = 'ELIGIBLE', settlement_run_id = null, settled_at = null
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id
     and status = 'SETTLED';

  return v_payout;
end;
$$;

revoke execute on function public.mark_payout_paid(uuid, text, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.reverse_payout(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- fail_payout — a failure arriving after a reversal is not an error
-- ---------------------------------------------------------------------------
-- Without this, transfer.failed against an already-REVERSED payout fell through
-- to the conditional UPDATE, matched nothing and raised — which the webhook
-- handler turns into a 500, which asks the provider to deliver it again, for
-- ever. Both terminal states now read the same way: nothing left to do.
--
-- The PAID early-return is unchanged and still deliberate: money that left is
-- not un-sent by an event arriving out of order. That is what reverse_payout is
-- for.
create or replace function public.fail_payout(p_payout_id uuid, p_reason text default null)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- Money already out of the door is not un-sent by a late failure event.
  if v_payout.status = 'PAID' then
    return v_payout;
  end if;
  -- Already terminal: idempotent replay, and a failure after a reversal has
  -- nothing left to unwind.
  if v_payout.status in ('FAILED', 'REVERSED') then
    return v_payout;
  end if;

  update public.payouts
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not failable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'ELIGIBLE', settlement_run_id = null, settled_at = null
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id
     and status = 'SETTLING';

  return v_payout;
end;
$$;
