-- ============================================================================
-- The minimum-payout hold, done properly
-- ============================================================================
-- The threshold lived in JavaScript, and it was applied AFTER the run had
-- already claimed the money. So a below-minimum payee ended up with:
--
--   * a PENDING payout nothing would ever send,
--   * allocations at SETTLING, stamped with that run's id,
--
-- while every future run claims only `status = 'ELIGIBLE' and
-- settlement_run_id is null`. The held liability was therefore invisible to
-- admin_pending_settlement and unreachable by every later run — stranded, with
-- a payout row implying it was on its way.
--
-- Two changes fix it, and both belong in SQL because both are money:
--
--   1. THE THRESHOLD IS APPLIED BEFORE A PAYOUT EXISTS. A payee under it has
--      their claim RELEASED in the same transaction, so nothing is created that
--      cannot be sent, and what is owed goes straight back into the pool where
--      admin_pending_settlement can see it.
--
--   2. A RUN SWEEPS FORWARD, not just its own window. The claim keeps its upper
--      bound — a run for a past period must not take money that came in after
--      it — but drops the lower one. Without that, liability deferred in an
--      earlier period could never be picked up by a later run, because the
--      ORDER's created_at stays where it always was. Deferral only means
--      anything if a later run can actually reach it.
--
-- The lower bound was never a safety property: allocations disappear from the
-- pool the moment they are claimed, so a previous period's money is already
-- gone. The only rows an unbounded sweep finds are the ones deliberately put
-- back — deferred, failed, or reversed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What a run held back
-- ---------------------------------------------------------------------------
-- Recorded on the run rather than inferred afterwards: once the allocations are
-- released there is nothing left tying them to the run that deferred them, and
-- "we moved nothing and that was correct" is a different report from "we moved
-- nothing and something is wrong".
alter table public.settlement_runs
  add column if not exists deferred_payee_count integer not null default 0
    check (deferred_payee_count >= 0),
  add column if not exists deferred_pesewas bigint not null default 0
    check (deferred_pesewas >= 0);

comment on column public.settlement_runs.deferred_pesewas is
  'Owed to payees under min_payout_pesewas at run time. NOT claimed by this run — released back to the pool for a later one.';

-- ---------------------------------------------------------------------------
-- create_settlement_run
-- ---------------------------------------------------------------------------
create or replace function public.create_settlement_run(
  p_payee_type   public.payee_type,
  p_period_start timestamptz,
  p_period_end   timestamptz
)
returns public.settlement_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run      public.settlement_runs%rowtype;
  v_total    bigint;
  v_minimum  bigint;
  v_deferred record;
begin
  perform public.assert_service_or_admin();

  -- PLATFORM is Campus Dash's own revenue, and its allocations carry no
  -- payee_id, so a PLATFORM run could never produce a payout — it would only
  -- move the platform's own ledger rows to SETTLING and strand them there. It
  -- is refused rather than silently doing that.
  if p_payee_type = 'PLATFORM' then
    raise exception 'PLATFORM revenue is not settled by a payout run'
      using errcode = 'check_violation';
  end if;

  -- Re-running a period returns the existing run rather than creating a second
  -- one that would pay everybody twice.
  select * into v_run from public.settlement_runs
   where payee_type = p_payee_type
     and period_start = p_period_start and period_end = p_period_end;
  if found then
    return v_run;
  end if;

  select coalesce(min_payout_pesewas, 0) into v_minimum
    from public.pricing_config where id;

  -- A payout is only ever created for a positive amount, so the effective floor
  -- is at least one pesewa. Without this a payee summing to exactly zero would
  -- be claimed and then left behind by the `having sum > 0` filter below —
  -- the same stranding, at a different amount.
  v_minimum := greatest(coalesce(v_minimum, 0), 1);

  insert into public.settlement_runs (payee_type, period_start, period_end, status, created_by)
  values (p_payee_type, p_period_start, p_period_end, 'PROCESSING', auth.uid())
  returning * into v_run;

  -- Claim everything eligible up to the end of the period. No lower bound: see
  -- the header. Anything older than this period is either already claimed by
  -- the run that took it, or was deliberately released back — deferred, failed
  -- or reversed — and is exactly what should be swept up now.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at < p_period_end;

  -- Below the threshold a transfer costs more in fees than it moves. The claim
  -- is released in the same transaction that took it, so the money is never
  -- attached to a payout that will not be sent, and shows up as owed again the
  -- moment this function returns.
  select count(*)::integer as payees, coalesce(sum(owed), 0)::bigint as pesewas
    into v_deferred
    from (
      select a.payee_id, sum(a.amount_pesewas) as owed
        from public.allocations a
       where a.settlement_run_id = v_run.id and a.payee_id is not null
       group by a.payee_id
      having sum(a.amount_pesewas) < v_minimum
    ) under_threshold;

  update public.allocations a
     set settlement_run_id = null, status = 'ELIGIBLE', settled_at = null
   where a.settlement_run_id = v_run.id
     and a.payee_id in (
       select a2.payee_id
         from public.allocations a2
        where a2.settlement_run_id = v_run.id and a2.payee_id is not null
        group by a2.payee_id
       having sum(a2.amount_pesewas) < v_minimum
     );

  -- One payout per payee, summing what is left claimed. The unique index on
  -- (settlement_run_id, payee_type, payee_id) makes a duplicate impossible.
  insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
  select v_run.id, a.payee_type, a.payee_id, sum(a.amount_pesewas),
         'payout:' || v_run.id || ':' || a.payee_type::text || ':' || a.payee_id
    from public.allocations a
   where a.settlement_run_id = v_run.id and a.payee_id is not null
   group by a.payee_type, a.payee_id
  having sum(a.amount_pesewas) >= v_minimum;

  select coalesce(sum(amount_pesewas), 0) into v_total
    from public.payouts where settlement_run_id = v_run.id;

  update public.settlement_runs
     set total_pesewas = v_total,
         deferred_payee_count = v_deferred.payees,
         deferred_pesewas = v_deferred.pesewas
   where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- retry_payout — reclaim over the same window the run claimed over
-- ---------------------------------------------------------------------------
-- The reclaim predicate has to mirror the claim predicate exactly, or a retry
-- of a payout built from swept-forward liability would find less than it was
-- built from and refuse itself. The equality check below is what makes the
-- widened window safe: a retry takes back precisely what this payout was worth,
-- or it takes back nothing at all.
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
     and o.created_at < v_run.period_end;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where settlement_run_id = v_run.id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id;

  if v_sum <> v_payout.amount_pesewas then
    -- Put back whatever we just took, so a refused retry changes nothing.
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
-- admin_settlement_runs — show what was held back
-- ---------------------------------------------------------------------------
-- A run that moved nothing because everybody was under the threshold looks
-- identical to a run that found nothing at all, and those need different
-- responses from whoever is watching.
drop function if exists public.admin_settlement_runs(integer);

create or replace function public.admin_settlement_runs(p_limit integer default 50)
returns table (
  run_id           uuid,
  payee_type       public.payee_type,
  period_start     timestamptz,
  period_end       timestamptz,
  status           public.settlement_run_status,
  total_pesewas    bigint,
  deferred_pesewas bigint,
  deferred_payees  integer,
  payout_count     bigint,
  paid_count       bigint,
  failed_count     bigint,
  created_at       timestamptz,
  completed_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.payee_type, r.period_start, r.period_end, r.status, r.total_pesewas,
         r.deferred_pesewas, r.deferred_payee_count,
         (select count(*) from public.payouts p where p.settlement_run_id = r.id),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'PAID'),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'FAILED'),
         r.created_at, r.completed_at
    from public.settlement_runs r
   where public.is_admin()
   order by r.created_at desc
   limit least(coalesce(p_limit, 50), 200);
$$;

revoke execute on function public.admin_settlement_runs(integer) from public, anon;
grant execute on function public.admin_settlement_runs(integer) to authenticated;
