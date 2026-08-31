-- ============================================================================
-- Phase 6 — the customer's view of their own orders
-- ============================================================================
-- Like the vendor board, these decide exposure in the database rather than in
-- the page. A customer sees their order, the vendor's name, and what they are
-- being charged. They do not see vendor-internal state, another customer's
-- anything, or the contents of order_secrets.
-- ============================================================================

-- What the customer is being asked to do right now. Derived from all three
-- state dimensions together, so the screen never has to reason about their
-- interaction — which is exactly where a UI gets it wrong.
create or replace function public.customer_order_stage(
  p_order_status    public.order_status,
  p_payment_status  public.payment_status
)
returns text
language sql
immutable
as $$
  select case
    when p_order_status = 'SUBMITTED'                            then 'AWAITING_VENDOR'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'  then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'  then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING' then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                             then 'PAID_AWAITING_KITCHEN'
    when p_order_status = 'PREPARING'                            then 'PREPARING'
    when p_order_status = 'READY'                                then 'READY'
    when p_order_status = 'COMPLETED'                            then 'COMPLETED'
    when p_order_status = 'REJECTED'                             then 'REJECTED'
    when p_order_status = 'EXPIRED'                              then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;

create or replace function public.customer_order_list(p_limit integer default 30)
returns table (
  order_id            uuid,
  order_number        text,
  vendor_name         text,
  stage               text,
  order_status        public.order_status,
  payment_status      public.payment_status,
  delivery_status     public.delivery_status,
  fulfilment_type     public.fulfilment_type,
  item_count          bigint,
  total_pesewas       bigint,
  submitted_at        timestamptz,
  seconds_to_deadline integer,
  cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         v.name,
         public.customer_order_stage(o.order_status, o.payment_status),
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
   where o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

create or replace function public.customer_order_detail(p_order_id uuid)
returns table (
  order_id             uuid,
  order_number         text,
  vendor_name          text,
  stage                text,
  order_status         public.order_status,
  payment_status       public.payment_status,
  delivery_status      public.delivery_status,
  fulfilment_type      public.fulfilment_type,
  subtotal_pesewas     bigint,
  service_fee_pesewas  bigint,
  delivery_fee_pesewas bigint,
  total_pesewas        bigint,
  destination          text,
  destination_note     text,
  submitted_at         timestamptz,
  seconds_to_deadline  integer,
  accepted_at          timestamptz,
  ready_at             timestamptz,
  completed_at         timestamptz,
  cancellation_reason  text,
  payment_id           uuid,
  payment_txn_status   public.payment_txn_status,
  items                jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         v.name,
         public.customer_order_stage(o.order_status, o.payment_status),
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.subtotal_pesewas,
         o.service_fee_pesewas,
         o.delivery_fee_pesewas,
         o.total_pesewas,
         -- The customer's own destination, so the full path is theirs to see.
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at,
         o.ready_at,
         o.completed_at,
         o.cancellation_reason,
         -- The live payment attempt, so the screen can poll it. Never the
         -- provider payload, which is server-only.
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'name', oi.name_snapshot,
                       'quantity', oi.quantity,
                       'unit_price_pesewas', oi.unit_price_pesewas,
                       'line_total_pesewas', oi.line_total_pesewas
                     ) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb
         )
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;

-- ---------------------------------------------------------------------------
-- Destinations a customer may choose
-- ---------------------------------------------------------------------------
-- Flat, with the readable path, so a phone can present one searchable list
-- rather than three cascading dropdowns.
create or replace function public.deliverable_locations()
returns table (location_id uuid, path text, zone text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.id,
         public.location_path(l.id),
         coalesce((select z.name from public.locations z where z.id = public.location_zone(l.id)), 'Campus')
    from public.locations l
   where l.is_deliverable and l.is_active
   order by public.location_path(l.id);
$$;

revoke execute on function public.customer_order_stage(public.order_status, public.payment_status) from public, anon;
revoke execute on function public.customer_order_list(integer) from public, anon;
revoke execute on function public.customer_order_detail(uuid) from public, anon;
revoke execute on function public.deliverable_locations() from public;

grant execute on function public.customer_order_stage(public.order_status, public.payment_status) to authenticated;
grant execute on function public.customer_order_list(integer) to authenticated;
grant execute on function public.customer_order_detail(uuid) to authenticated;
-- Browsing destinations before signing in is harmless and lets someone see
-- whether Campus Dash reaches their block.
grant execute on function public.deliverable_locations() to anon, authenticated;
