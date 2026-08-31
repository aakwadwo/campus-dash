-- ============================================================================
-- Admin operations: the order board, money views, and reconciliation
-- ============================================================================

-- Where an order is stuck, in one word. Sorted by how much it needs a human.
create or replace function public.admin_order_board(
  p_filter text default null,
  p_limit  integer default 100
)
returns table (
  order_id        uuid,
  order_number    text,
  vendor_name     text,
  customer_name   text,
  partner_name    text,
  order_status    public.order_status,
  payment_status  public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  total_pesewas   bigint,
  attention       text,
  age_seconds     integer,
  disputed        boolean,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with scored as (
    select o.*,
           v.name as vendor_name,
           c.full_name as customer_name,
           p.full_name as partner_name,
           case
             when o.disputed_at is not null and o.dispute_resolved_at is null then 'DISPUTED'
             when o.delivery_status = 'FAILED_CUSTOMER_ABSENT'                then 'CUSTOMER_ABSENT'
             when o.delivery_status = 'FAILED_NO_PARTNER'                     then 'NO_PARTNER'
             when o.payment_status = 'REFUND_PENDING'                         then 'REFUND_PENDING'
             when o.payment_status = 'FAILED'                                 then 'PAYMENT_FAILED'
             when o.order_status = 'SUBMITTED'                                then 'AWAITING_VENDOR'
             when o.order_status = 'ACCEPTED' and o.payment_status <> 'PAID'  then 'AWAITING_PAYMENT'
             when o.delivery_status = 'SEARCHING'                             then 'SEARCHING_PARTNER'
             when o.order_status in ('PREPARING', 'READY')                    then 'IN_PROGRESS'
             when o.delivery_status in ('ASSIGNED', 'PICKED_UP')              then 'IN_PROGRESS'
             when o.order_status = 'COMPLETED'                                then 'DONE'
             else 'CLOSED'
           end as attention
      from public.orders o
      join public.vendors v on v.id = o.vendor_id
      join public.users c on c.id = o.customer_id
      left join public.users p on p.id = o.partner_id
     where public.is_admin() and o.order_status <> 'DRAFT'
  )
  select s.id, s.order_number, s.vendor_name, s.customer_name, s.partner_name,
         s.order_status, s.payment_status, s.delivery_status, s.fulfilment_type,
         s.total_pesewas, s.attention,
         extract(epoch from (now() - s.created_at))::integer,
         s.disputed_at is not null and s.dispute_resolved_at is null,
         s.created_at
    from scored s
   where p_filter is null or s.attention = p_filter
   order by
     -- Problems first, then work in flight, then the settled past.
     case s.attention
       when 'DISPUTED'          then 0
       when 'CUSTOMER_ABSENT'   then 1
       when 'NO_PARTNER'        then 2
       when 'REFUND_PENDING'    then 3
       when 'PAYMENT_FAILED'    then 4
       when 'AWAITING_VENDOR'   then 5
       when 'AWAITING_PAYMENT'  then 6
       when 'SEARCHING_PARTNER' then 7
       when 'IN_PROGRESS'       then 8
       else 9
     end,
     -- Oldest first within a problem: it has been broken longest.
     s.created_at asc
   limit least(coalesce(p_limit, 100), 500);
$$;

-- Counts per bucket, for the dashboard.
create or replace function public.admin_order_board_summary()
returns table (attention text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.attention, count(*)
    from public.admin_order_board(null, 500) b
   group by b.attention
   order by count(*) desc;
$$;

-- ---------------------------------------------------------------------------
-- Money: one row per order, everything about it
-- ---------------------------------------------------------------------------
-- The reconciliation question is always the same: what did the customer pay,
-- where did we say it goes, and has it left yet?
create or replace function public.admin_order_money(p_order_id uuid)
returns table (
  order_id             uuid,
  order_number         text,
  total_pesewas        bigint,
  payment_status       public.payment_status,
  payment_id           uuid,
  payment_provider     text,
  payment_txn_status   public.payment_txn_status,
  provider_transaction_id text,
  paid_pesewas         bigint,
  vendor_name          text,
  vendor_allocation    bigint,
  platform_allocation  bigint,
  partner_name         text,
  partner_allocation   bigint,
  allocated_pesewas    bigint,
  balances             boolean,
  allocations          jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.total_pesewas,
         o.payment_status,
         pay.id,
         pay.provider,
         pay.status,
         pay.provider_transaction_id,
         coalesce(pay.amount_pesewas, 0),
         v.name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'VENDOR'
                      and a.status <> 'CANCELLED'), 0),
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PLATFORM'
                      and a.status <> 'CANCELLED'), 0),
         pu.full_name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PARTNER'
                      and a.status <> 'CANCELLED'), 0),
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0)::bigint,
         -- The invariant, stated where an admin can see it fail.
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0) = o.total_pesewas
           or not exists (select 1 from public.allocations a where a.order_id = o.id),
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'payee_type', a.payee_type,
                     'amount_pesewas', a.amount_pesewas,
                     'status', a.status,
                     'settlement_run_id', a.settlement_run_id,
                     'settled_at', a.settled_at
                   ) order by a.payee_type)
              from public.allocations a where a.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join lateral (
      select p.* from public.payments p
       where p.order_id = o.id
       order by case p.status when 'SUCCEEDED' then 0 else 1 end, p.created_at desc
       limit 1
    ) pay on true
   where public.is_admin() and o.id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- Reconciliation
-- ---------------------------------------------------------------------------
-- Only the discrepancies. A list of everything that is fine is not a
-- reconciliation report, it is a distraction.
create or replace function public.admin_reconciliation(p_limit integer default 200)
returns table (
  order_id      uuid,
  order_number  text,
  issue         text,
  detail        text,
  total_pesewas bigint,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with paid as (
    select o.* from public.orders o where public.is_admin() and o.payment_status = 'PAID'
  ),
  problems as (
    -- Paid, but nothing was allocated.
    select p.id, p.order_number, 'NO_ALLOCATIONS'::text as issue,
           'order is PAID but has no allocations'::text as detail,
           p.total_pesewas, p.created_at
      from paid p
     where not exists (select 1 from public.allocations a where a.order_id = p.id)

    union all

    -- Allocated, but the parts do not add up to the whole.
    select p.id, p.order_number, 'ALLOCATION_MISMATCH',
           format('allocations sum to %s but the order total is %s',
                  (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
                    where a.order_id = p.id and a.status <> 'CANCELLED'),
                  p.total_pesewas),
           p.total_pesewas, p.created_at
      from paid p
     where exists (select 1 from public.allocations a where a.order_id = p.id)
       and (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
             where a.order_id = p.id and a.status <> 'CANCELLED') <> p.total_pesewas

    union all

    -- Our record says PAID; the provider record does not say SUCCEEDED.
    select p.id, p.order_number, 'PROVIDER_MISMATCH',
           'order is PAID but no succeeded payment row exists',
           p.total_pesewas, p.created_at
      from paid p
     where not exists (
       select 1 from public.payments pay
        where pay.order_id = p.id and pay.status = 'SUCCEEDED'
     )

    union all

    -- The provider took a different amount from the one we asked for.
    select p.id, p.order_number, 'AMOUNT_MISMATCH',
           format('payment captured %s but the order total is %s',
                  pay.amount_pesewas, p.total_pesewas),
           p.total_pesewas, p.created_at
      from paid p
      join public.payments pay on pay.order_id = p.id and pay.status = 'SUCCEEDED'
     where pay.amount_pesewas <> p.total_pesewas

    union all

    -- Delivered, but the Partner was never allocated anything.
    select o.id, o.order_number, 'PARTNER_UNPAID',
           'delivery completed but no Partner allocation exists',
           o.total_pesewas, o.created_at
      from public.orders o
     where public.is_admin()
       and o.delivery_status in ('DELIVERED', 'FAILED_CUSTOMER_ABSENT')
       and o.partner_earnings_pesewas > 0
       and not exists (
         select 1 from public.allocations a
          where a.order_id = o.id and a.payee_type = 'PARTNER'
       )
  )
  select * from problems order by created_at desc limit least(coalesce(p_limit, 200), 500);
$$;

-- ---------------------------------------------------------------------------
-- Settlement views
-- ---------------------------------------------------------------------------
-- What is owed, and to whom, right now.
create or replace function public.admin_pending_settlement(p_payee_type public.payee_type)
returns table (
  payee_id      uuid,
  payee_name    text,
  order_count   bigint,
  owed_pesewas  bigint,
  oldest_at     timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.payee_id,
         case p_payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = a.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = a.payee_id)
           else 'Campus Dash'
         end,
         count(*),
         sum(a.amount_pesewas)::bigint,
         min(o.created_at)
    from public.allocations a
    join public.orders o on o.id = a.order_id
   where public.is_admin()
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
   group by a.payee_id
   order by sum(a.amount_pesewas) desc;
$$;

create or replace function public.admin_settlement_runs(p_limit integer default 50)
returns table (
  run_id        uuid,
  payee_type    public.payee_type,
  period_start  timestamptz,
  period_end    timestamptz,
  status        public.settlement_run_status,
  total_pesewas bigint,
  payout_count  bigint,
  paid_count    bigint,
  failed_count  bigint,
  created_at    timestamptz,
  completed_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.payee_type, r.period_start, r.period_end, r.status, r.total_pesewas,
         (select count(*) from public.payouts p where p.settlement_run_id = r.id),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'PAID'),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'FAILED'),
         r.created_at, r.completed_at
    from public.settlement_runs r
   where public.is_admin()
   order by r.created_at desc
   limit least(coalesce(p_limit, 50), 200);
$$;

create or replace function public.admin_settlement_payouts(p_run_id uuid)
returns table (
  payout_id            uuid,
  payee_type           public.payee_type,
  payee_id             uuid,
  payee_name           text,
  amount_pesewas       bigint,
  status               public.payout_status,
  provider             text,
  provider_transfer_id text,
  failure_reason       text,
  paid_at              timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.payee_type, p.payee_id,
         case p.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           else 'Campus Dash'
         end,
         p.amount_pesewas, p.status, p.provider, p.provider_transfer_id,
         p.failure_reason, p.paid_at
    from public.payouts p
   where public.is_admin() and p.settlement_run_id = p_run_id
   order by p.amount_pesewas desc;
$$;

-- What a vendor sees about their own money. Earned, awaiting, settled — never
-- a "balance", because Campus Dash is not holding their money.
create or replace function public.vendor_earnings_summary(p_vendor_id uuid)
returns table (
  order_count      bigint,
  earned_pesewas   bigint,
  awaiting_pesewas bigint,
  settled_pesewas  bigint,
  today_pesewas    bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*),
         coalesce(sum(a.amount_pesewas), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status <> 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where o.created_at >= date_trunc('day', now())), 0)::bigint
    from public.allocations a
    join public.orders o on o.id = a.order_id
   where a.payee_type = 'VENDOR'
     and a.payee_id = p_vendor_id
     and a.status <> 'CANCELLED'
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin());
$$;

-- ---------------------------------------------------------------------------
-- Payments and webhooks, for the admin money screens
-- ---------------------------------------------------------------------------
create or replace function public.admin_payments(p_limit integer default 100)
returns table (
  payment_id           uuid,
  order_id             uuid,
  order_number         text,
  provider             text,
  provider_transaction_id text,
  amount_pesewas       bigint,
  status               public.payment_txn_status,
  failure_reason       text,
  created_at           timestamptz,
  succeeded_at         timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.order_id, o.order_number, p.provider, p.provider_transaction_id,
         p.amount_pesewas, p.status, p.failure_reason, p.created_at, p.succeeded_at
    from public.payments p
    join public.orders o on o.id = p.order_id
   where public.is_admin()
   order by p.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

create or replace function public.admin_webhook_events(p_limit integer default 100)
returns table (
  webhook_id   uuid,
  provider     text,
  event_id     text,
  status       public.webhook_event_status,
  signature_valid boolean,
  error        text,
  received_at  timestamptz,
  processed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.provider, w.event_id, w.status, w.signature_valid, w.error,
         w.received_at, w.processed_at
    from public.webhook_events w
   where public.is_admin()
   order by w.received_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'admin_order_board(text, integer)',
    'admin_order_board_summary()',
    'admin_order_money(uuid)',
    'admin_reconciliation(integer)',
    'admin_pending_settlement(public.payee_type)',
    'admin_settlement_runs(integer)',
    'admin_settlement_payouts(uuid)',
    'admin_payments(integer)',
    'admin_webhook_events(integer)',
    'vendor_earnings_summary(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', v_fn);
    execute format('grant execute on function public.%s to authenticated', v_fn);
  end loop;
end;
$$;
