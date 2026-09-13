-- A vendor sees their own amount, and nothing else about the money.
--
-- WHAT WAS WRONG. vendor_order_board() returned the order's total_pesewas and
-- vendor_order_detail() returned the subtotal, the service fee, the delivery fee
-- and the total. The screens printed all of it, under "Customer paid", and the
-- board handed the rows to a client component, so the figures sat in the page
-- payload even where they were not drawn. None of it is the store's business:
-- the service fee is Campus Dash's, the delivery fee is the Partner's, and what
-- the customer paid in total is the sum of both with the food.
--
-- WHAT A VENDOR IS SHOWN INSTEAD is vendor_amount_pesewas: the food subtotal,
-- which is exactly the VENDOR allocation settle_order_payment() writes and the
-- amount the Paystack split routes to their subaccount. Nothing is recomputed
-- here; the column is read, and read under a name that says whose it is.
--
-- The narrowing is in SQL rather than only in the page because the functions
-- are callable with the vendor's own session. A figure hidden by a component is
-- a figure one devtools request away.
--
-- TWO NEW READS, both over the ledger that already exists:
--
--   vendor_daily_sales()    one row per day: orders and the vendor's amount.
--   vendor_orders_on_day()  the orders behind one of those rows.
--
-- A day is orders.order_day, the same calendar day the queue number restarts
-- on, so "Today · 12 orders" and the 001…012 on the counter agree.
--
-- An order counts when it has a live VENDOR allocation, which is to say it was
-- paid for and has not been refunded. That is the definition of a sale the
-- settlement ledger already uses, rather than a second one invented for a
-- dashboard.

drop function if exists public.vendor_order_board("uuid", integer);

create function public.vendor_order_board("p_vendor_id" "uuid", "p_closed_limit" integer default 20)
returns table (
  "order_id" "uuid",
  "order_number" "text",
  "vendor_order_no" integer,
  "bucket" "text",
  "order_status" "public"."order_status",
  "payment_status" "public"."payment_status",
  "delivery_status" "public"."delivery_status",
  "fulfilment_type" "public"."fulfilment_type",
  "item_count" bigint,
  "vendor_amount_pesewas" bigint,
  "submitted_at" timestamp with time zone,
  "age_seconds" integer,
  "destination_zone" "text",
  "partner_assigned" boolean,
  "partner_waiting" boolean,
  "awaiting_collection" boolean,
  "cancellation_reason" "text"
)
language sql
stable
security definer
set search_path to ''
as $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       and o.order_status <> 'DRAFT'
       -- A scan order asks nothing of the restaurant through Campus Dash.
       and o.order_type = 'FOOD'
       -- PAID ONLY. A store is never shown an order somebody has not paid for.
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket(v.order_status) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket(v.order_status)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.vendor_order_no,
         r.bucket,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         -- THE VENDOR'S AMOUNT. Never the total, never a fee.
         r.subtotal_pesewas,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
         r.partner_id is not null,
         (r.delivery_status = 'ASSIGNED' and r.order_status = 'READY'),
         (r.order_status = 'READY' and r.delivery_status = 'NONE'),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;

alter function public.vendor_order_board("uuid", integer) owner to postgres;
revoke all on function public.vendor_order_board("uuid", integer) from public, anon;
grant execute on function public.vendor_order_board("uuid", integer) to authenticated, service_role;

drop function if exists public.vendor_order_detail("uuid");

create function public.vendor_order_detail("p_order_id" "uuid")
returns table (
  "order_id" "uuid",
  "order_number" "text",
  "vendor_order_no" integer,
  "vendor_id" "uuid",
  "bucket" "text",
  "order_status" "public"."order_status",
  "payment_status" "public"."payment_status",
  "delivery_status" "public"."delivery_status",
  "fulfilment_type" "public"."fulfilment_type",
  "vendor_amount_pesewas" bigint,
  "submitted_at" timestamp with time zone,
  "age_seconds" integer,
  "accepted_at" timestamp with time zone,
  "preparing_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "destination_zone" "text",
  "partner_assigned" boolean,
  "partner_name" "text",
  "handoff_code_available" boolean,
  "customer_first_name" "text",
  "cancellation_reason" "text",
  "items" "jsonb"
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.vendor_id,
         public.vendor_order_bucket(o.order_status),
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         -- THE VENDOR'S AMOUNT. The service fee, the delivery fee and the
         -- customer's total are not selected.
         o.subtotal_pesewas,
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         -- ZONE ONLY. The room number never leaves the database for a vendor.
         case when o.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = o.destination_zone_id) end,
         o.partner_id is not null,
         public.given_name(p.first_name, p.full_name),
         -- Whether there is a code to read out right now: a Partner at the
         -- counter, or a collection whose food is made.
         (o.payment_status = 'PAID' and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
         -- First name only, and only when nobody is bringing it.
         case when o.delivery_status = 'NONE'
              then public.given_name(c.first_name, c.full_name) end,
         o.cancellation_reason,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'name', oi.name_snapshot,
                       'quantity', oi.quantity,
                       'unit_price_pesewas', oi.unit_price_pesewas,
                       'line_total_pesewas', oi.line_total_pesewas
                     ) order by oi.created_at
                   )
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb
         )
    from public.orders o
    left join public.users p on p.id = o.partner_id
    left join public.users c on c.id = o.customer_id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

alter function public.vendor_order_detail("uuid") owner to postgres;
revoke all on function public.vendor_order_detail("uuid") from public, anon;
grant execute on function public.vendor_order_detail("uuid") to authenticated, service_role;

-- --- Daily totals -------------------------------------------------------------

create function public.vendor_daily_sales("p_vendor_id" "uuid", "p_days" integer default 30)
returns table (
  "order_day" "date",
  "order_count" integer,
  "sales_pesewas" bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.order_day,
         count(distinct o.id)::integer,
         coalesce(sum(a.amount_pesewas), 0)::bigint
    from public.orders o
    join public.allocations a
      on a.order_id = o.id
     and a.payee_type = 'VENDOR'
     and a.payee_id = o.vendor_id
     and a.status <> 'CANCELLED'
   where o.vendor_id = p_vendor_id
     and o.order_type = 'FOOD'
     and o.order_day >= (now() at time zone 'UTC')::date
                        - (least(greatest(coalesce(p_days, 30), 1), 366) - 1)
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   group by o.order_day
   order by o.order_day desc;
$$;

comment on function public.vendor_daily_sales("uuid", integer) is
  'One row per day with sales for this vendor: orders with a live VENDOR allocation, and the sum of those allocations. The vendor''s own amount only. Staff or admin, enforced in the body.';

alter function public.vendor_daily_sales("uuid", integer) owner to postgres;
revoke all on function public.vendor_daily_sales("uuid", integer) from public, anon;
grant execute on function public.vendor_daily_sales("uuid", integer) to authenticated, service_role;

create function public.vendor_orders_on_day("p_vendor_id" "uuid", "p_day" "date")
returns table (
  "order_id" "uuid",
  "vendor_order_no" integer,
  "order_status" "public"."order_status",
  "payment_status" "public"."payment_status",
  "fulfilment_type" "public"."fulfilment_type",
  "item_count" bigint,
  "vendor_amount_pesewas" bigint,
  "counts_as_sale" boolean,
  "submitted_at" timestamp with time zone
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id,
         o.vendor_order_no,
         o.order_status,
         o.payment_status,
         o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.subtotal_pesewas,
         exists (
           select 1 from public.allocations a
            where a.order_id = o.id
              and a.payee_type = 'VENDOR'
              and a.payee_id = o.vendor_id
              and a.status <> 'CANCELLED'
         ),
         o.submitted_at
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.order_day = p_day
     and o.order_type = 'FOOD'
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   order by o.vendor_order_no desc nulls last, o.created_at desc;
$$;

comment on function public.vendor_orders_on_day("uuid", "date") is
  'The paid orders behind one vendor_daily_sales() row, newest queue number first, with the vendor''s own amount. Staff or admin, enforced in the body.';

alter function public.vendor_orders_on_day("uuid", "date") owner to postgres;
revoke all on function public.vendor_orders_on_day("uuid", "date") from public, anon;
grant execute on function public.vendor_orders_on_day("uuid", "date") to authenticated, service_role;
