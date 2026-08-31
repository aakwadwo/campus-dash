-- ============================================================================
-- Pilot observability
-- ============================================================================
-- Enough to answer the questions a pilot actually raises, and no more. Every
-- figure here comes from order_events and notification_events, which are
-- already written for audit reasons — so this adds no new recording, only
-- reading.
--
-- Deliberately not an analytics product. The purpose is to learn during a
-- two-week pilot, then throw most of these numbers away.
-- ============================================================================

create or replace function public.admin_pilot_metrics(p_since timestamptz default null)
returns table (
  metric text,
  value  numeric,
  unit   text
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select coalesce(p_since, date_trunc('day', now())) as since
  ),
  o as (
    select * from public.orders, bounds
     where public.is_admin() and orders.created_at >= bounds.since
       and orders.order_status <> 'DRAFT'
  )
  -- Volume
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

  -- Timing: the numbers the pilot exists to discover
  union all
  select 'median_vendor_response_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (accepted_at - submitted_at)))::numeric,
         'seconds'
    from o where accepted_at is not null
  union all
  select 'median_customer_pay_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (p.succeeded_at - o.accepted_at)))::numeric,
         'seconds'
    from o join public.payments p on p.order_id = o.id and p.status = 'SUCCEEDED'
   where o.accepted_at is not null
  union all
  select 'median_prep_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (ready_at - preparing_at)))::numeric,
         'seconds'
    from o where ready_at is not null and preparing_at is not null
  union all
  select 'median_partner_match_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (assigned_at - search_started_at)))::numeric,
         'seconds'
    from o where assigned_at is not null and search_started_at is not null
  union all
  select 'median_delivery_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (delivered_at - picked_up_at)))::numeric,
         'seconds'
    from o where delivered_at is not null and picked_up_at is not null

  -- Delivery health
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
           where e.event = 'PARTNER_CANCEL' and e.accepted
             and e.created_at >= bounds.since)::numeric,
         'events'
  union all
  select 'disputes_open',
         count(*) filter (where disputed_at is not null and dispute_resolved_at is null)::numeric,
         'orders' from o

  -- Partner supply, right now rather than over the period
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

  -- Money
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

  -- Notifications
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
$$;

revoke execute on function public.admin_pilot_metrics(timestamptz) from public, anon;
grant execute on function public.admin_pilot_metrics(timestamptz) to authenticated;
