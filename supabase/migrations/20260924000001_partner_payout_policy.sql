-- ============================================================================
-- PARTNER PAYOUT POLICY
-- ============================================================================
-- Partners earn GH₵5 on every completed delivery and are paid WEEKLY. A weekly
-- run pays out a Partner's available earnings once they reach GH₵20; below that
-- the balance carries forward to the next cycle.
--
-- THE LEDGER ALREADY EXISTS AND IS NOT REPLACED. `allocations` is the record of
-- what a Partner has earned, one row per completed delivery, written by
-- settle_partner_earnings(). `payouts` is the record of money leaving. What was
-- missing was a THRESHOLD that belongs to Partners rather than to everybody,
-- and the read models that let a Partner and an administrator see where a
-- balance actually stands.
--
-- WHY A SECOND THRESHOLD RATHER THAN REUSING min_payout_pesewas. Vendors are
-- now settled by Paystack split at the moment of the charge; the vendor run is
-- a fallback for stores with no subaccount, and holding a small store's food
-- money back for a week would be wrong. The Partner floor is a product policy
-- about weekly earnings. They are different numbers about different things and
-- collapsing them would mean one could not move without the other.
--
-- THE ROLLOVER IS NOT NEW MACHINERY. create_settlement_run() already claims
-- allocations, then RELEASES the claim for any payee under the threshold inside
-- the same transaction — so their money is owed again the moment the run
-- returns, and the next run sweeps it. This migration only changes which number
-- that comparison uses.

alter table public.pricing_config
  add column if not exists partner_min_payout_pesewas bigint not null default 2000;

alter table public.pricing_config
  drop constraint if exists pricing_config_partner_min_payout_check;
alter table public.pricing_config
  add constraint pricing_config_partner_min_payout_check
  check (partner_min_payout_pesewas >= 0);

comment on column public.pricing_config.partner_min_payout_pesewas is
  'What a Partner''s available earnings must reach before the weekly run pays them. GH₵20 (2000). A balance below it is NOT lost and NOT reset: the run releases its claim in the same transaction, so it is owed again immediately and carried into the next cycle.';

-- Existing deployments installed before this column keep the product default.
update public.pricing_config set partner_min_payout_pesewas = 2000
 where partner_min_payout_pesewas is null or partner_min_payout_pesewas = 0;

-- ---------------------------------------------------------------------------
-- The threshold a run actually applies
-- ---------------------------------------------------------------------------
-- One function, so the Partner dashboard, the admin screen and the run itself
-- can never disagree about what the policy is.

create or replace function public.payout_threshold_for(p_payee_type public.payee_type)
  returns bigint
  language sql stable
  set search_path to ''
as $$
  select case p_payee_type
           when 'PARTNER' then coalesce(c.partner_min_payout_pesewas, 0)
           else coalesce(c.min_payout_pesewas, 0)
         end
    from public.pricing_config c where c.id;
$$;

alter function public.payout_threshold_for(public.payee_type) owner to postgres;
comment on function public.payout_threshold_for(public.payee_type) is
  'The minimum a payee must be owed before a run will pay them. Partners have their own weekly floor; everybody else uses the general one.';
revoke all on function public.payout_threshold_for(public.payee_type) from public;
grant execute on function public.payout_threshold_for(public.payee_type) to authenticated, service_role;

create or replace function public.create_settlement_run(
  p_payee_type public.payee_type,
  p_period_start timestamptz,
  p_period_end timestamptz
) returns public.settlement_runs
  language plpgsql security definer
  set search_path to ''
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

  -- Partners have their own weekly floor; everybody else uses the general one.
  v_minimum := public.payout_threshold_for(p_payee_type);

  -- A payout is only ever created for a positive amount, so the effective floor
  -- is at least one pesewa. Without this a payee summing to exactly zero would
  -- be claimed and then left behind by the `having sum > 0` filter below —
  -- the same stranding, at a different amount.
  v_minimum := greatest(coalesce(v_minimum, 0), 1);

  insert into public.settlement_runs (payee_type, period_start, period_end, status, created_by)
  values (p_payee_type, p_period_start, p_period_end, 'PROCESSING', auth.uid())
  returning * into v_run;

  -- Claim everything eligible up to the end of the period. No lower bound:
  -- anything older than this period is either already claimed by the run that
  -- took it, or was deliberately released back — deferred, failed or reversed —
  -- and is exactly what should be swept up now. THAT RELEASE IS THE ROLLOVER.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at < p_period_end;

  -- Below the threshold the money stays owed. The claim is released in the same
  -- transaction that took it, so nothing is ever attached to a payout that will
  -- not be sent, and it shows up as owed again the moment this function
  -- returns. It is not lost, not reset, and not paid.
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

alter function public.create_settlement_run(public.payee_type, timestamptz, timestamptz) owner to postgres;

-- ---------------------------------------------------------------------------
-- What a Partner is shown
-- ---------------------------------------------------------------------------
-- THE WORDING IS A PRODUCT DECISION AND IT IS ENFORCED HERE, not left to a
-- screen. A Partner is told what their earnings are and when they are paid.
-- They are never told that a payment provider has a minimum transfer, because
-- that is Campus Dash's problem to solve and not theirs to be refused over.
--
-- The three states an earning can be in, kept apart because they mean different
-- things to the person waiting:
--
--   AVAILABLE   earned, not yet claimed by a run. This is "your balance".
--   IN PROGRESS claimed by a run and on its way. Do not count it twice.
--   PAID        the transfer landed.

drop function if exists public.partner_earnings_summary();

create or replace function public.partner_earnings_summary()
  returns table(
    delivered_count bigint,
    earned_pesewas bigint,
    awaiting_pesewas bigint,
    settled_pesewas bigint,
    available_pesewas bigint,
    in_progress_pesewas bigint,
    payout_threshold_pesewas bigint,
    eligible_for_payout boolean,
    pesewas_to_threshold bigint,
    rating_count bigint,
    average_stars numeric,
    last_paid_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  with mine as (
    select a.status, a.amount_pesewas
      from public.allocations a
     where a.payee_type = 'PARTNER' and a.payee_id = auth.uid()
       and a.status <> 'CANCELLED'
  ),
  totals as (
    select count(*)::bigint as delivered,
           coalesce(sum(amount_pesewas), 0)::bigint as earned,
           coalesce(sum(amount_pesewas) filter (where status <> 'SETTLED'), 0)::bigint as awaiting,
           coalesce(sum(amount_pesewas) filter (where status = 'SETTLED'), 0)::bigint as settled,
           coalesce(sum(amount_pesewas) filter (where status in ('PENDING', 'ELIGIBLE')), 0)::bigint as available,
           coalesce(sum(amount_pesewas) filter (where status = 'SETTLING'), 0)::bigint as in_progress
      from mine
  )
  select t.delivered, t.earned, t.awaiting, t.settled, t.available, t.in_progress,
         public.payout_threshold_for('PARTNER'),
         t.available >= public.payout_threshold_for('PARTNER'),
         greatest(0, public.payout_threshold_for('PARTNER') - t.available),
         (select count(*) from public.partner_ratings r where r.partner_id = auth.uid()),
         (select round(avg(r.stars), 2) from public.partner_ratings r where r.partner_id = auth.uid()),
         (select max(p.paid_at) from public.payouts p
           where p.payee_type = 'PARTNER' and p.payee_id = auth.uid() and p.status = 'PAID')
    from totals t
   where auth.uid() is not null;
$$;

alter function public.partner_earnings_summary() owner to postgres;
revoke all on function public.partner_earnings_summary() from public;
grant execute on function public.partner_earnings_summary() to authenticated;

-- A Partner's own payout history.
--
-- NO FAILURE REASON. A provider's rejection text names rails, limits and
-- account states that are Campus Dash's to resolve; showing it to a Partner
-- turns an operational hiccup into an accusation they cannot act on. They see
-- that a payout is on its way or has landed. An administrator sees why when it
-- has not — see admin_payout_history().
create or replace function public.my_partner_payouts(p_limit integer default 20)
  returns table(
    payout_id uuid, amount_pesewas bigint, status text,
    period_start timestamptz, period_end timestamptz,
    created_at timestamptz, paid_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select p.id, p.amount_pesewas,
         case p.status
           when 'PAID' then 'PAID'
           when 'REVERSED' then 'RETURNED'
           -- PENDING, PROCESSING and FAILED all read as "being processed": a
           -- failed transfer releases the money back into the next run, so from
           -- the Partner's side nothing has gone wrong and nothing is lost.
           else 'PROCESSING'
         end,
         r.period_start, r.period_end, p.created_at, p.paid_at
    from public.payouts p
    left join public.settlement_runs r on r.id = p.settlement_run_id
   where p.payee_type = 'PARTNER' and p.payee_id = auth.uid()
   order by p.created_at desc
   limit least(coalesce(p_limit, 20), 100);
$$;

alter function public.my_partner_payouts(integer) owner to postgres;
revoke all on function public.my_partner_payouts(integer) from public;
grant execute on function public.my_partner_payouts(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- What an administrator is shown
-- ---------------------------------------------------------------------------
-- The question a payout run raises is "who is about to be paid, who is not, and
-- why" — and the interesting rows are the ones a list of payouts leaves out.

create or replace function public.admin_partner_balances()
  returns table(
    partner_id uuid, partner_name text, phone text,
    delivered_count bigint,
    available_pesewas bigint, in_progress_pesewas bigint, settled_pesewas bigint,
    payout_threshold_pesewas bigint, eligible_for_payout boolean,
    has_destination boolean, transfers_ready boolean,
    last_paid_at timestamptz, oldest_unpaid_at timestamptz
  )
  language sql stable security definer
  set search_path to ''
as $$
  select p.user_id,
         u.full_name,
         u.phone,
         count(a.id) filter (where a.id is not null),
         coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLING'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint,
         public.payout_threshold_for('PARTNER'),
         coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0)
           >= public.payout_threshold_for('PARTNER'),
         d.payee_id is not null,
         d.provider_recipient_code is not null,
         (select max(po.paid_at) from public.payouts po
           where po.payee_type = 'PARTNER' and po.payee_id = p.user_id and po.status = 'PAID'),
         min(o.created_at) filter (where a.status in ('PENDING','ELIGIBLE'))
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.allocations a
      on a.payee_type = 'PARTNER' and a.payee_id = p.user_id and a.status <> 'CANCELLED'
    left join public.orders o on o.id = a.order_id
    left join public.payout_destinations d
      on d.payee_type = 'PARTNER' and d.payee_id = p.user_id
   where public.is_admin()
     and p.status = 'APPROVED'
   group by p.user_id, u.full_name, u.phone, d.payee_id, d.provider_recipient_code
   order by coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0) desc;
$$;

alter function public.admin_partner_balances() owner to postgres;
comment on function public.admin_partner_balances() is
  'Every approved Partner, what they are owed, whether it clears the weekly threshold, and whether they can actually be paid. Never returns an account number.';
revoke all on function public.admin_partner_balances() from public;
grant execute on function public.admin_partner_balances() to authenticated;

-- ---------------------------------------------------------------------------
-- The setting
-- ---------------------------------------------------------------------------

drop function if exists public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint);

create or replace function public.admin_update_config(
  p_reason                            text,
  p_service_fee_bps                   integer  default null,
  p_delivery_fee_pesewas              bigint   default null,
  p_partner_share_of_delivery_bps     integer  default null,
  p_vendor_response_seconds           integer  default null,
  p_partner_search_seconds            integer  default null,
  p_customer_absent_wait_seconds      integer  default null,
  p_payment_pending_timeout_seconds   integer  default null,
  p_min_payout_pesewas                bigint   default null,
  p_notification_retry_limit          integer  default null,
  p_vendor_poll_seconds               integer  default null,
  p_partner_poll_seconds              integer  default null,
  p_customer_poll_seconds             integer  default null,
  p_scan_service_fee_pesewas          bigint   default null,
  p_max_active_deliveries_per_partner smallint default null,
  p_partner_min_payout_pesewas        bigint   default null
) returns public.pricing_config
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_max_active_deliveries_per_partner is not null
     and (p_max_active_deliveries_per_partner < 1 or p_max_active_deliveries_per_partner > 10) then
    raise exception 'a Partner may carry between 1 and 10 deliveries at once'
      using errcode = 'check_violation';
  end if;

  if p_partner_min_payout_pesewas is not null and p_partner_min_payout_pesewas < 0 then
    raise exception 'the Partner payout threshold cannot be negative'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.pricing_config where id;

  update public.pricing_config
     set service_fee_bps                 = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas            = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps   = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds         = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds          = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds    = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas              = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit        = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds             = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds            = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds),
         scan_service_fee_pesewas        = coalesce(p_scan_service_fee_pesewas, scan_service_fee_pesewas),
         max_active_deliveries_per_partner =
           coalesce(p_max_active_deliveries_per_partner, max_active_deliveries_per_partner),
         partner_min_payout_pesewas      = coalesce(p_partner_min_payout_pesewas, partner_min_payout_pesewas),
         updated_at                      = now()
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

alter function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint, bigint) owner to postgres;
revoke all on function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint, bigint) from public;
grant execute on function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint, bigint) to authenticated;
