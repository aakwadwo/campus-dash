-- ============================================================================
-- Phase 5 — the vendor's view of their own orders
-- ============================================================================
-- These exist so the DATABASE decides what a vendor may see, not the UI.
--
-- A vendor gets what they need to cook and hand over food, and nothing else:
--   * the destination ZONE for a delivery order, never the room. The Partner
--     takes it to the door; the vendor has no reason to know which one.
--   * whether a Partner has been assigned, never who the customer is.
--   * no pickup or delivery code, ever — those live in order_secrets, which has
--     no policy and no grant for anybody.
--
-- Relying on the page to omit a column would mean the data still crossed the
-- wire. Here it never leaves the database.
-- ============================================================================

-- How the board groups an order. Server-decided so every screen agrees.
create or replace function public.vendor_order_bucket(
  p_order_status public.order_status
)
returns text
language sql
immutable
as $$
  select case
    when p_order_status = 'SUBMITTED'                then 'NEW'
    when p_order_status in ('ACCEPTED', 'PREPARING') then 'PREPARING'
    when p_order_status = 'READY'                    then 'READY'
    else 'CLOSED'
  end;
$$;

create or replace function public.vendor_order_board(
  p_vendor_id      uuid,
  p_closed_limit   integer default 20
)
returns table (
  order_id            uuid,
  order_number        text,
  bucket              text,
  order_status        public.order_status,
  payment_status      public.payment_status,
  delivery_status     public.delivery_status,
  fulfilment_type     public.fulfilment_type,
  item_count          bigint,
  total_pesewas       bigint,
  submitted_at        timestamptz,
  accept_deadline_at  timestamptz,
  -- Negative once the window has closed; the sweep will expire it shortly.
  seconds_to_deadline integer,
  age_seconds         integer,
  destination_zone    text,
  partner_assigned    boolean,
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
       -- A DRAFT order has not been sent to anyone yet.
       and o.order_status <> 'DRAFT'
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
         r.bucket,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         r.total_pesewas,
         r.submitted_at,
         r.accept_deadline_at,
         case when r.accept_deadline_at is not null
              then extract(epoch from (r.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
         r.partner_id is not null,
         r.cancellation_reason
    from ranked r
   -- Live work is always shown; closed orders are capped so a busy stall does
   -- not scroll through last week to find today.
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'PREPARING' then 1 when 'READY' then 2 else 3 end,
     -- Oldest first within live work: the order closest to its deadline is the
     -- one that needs attention.
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- One order, with its lines
-- ---------------------------------------------------------------------------
-- Item names and prices come from the ORDER's own snapshot, never from
-- menu_items. A vendor looking at an order sees what the customer agreed to pay,
-- even if the menu has moved on since.
create or replace function public.vendor_order_detail(p_order_id uuid)
returns table (
  order_id            uuid,
  order_number        text,
  vendor_id           uuid,
  bucket              text,
  order_status        public.order_status,
  payment_status      public.payment_status,
  delivery_status     public.delivery_status,
  fulfilment_type     public.fulfilment_type,
  subtotal_pesewas    bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  total_pesewas       bigint,
  submitted_at        timestamptz,
  accept_deadline_at  timestamptz,
  seconds_to_deadline integer,
  age_seconds         integer,
  accepted_at         timestamptz,
  preparing_at        timestamptz,
  ready_at            timestamptz,
  completed_at        timestamptz,
  destination_zone    text,
  partner_assigned    boolean,
  cancellation_reason text,
  items               jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.vendor_id,
         public.vendor_order_bucket(o.order_status),
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.subtotal_pesewas,
         o.service_fee_pesewas,
         o.delivery_fee_pesewas,
         o.total_pesewas,
         o.submitted_at,
         o.accept_deadline_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         case when o.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = o.destination_zone_id) end,
         o.partner_id is not null,
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
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

-- ---------------------------------------------------------------------------
-- Unseen work, for the in-app alert
-- ---------------------------------------------------------------------------
-- Cheap enough to poll every few seconds without pulling the whole board.
create or replace function public.vendor_pending_count(p_vendor_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.order_status = 'SUBMITTED'
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin());
$$;

-- Belt and braces alongside the default-privilege revoke: state explicitly that
-- these are not public, then grant only what the vendor screens need.
revoke execute on function public.vendor_order_bucket(public.order_status) from public, anon;
revoke execute on function public.vendor_order_board(uuid, integer)        from public, anon;
revoke execute on function public.vendor_order_detail(uuid)                from public, anon;
revoke execute on function public.vendor_pending_count(uuid)               from public, anon;

grant execute on function public.vendor_order_bucket(public.order_status) to authenticated;
grant execute on function public.vendor_order_board(uuid, integer)        to authenticated;
grant execute on function public.vendor_order_detail(uuid)                to authenticated;
grant execute on function public.vendor_pending_count(uuid)               to authenticated;
