-- ============================================================================
-- The scan pack fee belongs to the store
-- ============================================================================
-- An intentional change to scan economics, and the only one.
--
-- Until now the GH₵4 pack on a meal-scan order was platform revenue: Campus
-- Dash was going to buy the containers. It is the STORE that packs the food,
-- so the pack is the store's money, allocated to the store in the same ledger
-- row, on the same channel and at the same moment as a food order's subtotal.
--
--                      Collection        Collection + pack    Partner
--   customer pays      GH₵2              GH₵6                 GH₵11
--   VENDOR row         none              GH₵4                 GH₵4
--   PLATFORM (net)     GH₵2              GH₵2                 GH₵2
--   PARTNER            none              none                 GH₵5
--
-- WHAT DOES NOT MOVE. The food on a scan order is still settled between the
-- student and the university: orders.subtotal_pesewas stays zero, the scanned
-- value never enters a ledger row, and the service fee is still the flat
-- scan_service_fee_pesewas. A food order has pack_fee_pesewas = 0 by CHECK
-- constraint, so "subtotal + pack" is exactly "subtotal" there and food
-- economics are untouched to the pesewa.
--
-- WHY ONE EXPRESSION. The vendor's share of any order is now
--
--     subtotal_pesewas + pack_fee_pesewas
--
-- which is the food subtotal on a food order and the pack on a scan order. The
-- ledger, the Paystack split (lib/orders/payments.js) and the store's own
-- screens all read that one expression, so none of them can disagree about what
-- the store is owed.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The ledger
-- ---------------------------------------------------------------------------
create or replace function public.create_order_allocations(p_order_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_vendor   bigint;
  v_platform bigint;
  v_count    integer := 0;
  v_split    bigint := 0;
  v_code     text;
  v_by_split boolean;
begin
  perform public.assert_service_or_admin();

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Already allocated: idempotent no-op, not a duplicate ledger entry.
  if exists (select 1 from public.allocations where order_id = p_order_id) then
    return 0;
  end if;

  -- WHAT THE PROVIDER ACTUALLY SPLIT, read from the payment that succeeded —
  -- not from what we intended, and not from the vendor's current setup.
  select p.split_vendor_pesewas, p.split_subaccount_code
    into v_split, v_code
    from public.payments p
   where p.order_id = p_order_id and p.status = 'SUCCEEDED'
   order by p.created_at desc
   limit 1;

  v_split := coalesce(v_split, 0);

  -- THE STORE'S SHARE: the food it sold, plus the pack it packed. Zero pack on
  -- a food order (orders_pack_fee_scan_only) and zero food on a scan order
  -- (orders_scan_has_no_food_value), so each order type reads its own half.
  v_vendor   := v_order.subtotal_pesewas + coalesce(v_order.pack_fee_pesewas, 0);
  v_platform := v_order.total_pesewas - v_vendor;

  -- A PARTIAL split would leave a remainder nobody was ever going to send, so
  -- only a split covering the whole share settles the row.
  v_by_split := v_code is not null and v_split >= v_vendor;

  -- A food order always has a vendor row. A scan order has one only when the
  -- store is owed something through Campus Dash — the pack. A scan collection
  -- without a pack still writes NO vendor row: a zero-pesewa liability tells a
  -- reader the store is owed something, and it is not.
  if v_order.order_type <> 'SCAN' or v_vendor > 0 then
    insert into public.allocations (
      order_id, payee_type, payee_id, amount_pesewas, status,
      settlement_channel, settled_at
    )
    values (
      p_order_id, 'VENDOR', v_order.vendor_id, v_vendor,
      (case when v_by_split then 'SETTLED' else 'ELIGIBLE' end)::public.allocation_status,
      case when v_by_split then 'SPLIT' else 'TRANSFER' end,
      case when v_by_split then now() end
    );
    v_count := v_count + 1;
  end if;

  -- The service fee, plus the Partner fee until a Partner earns it (see
  -- settle_partner_earnings, which carves it out of this row).
  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status, settlement_channel)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE', 'TRANSFER');
  v_count := v_count + 1;

  return v_count;
end;
$$;

comment on function public.create_order_allocations(uuid) is
  'Writes the ledger for a paid order. VENDOR = subtotal + pack (the food on a food order, the pack on a scan order; no row on a scan order with neither). PLATFORM = the rest, from which settle_partner_earnings later carves the Partner''s fee. Idempotent. A VENDOR row paid by a Paystack split that covered the whole share is born SETTLED.';

-- ---------------------------------------------------------------------------
-- 2. The store's board: whether a pack goes with it, and the store's amount
-- ---------------------------------------------------------------------------
-- PACK INCLUDED is an OPERATIONAL fact — somebody behind the counter has to put
-- the food in one — so it is a column of its own on the board rather than
-- something the store has to infer from money.
--
-- The return types change, so these are dropped and recreated rather than
-- replaced, and their grants are restated below exactly as they were.

drop function if exists public.vendor_order_board(uuid, integer);
create function public.vendor_order_board(p_vendor_id uuid, p_closed_limit integer default 20)
returns table (
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  bucket text,
  order_type public.order_type,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  scan_status public.scan_status,
  item_count bigint,
  vendor_amount_pesewas bigint,
  scan_value_pesewas bigint,
  pack_included boolean,
  submitted_at timestamptz,
  age_seconds integer,
  vendor_completed_at timestamptz,
  awaiting_handoff boolean,
  cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       and o.order_status <> 'DRAFT'
       -- PAID ONLY. A store is never shown an order somebody has not paid for.
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.vendor_order_no,
         r.bucket,
         r.order_type,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         r.scan_status,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         -- THE STORE'S AMOUNT THROUGH CAMPUS DASH. The food on a food order,
         -- the pack on a scan order. Never the total, never a Campus Dash fee.
         r.subtotal_pesewas + coalesce(r.pack_fee_pesewas, 0),
         case when r.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = r.id)
              else 0::bigint end,
         coalesce(r.pack_fee_pesewas, 0) > 0,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         r.vendor_completed_at,
         (r.vendor_completed_at is null and r.order_status = 'READY'
            and (r.delivery_status = 'ASSIGNED' or r.delivery_status = 'NONE')),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when r.bucket = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;

comment on function public.vendor_order_board(uuid, integer) is
  'The store''s board: paid orders only, the store''s own amount (subtotal + pack) and never a customer total, a destination or a phone number. pack_included is the operational fact a counter needs on a scan order. Staff or admin, enforced in the body.';

revoke all on function public.vendor_order_board(uuid, integer) from public, anon;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated, service_role;

drop function if exists public.vendor_order_detail(uuid);
create function public.vendor_order_detail(p_order_id uuid)
returns table (
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_id uuid,
  bucket text,
  order_type public.order_type,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  scan_status public.scan_status,
  scan_details text,
  scan_value_pesewas bigint,
  vendor_amount_pesewas bigint,
  vendor_pack_pesewas bigint,
  submitted_at timestamptz,
  age_seconds integer,
  accepted_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  vendor_completed_at timestamptz,
  handoff_code_available boolean,
  cancellation_reason text,
  items jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.vendor_id,
         public.vendor_order_bucket_for(o.order_status, o.vendor_completed_at),
         o.order_type,
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.scan_status,
         -- The customer's optional note about the FOOD, which is the store's
         -- business. The destination note is a different column and is not here.
         case when o.order_type = 'SCAN' then s.details end,
         case when o.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = o.id)
              else 0::bigint end,
         o.subtotal_pesewas + coalesce(o.pack_fee_pesewas, 0),
         -- THE STORE'S PACK MONEY, as its own figure, so the order screen can
         -- say what the pack is worth to the store without doing arithmetic.
         coalesce(o.pack_fee_pesewas, 0),
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.vendor_completed_at,
         (o.payment_status = 'PAID' and o.vendor_completed_at is null and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
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
    left join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

comment on function public.vendor_order_detail(uuid) is
  'One paid order, as its store sees it: items, the store''s amount (subtotal + pack) and, on a scan order, the scanned value and the pack. No destination, no phone number, no customer total. Staff or admin, enforced in the body.';

revoke all on function public.vendor_order_detail(uuid) from public, anon;
grant execute on function public.vendor_order_detail(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. History: a scan order with a pack is now a sale
-- ---------------------------------------------------------------------------
-- The daily figures were FOOD-only because a scan order paid the store nothing
-- through Campus Dash. One with a pack now does, so the filter becomes the rule
-- that was always underneath it: a sale is a paid order with a live VENDOR
-- allocation. A scan collection without a pack has none, and is still not a
-- sale.

create or replace function public.vendor_daily_sales(p_vendor_id uuid, p_days integer default 30)
returns table (order_day date, order_count integer, sales_pesewas bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with day_orders as (
    select o.id,
           o.order_day,
           (o.payment_status = 'PAID' and a.id is not null) as is_sale,
           coalesce(a.amount_pesewas, 0) as amount_pesewas
      from public.orders o
      left join public.allocations a
        on a.order_id = o.id
       and a.payee_type = 'VENDOR'
       and a.payee_id = o.vendor_id
       and a.status <> 'CANCELLED'
     where o.vendor_id = p_vendor_id
       and (o.order_type = 'FOOD' or coalesce(o.pack_fee_pesewas, 0) > 0)
       and o.order_status <> 'DRAFT'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and o.order_day >= (now() at time zone 'UTC')::date
                          - (least(greatest(coalesce(p_days, 30), 1), 366) - 1)
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
  )
  select d.order_day,
         (count(distinct d.id) filter (where d.is_sale))::integer,
         (coalesce(sum(d.amount_pesewas) filter (where d.is_sale), 0))::bigint
    from day_orders d
   group by d.order_day
   order by d.order_day desc;
$$;

create or replace function public.vendor_orders_on_day(p_vendor_id uuid, p_day date)
returns table (
  order_id uuid,
  vendor_order_no integer,
  order_status public.order_status,
  payment_status public.payment_status,
  fulfilment_type public.fulfilment_type,
  item_count bigint,
  vendor_amount_pesewas bigint,
  counts_as_sale boolean,
  submitted_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.vendor_order_no,
         o.order_status,
         o.payment_status,
         o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.subtotal_pesewas + coalesce(o.pack_fee_pesewas, 0),
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
     and (o.order_type = 'FOOD' or coalesce(o.pack_fee_pesewas, 0) > 0)
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   order by o.vendor_order_no desc nulls last, o.created_at desc;
$$;

comment on column public.orders.pack_fee_pesewas is
  'The pack fee charged on this order, snapshotted at submission. The STORE''S money: it is allocated to the vendor with the rest of the store''s share (subtotal + pack). Always 0 on a FOOD order — orders_pack_fee_scan_only says so — because a food order arrives in the store''s own packaging and is charged nothing for it.';
