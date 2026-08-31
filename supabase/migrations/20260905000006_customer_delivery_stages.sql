-- ============================================================================
-- Customer-facing delivery stages
-- ============================================================================
-- The customer's screen now has to describe a delivery, so the stage needs the
-- third state dimension. There is no GPS and no map: the customer is told which
-- STEP the order is on, never where the Partner physically is, because the
-- system does not know and pretending otherwise is a lie with a progress bar.
-- ============================================================================

drop function if exists public.customer_order_stage(public.order_status, public.payment_status);

create or replace function public.customer_order_stage(
  p_order_status    public.order_status,
  p_payment_status  public.payment_status,
  p_delivery_status public.delivery_status default 'NONE'
)
returns text
language sql
immutable
as $$
  select case
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

    -- Once the food is READY, what matters to the customer is the delivery.
    when p_order_status = 'READY' and p_delivery_status = 'SEARCHING'         then 'SEARCHING_PARTNER'
    when p_order_status = 'READY' and p_delivery_status = 'ASSIGNED'          then 'PARTNER_ASSIGNED'
    when p_order_status = 'READY' and p_delivery_status = 'PICKED_UP'         then 'ON_THE_WAY'
    when p_order_status = 'READY' and p_delivery_status = 'FAILED_NO_PARTNER' then 'NO_PARTNER'
    when p_order_status = 'READY'                                            then 'READY'

    when p_delivery_status = 'FAILED_CUSTOMER_ABSENT'                 then 'CUSTOMER_ABSENT'
    when p_order_status = 'COMPLETED'                                 then 'COMPLETED'
    when p_order_status = 'REJECTED'                                  then 'REJECTED'
    when p_order_status = 'EXPIRED'                                   then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;

-- ---------------------------------------------------------------------------
-- The list, with the delivery dimension folded in
-- ---------------------------------------------------------------------------
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
  select o.id, o.order_number, v.name,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

-- ---------------------------------------------------------------------------
-- The detail, plus the delivery code and the Partner — while active only
-- ---------------------------------------------------------------------------
-- THE PHONE RULE, from the other side. The customer sees the Partner's number
-- while that Partner is carrying their food, and not before or after. Once the
-- job is done it disappears from this response, so it cannot linger in history.
--
-- Dropped rather than replaced: the return shape gains columns, and Postgres
-- will not swap one OUT-parameter row type for another.
drop function if exists public.customer_order_detail(uuid);

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
  partner_name         text,
  partner_phone        text,
  delivery_code        text,
  disputed             boolean,
  dispute_reason       text,
  items                jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, v.name,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas, o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at, o.ready_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- Only while a Partner is actually carrying this order.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.full_name end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         -- The code the customer reads out on arrival. Shown from assignment,
         -- and withheld once the delivery is over — it has no further use.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;

-- ---------------------------------------------------------------------------
-- When nobody takes the job
-- ---------------------------------------------------------------------------
-- The food exists and is paid for. The customer chooses what happens next; the
-- order is NOT cancelled out from under them, and the vendor does nothing.
create or replace function public.customer_keep_waiting(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg   public.pricing_config%rowtype;
  v_order public.orders%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  update public.orders
     set delivery_status = 'SEARCHING',
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds)
   where id = p_order_id
     and customer_id = auth.uid()
     and delivery_status = 'FAILED_NO_PARTNER'
  returning * into v_order;

  if not found then
    return row(false, 'this order is not waiting for a Partner')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'DISPATCH_REOPENED', true, 'CUSTOMER',
    'delivery_status', 'FAILED_NO_PARTNER', 'SEARCHING', 'customer chose to keep waiting');

  return row(true, null)::public.transition_result;
end;
$$;

-- "I will come and get it myself."
--
-- Deliberately does NOT refund the delivery fee. The money already collected
-- stays put and becomes an admin decision, because a partial refund depends
-- entirely on what the payment provider turns out to support — and inventing a
-- refund the provider cannot perform is worse than not offering one.
create or replace function public.customer_collect_instead(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  update public.orders
     set delivery_status = 'NONE'
   where id = p_order_id
     and customer_id = auth.uid()
     and fulfilment_type = 'DELIVERY'
     and delivery_status in ('SEARCHING', 'FAILED_NO_PARTNER')
     and order_status = 'READY'
  returning * into v_order;

  if not found then
    return row(false, 'this order cannot be collected right now')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'CUSTOMER_WILL_COLLECT', true, 'CUSTOMER',
    'delivery_status', 'SEARCHING', 'NONE',
    'customer chose to collect; delivery fee refund is an admin decision');

  return row(true, null)::public.transition_result;
end;
$$;

-- NOTE: a DROP discards explicit grants, and the recreated function picks up
-- Supabase's default ACL again — so anything dropped above must be re-revoked
-- here, not just the functions that are new. customer_order_detail came back
-- anon-callable purely because it was dropped to change its return shape.
revoke execute on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status) from public, anon;
revoke execute on function public.customer_order_detail(uuid) from public, anon;
revoke execute on function public.customer_order_list(integer) from public, anon;
grant execute on function public.customer_order_detail(uuid) to authenticated;
grant execute on function public.customer_order_list(integer) to authenticated;
revoke execute on function public.customer_keep_waiting(uuid) from public, anon;
revoke execute on function public.customer_collect_instead(uuid) from public, anon;

grant execute on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status) to authenticated;
grant execute on function public.customer_keep_waiting(uuid)    to authenticated;
grant execute on function public.customer_collect_instead(uuid) to authenticated;
