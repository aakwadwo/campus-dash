-- ============================================================================
-- The Admin Operating System — read models for running the business
-- ============================================================================
-- Everything an administrator needs in order to answer three questions without
-- opening a SQL client:
--
--   WHAT IS HAPPENING?   orders, by type and by what is wrong with them
--   WHERE IS THE MONEY?  every cedi, from the customer to the three payees
--   WHO NEEDS ME?        the exceptions queue — things a person must decide
--
-- NOTHING HERE IS A NEW MECHANISM. Every write an admin performs still goes
-- through the admin_* functions that already existed; this migration adds READ
-- models and one taxonomy extension. There is no new table, no new payment
-- path, no new ledger, and no way to reach data that RLS or a SECURITY DEFINER
-- check would not already have allowed.
--
-- THE ONE BEHAVIOURAL CHANGE is that `attention` gains SCAN_REFUSED. A scan the
-- restaurant would not honour is a state that needs a human, and until now the
-- board classified such an order as IN_PROGRESS — which is exactly wrong, since
-- nothing is in progress and nobody is coming.
--
-- ON PAYSTACK FEES. They appear nowhere below, deliberately. The schema records
-- the gross collected and has no fee column, so a processing fee cannot be
-- deducted from a vendor's or a Partner's entitlement — it lands on the
-- platform's share because that is the only place left. The finance views say
-- so in words rather than inventing a number we do not have.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The order board, with the filters an operator actually needs
-- ---------------------------------------------------------------------------
-- Extends the existing board rather than adding a second one: same `attention`
-- classification, same ordering, same "problems first" intent. What is new is
-- the ability to narrow by type, state, vendor, assignment, date and order
-- number, and to see order_type/scan_status without opening each order.
--
-- DROPped and recreated because the result columns change. The summary depends
-- on it, so that goes first and comes back below. Grants are restored at the
-- bottom of this file — dropping a function discards its REVOKE and hands
-- EXECUTE back to PUBLIC.

drop function if exists public.admin_order_board_summary();
drop function if exists public.admin_order_board(text, integer);

create or replace function public.admin_order_board(
  p_filter          text    default null,
  p_limit           integer default 100,
  p_order_type      text    default null,
  p_order_status    text    default null,
  p_payment_status  text    default null,
  p_partner_state   text    default null,  -- 'ASSIGNED' | 'UNASSIGNED'
  p_vendor_id       uuid    default null,
  p_since           timestamptz default null,
  p_until           timestamptz default null,
  p_search          text    default null   -- order number, or customer name
)
returns table (
  order_id        uuid,
  order_number    text,
  order_type      public.order_type,
  vendor_name     text,
  customer_name   text,
  partner_name    text,
  order_status    public.order_status,
  payment_status  public.payment_status,
  delivery_status public.delivery_status,
  scan_status     public.scan_status,
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
             -- NEW. A refused scan is not "in progress": the Partner is standing
             -- at a counter that will not serve them, and only a person can
             -- decide what happens to the money.
             when o.order_type = 'SCAN' and o.scan_status = 'REFUSED'          then 'SCAN_REFUSED'
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
  select s.id, s.order_number, s.order_type, s.vendor_name, s.customer_name, s.partner_name,
         s.order_status, s.payment_status, s.delivery_status, s.scan_status, s.fulfilment_type,
         s.total_pesewas, s.attention,
         extract(epoch from (now() - s.created_at))::integer,
         s.disputed_at is not null and s.dispute_resolved_at is null,
         s.created_at
    from scored s
   where (p_filter is null         or s.attention = p_filter)
     and (p_order_type is null     or s.order_type::text = p_order_type)
     and (p_order_status is null   or s.order_status::text = p_order_status)
     and (p_payment_status is null or s.payment_status::text = p_payment_status)
     and (p_partner_state is null
          or (p_partner_state = 'ASSIGNED'   and s.partner_id is not null)
          or (p_partner_state = 'UNASSIGNED' and s.partner_id is null))
     and (p_vendor_id is null      or s.vendor_id = p_vendor_id)
     and (p_since is null          or s.created_at >= p_since)
     and (p_until is null          or s.created_at <  p_until)
     -- Order number is exact-ish; the customer name is a contains match. Both
     -- are already visible to an admin on this very board, so searching them
     -- reveals nothing new.
     and (p_search is null or btrim(p_search) = ''
          or s.order_number ilike '%' || btrim(p_search) || '%'
          or s.customer_name ilike '%' || btrim(p_search) || '%')
   order by
     case s.attention
       when 'DISPUTED'          then 0
       when 'SCAN_REFUSED'      then 1
       when 'CUSTOMER_ABSENT'   then 2
       when 'NO_PARTNER'        then 3
       when 'REFUND_PENDING'    then 4
       when 'PAYMENT_FAILED'    then 5
       when 'AWAITING_VENDOR'   then 6
       when 'AWAITING_PAYMENT'  then 7
       when 'SEARCHING_PARTNER' then 8
       when 'IN_PROGRESS'       then 9
       else 10
     end,
     s.created_at asc
   limit least(coalesce(p_limit, 100), 500);
$$;

create or replace function public.admin_order_board_summary()
returns table (attention text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.attention, count(*)
    from public.admin_order_board(null, 500) b
   where public.is_admin()
   group by b.attention
   order by count(*) desc;
$$;


-- ---------------------------------------------------------------------------
-- 2. The dashboard
-- ---------------------------------------------------------------------------
-- One round trip, one jsonb document, four sections. Returned as jsonb rather
-- than forty columns because the shape is a report, not a row — and because a
-- caller adding a tile should not require a signature change.
--
-- EVERY NUMBER IS COUNTED, never estimated. An empty pilot reports zeros, and
-- zero is a true answer.

create or replace function public.admin_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when not public.is_admin() then null else jsonb_build_object(

    'operations', jsonb_build_object(
      'orders_today', (select count(*) from public.orders
                        where order_status <> 'DRAFT' and created_at >= date_trunc('day', now())),
      'active_food',  (select count(*) from public.orders
                        where order_type = 'FOOD' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'active_scan',  (select count(*) from public.orders
                        where order_type = 'SCAN' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'searching',    (select count(*) from public.orders where delivery_status = 'SEARCHING'),
      'assigned',     (select count(*) from public.orders where delivery_status in ('ASSIGNED','PICKED_UP')),
      'no_partner',   (select count(*) from public.orders where delivery_status = 'FAILED_NO_PARTNER'),
      'scan_refused', (select count(*) from public.orders
                        where order_type = 'SCAN' and scan_status = 'REFUSED'),
      'needs_attention', (select count(*) from public.admin_order_board(null, 500) b
                           where b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','NO_PARTNER',
                                                 'REFUND_PENDING','PAYMENT_FAILED'))
    ),

    'money', jsonb_build_object(
      -- What customers have actually paid us, gross.
      'collected_pesewas', (select coalesce(sum(amount_pesewas),0) from public.payments where status = 'SUCCEEDED'),
      'payments_count',    (select count(*) from public.payments where status = 'SUCCEEDED'),
      -- What we owe, by payee, excluding anything already settled or cancelled.
      'vendor_owed',   (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'VENDOR'  and status in ('PENDING','ELIGIBLE')),
      'partner_owed',  (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'PARTNER' and status in ('PENDING','ELIGIBLE')),
      -- The platform's share is revenue, not a liability, so it is reported
      -- separately and never mixed into "owed".
      'platform_earned', (select coalesce(sum(amount_pesewas),0) from public.allocations
                           where payee_type = 'PLATFORM' and status <> 'CANCELLED'),
      'payouts_pending',    (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PENDING'),
      'payouts_processing', (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PROCESSING'),
      'payouts_failed',     (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'FAILED'),
      'payouts_paid',       (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PAID'),
      'refunded_pesewas',   (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUNDED'),
      'refund_pending_pesewas', (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUND_PENDING')
    ),

    'people', jsonb_build_object(
      'customers',        (select count(*) from public.customer_profiles),
      'partners',         (select count(*) from public.partner_profiles where status = 'APPROVED'),
      'partners_pending', (select count(*) from public.partner_profiles where status = 'PENDING_REVIEW'),
      'partners_online',  (select count(*) from public.partner_profiles where status = 'APPROVED' and is_available),
      'vendors',          (select count(*) from public.vendors),
      'vendors_active',   (select count(*) from public.vendors where status = 'ACTIVE'),
      'vendors_scan',     (select count(*) from public.vendors where can_accept_scans),
      'suspended',        (select count(*) from public.users where is_suspended)
    ),

    'system', jsonb_build_object(
      'webhooks_24h',        (select count(*) from public.webhook_events where received_at >= now() - interval '24 hours'),
      'webhooks_invalid_24h',(select count(*) from public.webhook_events
                               where received_at >= now() - interval '24 hours' and not signature_valid),
      'notifications_24h',   (select count(*) from public.notification_events where created_at >= now() - interval '24 hours'),
      'notifications_failed_24h', (select count(*) from public.notification_events
                                    where created_at >= now() - interval '24 hours' and not succeeded),
      'admin_actions_24h',   (select count(*) from public.admin_actions where created_at >= now() - interval '24 hours'),
      'scan_fee_configured', (select scan_service_fee_pesewas is not null from public.pricing_config where id)
    )
  ) end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Customers
-- ---------------------------------------------------------------------------
-- There was no customer screen at all, which meant looking a student up meant
-- opening a SQL client. It returns the identity an operator needs to recognise
-- a person and nothing they do not: the student ID IMAGE PATH is never
-- selected, only whether one exists.

create or replace function public.admin_customers(
  p_search text    default null,
  p_limit  integer default 100
)
returns table (
  user_id           uuid,
  full_name         text,
  phone             text,
  email             text,
  student_id_number text,
  class_year        text,
  is_suspended      boolean,
  is_admin          boolean,
  partner_status    text,
  order_count       bigint,
  last_order_at     timestamptz,
  onboarded_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.class_year,
         u.is_suspended, u.is_admin,
         coalesce(p.status::text, 'NOT_APPLIED'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select max(o.created_at) from public.orders o where o.customer_id = u.id),
         c.onboarded_at
    from public.customer_profiles c
    join public.users u on u.id = c.user_id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin()
     and (p_search is null or btrim(p_search) = ''
          or u.full_name ilike '%' || btrim(p_search) || '%'
          or u.phone ilike '%' || btrim(p_search) || '%'
          or coalesce(u.email,'') ilike '%' || btrim(p_search) || '%'
          or c.student_id_number ilike '%' || btrim(p_search) || '%')
   order by c.onboarded_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;

-- One customer, with enough history to answer a support question.
--
-- has_student_id reports EXISTENCE. The path is deliberately not returned:
-- looking at somebody's ID should be a deliberate second step through the
-- existing signed-URL mechanism, not a side effect of opening their record.
create or replace function public.admin_customer_detail(p_user_id uuid)
returns table (
  user_id           uuid,
  full_name         text,
  phone             text,
  email             text,
  student_id_number text,
  class_year        text,
  has_student_id    boolean,
  is_suspended      boolean,
  is_admin          boolean,
  onboarded_at      timestamptz,
  created_at        timestamptz,
  partner_status    text,
  partner_applied_at timestamptz,
  vendor_names      text[],
  order_count       bigint,
  completed_count   bigint,
  spent_pesewas     bigint,
  recent_orders     jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.class_year,
         c.student_id_image_path is not null,
         u.is_suspended, u.is_admin, c.onboarded_at, u.created_at,
         coalesce(p.status::text, 'NOT_APPLIED'), p.applied_at,
         coalesce((select array_agg(v.name order by v.name)
                     from public.vendor_users vu
                     join public.vendors v on v.id = vu.vendor_id
                    where vu.user_id = u.id), '{}'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select coalesce(sum(pay.amount_pesewas),0)::bigint
            from public.payments pay
            join public.orders o on o.id = pay.order_id
           where o.customer_id = u.id and pay.status = 'SUCCEEDED'),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'order_status', o.order_status,
                     'payment_status', o.payment_status, 'delivery_status', o.delivery_status,
                     'total_pesewas', o.total_pesewas, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2
                    where o2.customer_id = u.id and o2.order_status <> 'DRAFT'
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.customer_profiles c on c.user_id = u.id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin() and u.id = p_user_id;
$$;


-- ---------------------------------------------------------------------------
-- 4. Partner detail
-- ---------------------------------------------------------------------------
-- The application queue already exists (admin_list_partner_applications). This
-- is the other half: what a Partner has actually DONE. Document paths are not
-- returned here either.

create or replace function public.admin_partner_detail(p_user_id uuid)
returns table (
  user_id            uuid,
  full_name          text,
  phone              text,
  email              text,
  student_id_number  text,
  class_year         text,
  status             public.partner_application_status,
  is_available       boolean,
  is_suspended       boolean,
  applied_at         timestamptz,
  reviewed_at        timestamptz,
  reviewed_by_name   text,
  review_notes       text,
  has_face_image     boolean,
  has_student_id     boolean,
  deliveries_completed bigint,
  deliveries_failed  bigint,
  earned_pesewas     bigint,
  owed_pesewas       bigint,
  paid_pesewas       bigint,
  active_order_id    uuid,
  active_order_number text,
  recent_deliveries  jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.class_year,
         p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.face_image_path is not null,
         c.student_id_image_path is not null,
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('FAILED_CUSTOMER_ABSENT','FAILED_NO_PARTNER')),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status <> 'CANCELLED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE')),
         (select coalesce(sum(po.amount_pesewas),0)::bigint from public.payouts po
           where po.payee_type = 'PARTNER' and po.payee_id = u.id and po.status = 'PAID'),
         (select o.id from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP') limit 1),
         (select o.order_number from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP') limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'delivery_status', o.delivery_status,
                     'earnings_pesewas', o.partner_earnings_pesewas,
                     'delivered_at', o.delivered_at, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2 where o2.partner_id = u.id
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.partner_profiles p on p.user_id = u.id
    left join public.customer_profiles c on c.user_id = u.id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin() and u.id = p_user_id;
$$;

-- Everyone who holds the Partner capability, not just those awaiting review.
create or replace function public.admin_partners(p_status text default null)
returns table (
  user_id     uuid,
  full_name   text,
  phone       text,
  class_year  text,
  status      public.partner_application_status,
  is_available boolean,
  is_suspended boolean,
  applied_at  timestamptz,
  reviewed_at timestamptz,
  deliveries  bigint,
  owed_pesewas bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, c.class_year, p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at,
         (select count(*) from public.orders o where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE'))
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.customer_profiles c on c.user_id = u.id
   where public.is_admin()
     and (p_status is null or p.status::text = p_status)
   order by
     case p.status when 'PENDING_REVIEW' then 0 when 'APPROVED' then 1 else 2 end,
     p.applied_at desc nulls last;
$$;


-- ---------------------------------------------------------------------------
-- 5. The ledger — where every cedi is
-- ---------------------------------------------------------------------------
-- One row per allocation, joined to the order that produced it and the payout
-- that settled it. This is the screen that answers "who is owed what, and has
-- it moved yet", and it is derived entirely from the existing allocations and
-- payouts tables — no shadow accounting.

create or replace function public.admin_ledger(
  p_order_type       text default null,
  p_payee_type       text default null,
  p_allocation_status text default null,
  p_payout_status    text default null,
  p_vendor_id        uuid default null,
  p_payee_id         uuid default null,
  p_since            timestamptz default null,
  p_until            timestamptz default null,
  p_limit            integer default 200
)
returns table (
  allocation_id    uuid,
  order_id         uuid,
  order_number     text,
  order_type       public.order_type,
  order_created_at timestamptz,
  vendor_name      text,
  payee_type       public.payee_type,
  payee_id         uuid,
  payee_name       text,
  amount_pesewas   bigint,
  allocation_status public.allocation_status,
  settled_at       timestamptz,
  settlement_run_id uuid,
  payout_id        uuid,
  payout_status    public.payout_status,
  order_total_pesewas bigint,
  order_subtotal_pesewas bigint,
  order_service_fee_pesewas bigint,
  order_delivery_fee_pesewas bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, o.id, o.order_number, o.order_type, o.created_at,
         v.name,
         a.payee_type, a.payee_id,
         case a.payee_type
           when 'PLATFORM' then 'Campus Dash'
           when 'VENDOR'   then vp.name
           else pu.full_name
         end,
         a.amount_pesewas, a.status, a.settled_at, a.settlement_run_id,
         po.id, po.status,
         o.total_pesewas, o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas
    from public.allocations a
    join public.orders o on o.id = a.order_id
    join public.vendors v on v.id = o.vendor_id
    left join public.vendors vp on vp.id = a.payee_id and a.payee_type = 'VENDOR'
    left join public.users pu on pu.id = a.payee_id and a.payee_type = 'PARTNER'
    left join public.payouts po on po.settlement_run_id = a.settlement_run_id
                               and po.payee_type = a.payee_type
                               and po.payee_id is not distinct from a.payee_id
   where public.is_admin()
     and (p_order_type is null        or o.order_type::text = p_order_type)
     and (p_payee_type is null        or a.payee_type::text = p_payee_type)
     and (p_allocation_status is null or a.status::text = p_allocation_status)
     and (p_payout_status is null     or po.status::text = p_payout_status)
     and (p_vendor_id is null         or o.vendor_id = p_vendor_id)
     and (p_payee_id is null          or a.payee_id = p_payee_id)
     and (p_since is null             or o.created_at >= p_since)
     and (p_until is null             or o.created_at <  p_until)
   order by o.created_at desc, a.payee_type
   limit least(coalesce(p_limit, 200), 1000);
$$;

-- The totals behind the ledger, so the finance page can state the position
-- without paging through every row.
create or replace function public.admin_ledger_totals(
  p_order_type text default null,
  p_since      timestamptz default null,
  p_until      timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- GROSS IS SUMMED OVER DISTINCT ORDERS, not over allocation rows. An order
  -- with three payees would otherwise contribute its total three times and the
  -- finance page would report revenue that does not exist.
  with rows as (
    select a.amount_pesewas, a.payee_type, o.id as order_id, o.total_pesewas
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.status <> 'CANCELLED'
       and (p_order_type is null or o.order_type::text = p_order_type)
       and (p_since is null or o.created_at >= p_since)
       and (p_until is null or o.created_at <  p_until)
  ),
  orders_once as (select distinct order_id, total_pesewas from rows)
  select case when not public.is_admin() then null else jsonb_build_object(
    'orders',            (select count(*) from orders_once),
    'gross_pesewas',     (select coalesce(sum(total_pesewas),0)::bigint from orders_once),
    'vendor_pesewas',    (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'VENDOR'),
    'partner_pesewas',   (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'PARTNER'),
    'platform_pesewas',  (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'PLATFORM'),
    'allocated_pesewas', (select coalesce(sum(amount_pesewas),0)::bigint from rows)
  ) end;
$$;


-- ---------------------------------------------------------------------------
-- 6. The exceptions queue
-- ---------------------------------------------------------------------------
-- Everything waiting on a human, in one list, from four different sources.
--
-- `requires_decision` is the important column. Where Campus Dash has no policy
-- — a refused scan, most obviously — the row says so instead of implying the
-- system knows what should happen to the money. Nothing here resolves itself
-- and nothing here moves a cedi.

create or replace function public.admin_exceptions(p_limit integer default 200)
returns table (
  kind         text,
  order_id     uuid,
  order_number text,
  order_type   public.order_type,
  subject      text,
  detail       text,
  amount_pesewas bigint,
  requires_decision boolean,
  since        timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Orders whose classification is already a problem.
  select b.attention,
         b.order_id, b.order_number, b.order_type,
         b.customer_name,
         case b.attention
           when 'DISPUTED'        then 'The customer disputes this delivery.'
           when 'SCAN_REFUSED'    then 'The restaurant would not honour the scan. No refund policy exists — decide.'
           when 'CUSTOMER_ABSENT' then 'The Partner could not hand the order over.'
           when 'NO_PARTNER'      then 'Nobody accepted the delivery before the search expired.'
           when 'REFUND_PENDING'  then 'A refund has been marked pending and needs completing at the provider.'
           when 'PAYMENT_FAILED'  then 'The payment failed.'
           else b.attention
         end,
         b.total_pesewas,
         -- These four have no automatic resolution anywhere in the system.
         b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','REFUND_PENDING'),
         b.created_at
    from public.admin_order_board(null, 500) b
   where public.is_admin()
     and b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','NO_PARTNER',
                         'REFUND_PENDING','PAYMENT_FAILED')

  union all

  -- Money that tried to leave and did not.
  select 'FAILED_PAYOUT',
         null::uuid, null::text, null::public.order_type,
         coalesce(v.name, u.full_name, 'unknown payee'),
         'Payout failed: ' || coalesce(po.failure_reason, 'no reason recorded') ||
           '. Retry only when the cause is understood.',
         po.amount_pesewas,
         true,
         po.created_at
    from public.payouts po
    left join public.vendors v on v.id = po.payee_id and po.payee_type = 'VENDOR'
    left join public.users u on u.id = po.payee_id and po.payee_type = 'PARTNER'
   where public.is_admin() and po.status = 'FAILED'

  union all

  -- Anything the ledger itself cannot explain.
  select 'RECONCILIATION',
         r.order_id, r.order_number, null::public.order_type,
         r.issue, r.detail, r.total_pesewas, true, r.created_at
    from public.admin_reconciliation(200) r
   where public.is_admin()

  -- Ordinal, not a name: across a UNION the output columns take their names
  -- from the first branch's expressions, not from the RETURNS TABLE list.
  -- Oldest first — the thing that has been broken longest is the thing that
  -- has been costing somebody the longest.
  order by 9 asc
  limit least(coalesce(p_limit, 200), 500);
$$;


-- ---------------------------------------------------------------------------
-- 7. Vendor list with the operational facts on it
-- ---------------------------------------------------------------------------

create or replace function public.admin_vendors()
returns table (
  vendor_id        uuid,
  name             text,
  phone            text,
  status           public.vendor_status,
  is_accepting_orders boolean,
  can_accept_scans boolean,
  location_path    text,
  staff_count      bigint,
  menu_count       bigint,
  order_count      bigint,
  owed_pesewas     bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.phone, v.status, v.is_accepting_orders, v.can_accept_scans,
         public.location_path(v.location_id),
         (select count(*) from public.vendor_users vu where vu.vendor_id = v.id),
         (select count(*) from public.menu_items m where m.vendor_id = v.id),
         (select count(*) from public.orders o where o.vendor_id = v.id and o.order_status <> 'DRAFT'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'VENDOR' and a.payee_id = v.id and a.status in ('PENDING','ELIGIBLE'))
    from public.vendors v
   where public.is_admin()
   order by v.name;
$$;


-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
-- authenticated only, never anon. Each function re-checks is_admin() itself, so
-- the grant is reachability and the check is authorisation — a non-admin who
-- calls one of these gets an empty result or null, never data.
--
-- The two DROPped functions are re-granted here for the reason that has now
-- bitten this project twice: DROP discards the REVOKE and CREATE returns
-- EXECUTE to PUBLIC.

revoke execute on function public.admin_order_board(text, integer, text, text, text, text, uuid, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.admin_order_board(text, integer, text, text, text, text, uuid, timestamptz, timestamptz, text) to authenticated;

revoke execute on function public.admin_order_board_summary() from public, anon;
grant  execute on function public.admin_order_board_summary() to authenticated;

revoke execute on function public.admin_dashboard() from public, anon;
grant  execute on function public.admin_dashboard() to authenticated;

revoke execute on function public.admin_customers(text, integer) from public, anon;
grant  execute on function public.admin_customers(text, integer) to authenticated;

revoke execute on function public.admin_customer_detail(uuid) from public, anon;
grant  execute on function public.admin_customer_detail(uuid) to authenticated;

revoke execute on function public.admin_partner_detail(uuid) from public, anon;
grant  execute on function public.admin_partner_detail(uuid) to authenticated;

revoke execute on function public.admin_partners(text) from public, anon;
grant  execute on function public.admin_partners(text) to authenticated;

revoke execute on function public.admin_ledger(text, text, text, text, uuid, uuid, timestamptz, timestamptz, integer) from public, anon;
grant  execute on function public.admin_ledger(text, text, text, text, uuid, uuid, timestamptz, timestamptz, integer) to authenticated;

revoke execute on function public.admin_ledger_totals(text, timestamptz, timestamptz) from public, anon;
grant  execute on function public.admin_ledger_totals(text, timestamptz, timestamptz) to authenticated;

revoke execute on function public.admin_exceptions(integer) from public, anon;
grant  execute on function public.admin_exceptions(integer) to authenticated;

revoke execute on function public.admin_vendors() from public, anon;
grant  execute on function public.admin_vendors() to authenticated;
