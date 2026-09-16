-- ---------------------------------------------------------------------------
-- PARTNERS ARE SETTLED BY HAND, AND THE SYSTEM SAYS SO
-- ---------------------------------------------------------------------------
-- For V1 a Partner's earnings sit in the Campus Dash balance and an
-- administrator pays them at the end of each week. That was already TRUE in
-- practice, but only because `PAYSTACK_TRANSFERS_ENABLED` is false — the
-- settlement run happily called sendTransfer() for a Partner and was stopped by
-- an environment variable.
--
-- AN ENVIRONMENT VARIABLE IS NOT A POLICY. It is one deploy away from being
-- wrong, it is invisible to anybody reading the code, and the failure it
-- prevents is money leaving automatically to a destination nobody checked.
-- Partner settlement is manual by DESIGN now: the run creates the payouts and
-- stops, and a person marks each one settled after they have actually sent it.
--
-- WHAT DOES NOT CHANGE. The ledger. Allocations are still carved out at
-- completion, still claimed by a run, and still released when a payee is under
-- the weekly threshold — so "owed" and "settled" mean exactly what they meant,
-- and admin_pending_settlement() still answers "where is the money now".
--
-- VENDORS ARE UNAFFECTED. Their share is split at the charge by Paystack, and
-- the vendor run is a fallback for stores with no subaccount. Nothing here
-- reaches it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. MARKING ONE SETTLED, BY HAND
-- ---------------------------------------------------------------------------
-- Deliberately NOT mark_payout_paid(). That one is the provider's road: it is
-- service-only, it takes a provider transfer id, and it exists to be called by
-- a webhook. This is a person saying "I sent this", which is a different claim
-- with a different kind of evidence — a MoMo reference they typed — and it
-- belongs in the audit trail as an administrative act.

create or replace function public.admin_settle_payout_manually(
  p_payout_id uuid,
  p_reference text,
  p_reason text
)
returns public.payouts
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.payouts%rowtype;
  v_payout public.payouts%rowtype;
  v_ref    text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- IDEMPOTENT REPLAY. A double-tapped button must not write a second audit
  -- entry claiming the money was sent twice.
  if v_before.status = 'PAID' then
    return v_before;
  end if;

  -- THE REFERENCE IS THE EVIDENCE. A manual settlement has no provider event
  -- behind it, so the only thing linking this row to a real transfer is what
  -- the person typed — a MoMo transaction id, a bank reference, "cash, signed
  -- for". Without it the record says money moved and gives nobody a way to
  -- check, which is worse than no record.
  if v_ref is null then
    raise exception 'record the transfer reference you sent it with'
      using errcode = 'check_violation';
  end if;

  update public.payouts
     set status = 'PAID',
         provider = 'manual',
         provider_transfer_id = v_ref,
         paid_at = now()
   where id = p_payout_id
     and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'that payout is not awaiting settlement' using errcode = 'check_violation';
  end if;

  -- THE LIABILITY CLEARS, exactly as it does on a provider transfer. The
  -- allocations this payout was made of stop being owed.
  update public.allocations
     set status = 'SETTLED', settled_at = now()
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id = v_payout.payee_id;

  perform public.log_admin_action(
    'PAYOUT_SETTLED_MANUALLY', 'payout', p_payout_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_payout)
  );

  return v_payout;
end;
$$;

comment on function public.admin_settle_payout_manually(uuid, text, text) is
  'A person recording that they sent a payout themselves. Separate from mark_payout_paid(), which is the provider''s road and is service-only: this is an administrative act with a typed reference as its only evidence, so it is refused without one and it appends to admin_actions.';

-- ---------------------------------------------------------------------------
-- 2. WHAT IS WAITING TO BE PAID
-- ---------------------------------------------------------------------------
-- The screen that does the weekly run needs one list: who, how much, where to
-- send it, and whether it has been done. Assembled here rather than from three
-- queries in a page, so the destination and the amount cannot come from
-- different moments.

create or replace function public.admin_payouts_awaiting_settlement(
  p_payee_type public.payee_type default 'PARTNER'
)
returns table(
  payout_id uuid,
  settlement_run_id uuid,
  payee_type public.payee_type,
  payee_id uuid,
  payee_name text,
  payee_phone text,
  amount_pesewas bigint,
  status public.payout_status,
  created_at timestamp with time zone,
  period_start timestamp with time zone,
  period_end timestamp with time zone,
  momo_network text,
  account_last3 text,
  account_name text,
  deliveries bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select p.id,
         p.settlement_run_id,
         p.payee_type,
         p.payee_id,
         u.full_name,
         u.phone,
         p.amount_pesewas,
         p.status,
         p.created_at,
         r.period_start,
         r.period_end,
         d.momo_network,
         -- THE LAST THREE DIGITS, never the number. An operator checking they
         -- are paying the right person needs to recognise it, not to be able
         -- to read it off a screen in a shared office.
         case when d.account_number is not null
              then right(d.account_number, 3) end,
         d.account_name,
         (select count(*) from public.allocations a
           where a.settlement_run_id = p.settlement_run_id
             and a.payee_type = p.payee_type
             and a.payee_id = p.payee_id)
    from public.payouts p
    join public.settlement_runs r on r.id = p.settlement_run_id
    left join public.users u on u.id = p.payee_id
    left join public.payout_destinations d
           on d.payee_type = p.payee_type and d.payee_id = p.payee_id
   where public.is_admin()
     and p.payee_type = p_payee_type
     and p.status in ('PENDING', 'PROCESSING', 'FAILED')
   order by p.created_at desc;
$$;

comment on function public.admin_payouts_awaiting_settlement(public.payee_type) is
  'The weekly settlement list: who is owed, how much, and where to send it. Returns only the last three digits of an account number — an operator needs to recognise a destination, not to be able to read one off a screen in a shared office.';

-- ---------------------------------------------------------------------------
-- 3. GRANTS
-- ---------------------------------------------------------------------------

revoke all on function public.admin_settle_payout_manually(uuid, text, text) from public, anon;
grant execute on function public.admin_settle_payout_manually(uuid, text, text) to authenticated;

revoke all on function public.admin_payouts_awaiting_settlement(public.payee_type)
  from public, anon;
grant execute on function public.admin_payouts_awaiting_settlement(public.payee_type)
  to authenticated;
