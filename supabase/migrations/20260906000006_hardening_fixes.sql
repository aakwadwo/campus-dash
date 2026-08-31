-- ============================================================================
-- Two bugs in the hardening itself, found by its own tests
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. customer_abandon_stuck_payment could never work
-- ---------------------------------------------------------------------------
-- It delegated to fail_payment(), which asserts a server context. Inside a
-- SECURITY DEFINER function the caller is still the signed-in user as far as
-- that assertion is concerned, so a customer hit "this operation is server-side
-- only" every time.
--
-- The fix keeps ONE implementation of "this payment did not happen" and moves
-- the authorisation decision to the callers, where it belongs: fail_payment()
-- asserts a server context, customer_abandon_stuck_payment() has already proved
-- ownership and the timeout.
create or replace function public.mark_payment_failed_internal(
  p_payment_id uuid,
  p_reason     text
)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  update public.payments
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  -- Back to FAILED, from which the customer may retry. The food order is
  -- untouched: the vendor's acceptance still stands.
  update public.orders set payment_status = 'FAILED'
   where id = v_payment.order_id and payment_status = 'PENDING';

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_FAILED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'FAILED', p_reason);

  return v_payment;
end;
$$;

create or replace function public.fail_payment(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform public.assert_service_or_admin();
  return public.mark_payment_failed_internal(p_payment_id, p_reason);
end;
$$;

create or replace function public.customer_abandon_stuck_payment(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  -- Ownership is proved here, which is what earns the right to skip the
  -- server-context assertion below.
  select p.* into v_payment
    from public.payments p
    join public.orders o on o.id = p.order_id
   where p.order_id = p_order_id
     and o.customer_id = auth.uid()
     and p.status = 'PENDING';

  if not found then
    return row(false, 'there is no payment waiting on this order')::public.transition_result;
  end if;

  if v_payment.created_at > now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds) then
    return row(
      false,
      'we are still waiting to hear from the payment provider — please give it a moment'
    )::public.transition_result;
  end if;

  perform public.mark_payment_failed_internal(v_payment.id, 'customer abandoned a stuck payment');

  return row(true, null)::public.transition_result;
end;
$$;

create or replace function public.expire_stale_payments()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_count   integer := 0;
  v_payment record;
begin
  perform public.assert_service_or_admin();
  select * into v_cfg from public.pricing_config where id;

  for v_payment in
    select p.id
      from public.payments p
     where p.status = 'PENDING'
       and p.created_at < now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds)
  loop
    perform public.mark_payment_failed_internal(
      v_payment.id,
      'no confirmation from the payment provider within the timeout'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.mark_payment_failed_internal(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.fail_payment(uuid, text) from public, anon, authenticated;
revoke execute on function public.expire_stale_payments() from public, anon, authenticated;
revoke execute on function public.customer_abandon_stuck_payment(uuid) from public, anon;
grant execute on function public.customer_abandon_stuck_payment(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. admin_pilot_metrics leaked to non-admins
-- ---------------------------------------------------------------------------
-- The is_admin() filter sat inside one CTE, but half the UNION branches read
-- other tables directly and were never gated. A vendor calling it got the
-- platform's order counts, revenue and unsettled totals.
--
-- Guarding a dozen branches individually is exactly how the next one gets
-- missed, so the check now happens once, before any of them run.
create or replace function public.admin_pilot_metrics(p_since timestamptz default null)
returns table (metric text, value numeric, unit text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    return;  -- an empty result, not an error page
  end if;

  return query
  with bounds as (
    select coalesce(p_since, date_trunc('day', now())) as since
  ),
  o as (
    select orders.* from public.orders, bounds
     where orders.created_at >= bounds.since and orders.order_status <> 'DRAFT'
  )
  select 'orders_placed', count(*)::numeric, 'orders' from o
  union all
  select 'orders_accepted', count(*) filter (where accepted_at is not null)::numeric, 'orders' from o
  union all
  select 'orders_rejected', count(*) filter (where order_status = 'REJECTED')::numeric, 'orders' from o
  union all
  select 'orders_expired_no_vendor_answer',
         count(*) filter (where order_status = 'EXPIRED')::numeric, 'orders' from o
  union all
  select 'orders_completed', count(*) filter (where order_status = 'COMPLETED')::numeric, 'orders' from o
  union all
  select 'orders_cancelled',
         count(*) filter (where order_status in ('CANCELLED', 'CANCELLED_BY_VENDOR'))::numeric,
         'orders' from o
  union all
  select 'median_vendor_response_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (accepted_at - submitted_at)))::numeric, 'seconds'
    from o where accepted_at is not null
  union all
  select 'median_customer_pay_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (p.succeeded_at - o.accepted_at)))::numeric, 'seconds'
    from o join public.payments p on p.order_id = o.id and p.status = 'SUCCEEDED'
   where o.accepted_at is not null
  union all
  select 'median_prep_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (ready_at - preparing_at)))::numeric, 'seconds'
    from o where ready_at is not null and preparing_at is not null
  union all
  select 'median_partner_match_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (assigned_at - search_started_at)))::numeric, 'seconds'
    from o where assigned_at is not null and search_started_at is not null
  union all
  select 'median_delivery_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (delivered_at - picked_up_at)))::numeric, 'seconds'
    from o where delivered_at is not null and picked_up_at is not null
  union all
  select 'deliveries_requested',
         count(*) filter (where fulfilment_type = 'DELIVERY')::numeric, 'orders' from o
  union all
  select 'deliveries_no_partner_found',
         count(*) filter (where delivery_status = 'FAILED_NO_PARTNER')::numeric, 'orders' from o
  union all
  select 'deliveries_customer_absent',
         count(*) filter (where delivery_status = 'FAILED_CUSTOMER_ABSENT')::numeric, 'orders' from o
  union all
  select 'partner_cancellations',
         (select count(*) from public.order_events e, bounds
           where e.event = 'PARTNER_CANCEL' and e.accepted and e.created_at >= bounds.since)::numeric,
         'events'
  union all
  select 'disputes_open',
         count(*) filter (where disputed_at is not null and dispute_resolved_at is null)::numeric,
         'orders' from o
  union all
  select 'partners_approved',
         (select count(*) from public.partner_profiles where status = 'APPROVED')::numeric, 'partners'
  union all
  select 'partners_online_now',
         (select count(*) from public.partner_profiles
           where status = 'APPROVED' and is_available)::numeric, 'partners'
  union all
  select 'partners_on_a_delivery_now',
         (select count(distinct partner_id) from public.orders
           where delivery_status in ('ASSIGNED', 'PICKED_UP'))::numeric, 'partners'
  union all
  select 'collected_pesewas',
         coalesce(sum(total_pesewas) filter (where payment_status = 'PAID'), 0)::numeric, 'pesewas'
    from o
  union all
  select 'unsettled_pesewas',
         (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
           where a.status in ('PENDING', 'ELIGIBLE', 'SETTLING'))::numeric, 'pesewas'
  union all
  select 'settled_pesewas',
         (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
           where a.status = 'SETTLED')::numeric, 'pesewas'
  union all
  select 'payouts_failed',
         (select count(*) from public.payouts where status = 'FAILED')::numeric, 'payouts'
  union all
  select 'reconciliation_issues',
         (select count(*) from public.admin_reconciliation(500))::numeric, 'issues'
  union all
  select 'notifications_sent',
         (select count(*) from public.notification_events n, bounds
           where n.succeeded and n.created_at >= bounds.since)::numeric, 'messages'
  union all
  select 'notifications_failed',
         (select count(*) from public.notification_events n, bounds
           where not n.succeeded and n.created_at >= bounds.since)::numeric, 'messages'
  union all
  select 'notifications_per_order',
         case when (select count(*) from o) = 0 then 0
              else round(
                (select count(*) from public.notification_events n, bounds
                  where n.succeeded and n.created_at >= bounds.since)::numeric
                / (select count(*) from o), 2) end,
         'messages';
end;
$$;

revoke execute on function public.admin_pilot_metrics(timestamptz) from public, anon;
grant execute on function public.admin_pilot_metrics(timestamptz) to authenticated;
