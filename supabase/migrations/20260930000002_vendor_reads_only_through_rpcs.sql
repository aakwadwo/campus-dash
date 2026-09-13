-- A vendor reads orders ONLY through the vendor RPCs.
--
-- WHAT 20260930000001 LEFT OPEN. It narrowed vendor_order_board() and
-- vendor_order_detail() to the vendor's own amount, but two direct table reads
-- still handed a vendor's session everything those functions no longer return:
--
--   public.orders         orders_read_vendor admitted the store's whole rows:
--                         subtotal, service fee, delivery fee, Partner
--                         earnings, the customer's total.
--   public.order_events   order_events_read admitted the store to its orders'
--                         event log, whose `details` carry the customer's total
--                         (ORDER_SUBMITTED, PAYMENT_INTENT_CREATED) and the
--                         delivery fee (FULFILMENT_CHOSEN).
--
-- Both were reachable with the publishable key and the vendor's own JWT, from
-- a browser console, whatever the screens chose to draw.
--
-- THE ACCESS MODEL AFTER THIS MIGRATION
--
--   A store's view of its orders is exactly what these SECURITY DEFINER reads
--   return, each re-checking is_vendor_staff() in its body:
--     vendor_order_board, vendor_order_detail, vendor_pending_count,
--     vendor_active_count, vendor_handoff_code, vendor_daily_sales,
--     vendor_orders_on_day
--   Direct SELECT on orders, order_events and order_items admits a vendor to
--   nothing. Every vendor screen already reads through the functions above, so
--   no workflow depended on the table reads.
--
--   What a vendor may still read directly is money that is THEIRS: their VENDOR
--   allocations (allocations_read_vendor) and their payouts (payouts_read_own).
--   Both carry only the vendor's own amount.
--
--   Customers, assigned Partners and administrators keep their policies
--   unchanged. An account that is a vendor AND the customer on an order still
--   reads that order as its customer.
--
-- WHY order_items CHANGES TOO. order_items_read decided the vendor branch with
-- an EXISTS over public.orders, evaluated under the caller's own RLS. With
-- orders_read_vendor gone that branch could never be true again; leaving it in
-- the policy would describe access that no longer exists. The line items
-- themselves are not sensitive, and vendor_order_detail() returns them.
--
-- NOTHING ABOUT MONEY MOVES. No payment, pricing, allocation, settlement,
-- payout or order-state function is touched. The event log keeps writing the
-- same details; only who may read them narrows.
--
-- REFUNDS IN THE VENDOR'S SALES. vendor_daily_sales() and
-- vendor_orders_on_day() counted an order while its VENDOR allocation was not
-- CANCELLED. A split-settled allocation is SETTLED at the charge and no refund
-- path cancels a SETTLED row (by design: the ledger records what was routed),
-- so a refunded split order still counted as a normal sale. They now also
-- require the order's own refund state to be clear: payment_status = 'PAID'.
-- REFUND_PENDING and REFUNDED orders are listed, and are not sales. This is a
-- display and counting rule over existing state; the allocation rows are left
-- exactly as settlement wrote them.

-- --- orders -------------------------------------------------------------------

drop policy if exists orders_read_vendor on public.orders;

-- --- order_events -------------------------------------------------------------

drop policy if exists order_events_read on public.order_events;

create policy order_events_read on public.order_events
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
        from public.orders o
       where o.id = order_events.order_id
         and o.customer_id = auth.uid()
    )
  );

-- --- order_items --------------------------------------------------------------

drop policy if exists order_items_read on public.order_items;

create policy order_items_read on public.order_items
  for select
  to authenticated
  using (
    exists (
      select 1
        from public.orders o
       where o.id = order_items.order_id
         and (
           o.customer_id = auth.uid()
           or o.partner_id = auth.uid()
           or public.is_admin()
         )
    )
  );

-- --- The vendor's sales, with refunds taken out -------------------------------

create or replace function public.vendor_daily_sales("p_vendor_id" "uuid", "p_days" integer default 30)
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
  with day_orders as (
    select o.id,
           o.order_day,
           -- A SALE IS A PAID ORDER THAT HAS NOT BEEN REFUNDED, with a live
           -- VENDOR allocation. REFUND_PENDING and REFUNDED are not sales even
           -- where the allocation is still SETTLED by a split.
           (o.payment_status = 'PAID' and a.id is not null) as is_sale,
           coalesce(a.amount_pesewas, 0) as amount_pesewas
      from public.orders o
      left join public.allocations a
        on a.order_id = o.id
       and a.payee_type = 'VENDOR'
       and a.payee_id = o.vendor_id
       and a.status <> 'CANCELLED'
     where o.vendor_id = p_vendor_id
       and o.order_type = 'FOOD'
       and o.order_status <> 'DRAFT'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and o.order_day >= (now() at time zone 'UTC')::date
                          - (least(greatest(coalesce(p_days, 30), 1), 366) - 1)
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
  )
  -- A day whose only orders were refunded is still returned, at zero, so the
  -- refunded order stays reachable from History rather than vanishing.
  select d.order_day,
         (count(distinct d.id) filter (where d.is_sale))::integer,
         (coalesce(sum(d.amount_pesewas) filter (where d.is_sale), 0))::bigint
    from day_orders d
   group by d.order_day
   order by d.order_day desc;
$$;

create or replace function public.vendor_orders_on_day("p_vendor_id" "uuid", "p_day" "date")
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
         -- The same rule vendor_daily_sales() sums by, so a day's list and its
         -- History row always agree.
         o.payment_status = 'PAID'
         and exists (
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
