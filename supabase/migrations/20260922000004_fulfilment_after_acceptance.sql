-- ============================================================================
-- The delivery decision moves to where the information is
-- ============================================================================
-- The old flow asked for it first: pick a vendor, pick items, pick pickup or
-- delivery, pick a room, submit — and only then find out whether the kitchen
-- was even going to cook. That put the most consequential choice (do I walk
-- there, or do I pay someone GH₵5 to bring it) before the one fact that decides
-- it, which is whether there is going to be an order at all.
--
-- It now sits between acceptance and payment:
--
--   submit  →  vendor ACCEPTS  →  customer chooses pickup or delivery
--                              →  price recalculates  →  customer pays
--
-- So `fulfilment_type` is NULLABLE, and NULL has a precise meaning: the vendor
-- has not answered yet, or has, and the customer has not chosen. It is never a
-- missing value — it is a state, and the payment path refuses to run while the
-- order is in it.
--
-- Nothing about the MONEY changes. The service fee is still 5% of the food
-- subtotal, computed once at submission from the price snapshot, and the
-- delivery fee is still the configured flat fee. What changes is when the
-- delivery fee is added: at the choice, not at the guess.
-- ============================================================================

alter table public.orders alter column fulfilment_type drop not null;

comment on column public.orders.fulfilment_type is
  'PICKUP, DELIVERY, or NULL meaning the customer has not chosen yet. NULL is a '
  'state, not a missing value: an order reaches it at submission and leaves it '
  'when customer_choose_fulfilment() runs, after the vendor has accepted. '
  'create_payment_intent() refuses an order still in it, so nothing is ever '
  'charged for a delivery nobody asked for.';

-- ---------------------------------------------------------------------------
-- Pricing, without a fulfilment
-- ---------------------------------------------------------------------------
drop function if exists public.price_order(uuid, public.fulfilment_type, jsonb, uuid);
create function public.price_order(
  p_vendor_id uuid,
  p_items     jsonb
)
returns table (
  subtotal_pesewas bigint, service_fee_pesewas bigint, total_pesewas bigint,
  lines jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  -- A CLOSED store takes no new orders. Existing ones are untouched: this
  -- guards submission, not the lifecycle of work already in the kitchen.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_menu.price_pesewas,
      'quantity',           v_qty,
      'line_total_pesewas', v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. UNCHANGED, and
  -- deliberately restated rather than refactored away: this expression is the
  -- platform's entire revenue model and it should be readable in one place.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;

  return query select v_subtotal, v_service, v_subtotal + v_service, v_lines;
end;
$$;
revoke all on function public.price_order(uuid, jsonb) from public;

drop function if exists public.quote_order(uuid, public.fulfilment_type, jsonb, uuid);
create function public.quote_order(p_vendor_id uuid, p_items jsonb)
returns table (
  subtotal_pesewas bigint, service_fee_pesewas bigint, total_pesewas bigint,
  lines jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.subtotal_pesewas, p.service_fee_pesewas, p.total_pesewas, p.lines
    from public.price_order(p_vendor_id, p_items) p;
$$;
grant execute on function public.quote_order(uuid, jsonb) to authenticated;

-- What each fulfilment would cost, for the screen that asks the question. Read
-- only; choosing is a separate, authorised write.
create or replace function public.fulfilment_options(p_order_id uuid)
returns table (
  fulfilment_type public.fulfilment_type,
  delivery_fee_pesewas bigint,
  total_pesewas bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.fulfilment_type,
         case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         o.subtotal_pesewas + o.service_fee_pesewas
           + case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end
    from public.orders o
    cross join public.pricing_config c
    cross join (values ('PICKUP'::public.fulfilment_type), ('DELIVERY'::public.fulfilment_type))
                 as f(fulfilment_type)
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and c.id
   order by f.fulfilment_type;
$$;
grant execute on function public.fulfilment_options(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Submitting
-- ---------------------------------------------------------------------------
drop function if exists public.submit_order_for(uuid, uuid, public.fulfilment_type, jsonb, uuid, text);
create function public.submit_order_for(
  p_customer_id uuid,
  p_vendor_id   uuid,
  p_items       jsonb
)
returns table (order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_total    bigint;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_customer(p_customer_id) then
    raise exception 'this account has not completed customer sign-up'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- ONE ORDER, ONE VENDOR. Enforced by the column: there is no basket spanning
  -- two kitchens and no way to express one.
  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accept_deadline_at
  )
  values (
    p_customer_id, p_vendor_id, null, 'SUBMITTED',
    0, 0, 0, 0, 0,
    'NONE', now(), now() + make_interval(secs => v_cfg.vendor_response_seconds)
  )
  returning id, orders.order_number into v_order_id, v_number;

  -- --- PRICE SNAPSHOT ------------------------------------------------------
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_total, 'item_count', jsonb_array_length(p_items))
  );

  return query select v_order_id, v_number, v_total;
end;
$$;
revoke all on function public.submit_order_for(uuid, uuid, jsonb) from public;

drop function if exists public.submit_order(uuid, public.fulfilment_type, jsonb, uuid, text);
create function public.submit_order(p_vendor_id uuid, p_items jsonb)
returns table (order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(auth.uid(), p_vendor_id, p_items);
end;
$$;
revoke all on function public.submit_order(uuid, jsonb) from public;
grant execute on function public.submit_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Choosing
-- ---------------------------------------------------------------------------
-- The price is recomputed from the ORDER'S OWN SNAPSHOT — the subtotal and
-- service fee written at submission — plus the delivery fee read from
-- pricing_config now. The caller sends no amount and could not; there is no
-- parameter for one.
create or replace function public.customer_choose_fulfilment(
  p_order_id                uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note        text default null
)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_cfg      public.pricing_config%rowtype;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  -- AUTHORISATION: not your order. Raised, and the same message whether the
  -- order belongs to somebody else or does not exist — probing tells the caller
  -- nothing either way.
  if not found or v_order.customer_id <> auth.uid() then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Integer division floors, so the Partner's share can never exceed the fee.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  -- CONDITIONAL UPDATE. Only an ACCEPTED, unpaid, food order may be changed —
  -- and only while it is still UNPAID or FAILED, so a re-choice after a
  -- successful payment cannot move the amount out from under the money.
  update public.orders o
     set fulfilment_type          = p_fulfilment_type,
         destination_location_id  = case when p_fulfilment_type = 'DELIVERY'
                                         then p_destination_location_id end,
         destination_note         = case when p_fulfilment_type = 'DELIVERY'
                                         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
         destination_zone_id      = v_zone,
         delivery_fee_pesewas     = v_delivery,
         partner_earnings_pesewas = v_earnings,
         total_pesewas            = o.subtotal_pesewas + o.service_fee_pesewas + v_delivery
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status = 'ACCEPTED'
     and o.payment_status in ('UNPAID', 'FAILED')
     and o.order_type = 'FOOD'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', false, 'CUSTOMER',
      null, null, p_fulfilment_type::text,
      'order was not an accepted, unpaid food order');
    return row(false, 'this order is past the point of choosing')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', true, 'CUSTOMER',
    null, null, p_fulfilment_type::text, null,
    jsonb_build_object(
      'delivery_fee_pesewas', v_delivery,
      'total_pesewas', v_order.total_pesewas));

  return row(true, null)::public.transition_result;
end;
$$;
revoke all on function public.customer_choose_fulfilment(uuid, public.fulfilment_type, uuid, text) from public;
grant execute on function public.customer_choose_fulfilment(uuid, public.fulfilment_type, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Paying
-- ---------------------------------------------------------------------------
-- One more precondition, and it is the load-bearing one for the new flow: an
-- order with no fulfilment has no delivery fee in its total, so charging it
-- would collect the wrong amount and then have nowhere to put the difference.
create or replace function public.create_payment_intent(
  p_order_id uuid, p_provider text, p_idempotency_key text
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where idempotency_key = p_idempotency_key;
  if found then
    if v_payment.order_id <> p_order_id then
      raise exception 'idempotency key reused with a different order'
        using errcode = 'check_violation';
    end if;
    return v_payment;
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  if v_order.order_status <> 'ACCEPTED' then
    raise exception 'order must be ACCEPTED before payment (is %)', v_order.order_status
      using errcode = 'check_violation';
  end if;
  if v_order.fulfilment_type is null then
    raise exception 'choose pickup or delivery before paying' using errcode = 'check_violation';
  end if;
  if v_order.payment_status not in ('UNPAID', 'FAILED') then
    raise exception 'order payment is already % ', v_order.payment_status
      using errcode = 'check_violation';
  end if;

  insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
  values (p_order_id, p_provider, v_order.total_pesewas, p_idempotency_key, 'PENDING')
  returning * into v_payment;

  update public.orders set payment_status = 'PENDING' where id = p_order_id;

  perform public.log_order_event(p_order_id, 'PAYMENT_INTENT_CREATED', true, 'SYSTEM',
    'payment_status', 'UNPAID', 'PENDING', null,
    jsonb_build_object('payment_id', v_payment.id, 'amount_pesewas', v_payment.amount_pesewas));

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- The customer's stage
-- ---------------------------------------------------------------------------
-- One new stage, and it comes BEFORE payment because that is where it now is.
-- The signature gains an argument, so the transition tables in
-- lib/orders/state.js and this function still describe the same machine.
drop function if exists public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status);
create function public.customer_order_stage(
  p_order_status    public.order_status,
  p_payment_status  public.payment_status,
  p_delivery_status public.delivery_status default 'NONE',
  p_fulfilment_type public.fulfilment_type default null
)
returns text
language sql
immutable
as $$
  select case
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'
    -- Accepted, and the customer still has to say how they want it. This is the
    -- screen the whole reordering exists for.
    when p_order_status = 'ACCEPTED' and p_fulfilment_type is null
     and p_payment_status = 'UNPAID'                                  then 'CHOOSE_FULFILMENT'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

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
grant execute on function public.customer_order_stage(
  public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type
) to authenticated;

create or replace function public.customer_order_list(p_limit integer default 30)
returns table (
  order_id uuid, order_number text, vendor_name text, stage text,
  order_status public.order_status, payment_status public.payment_status,
  delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
  item_count bigint, total_pesewas bigint, submitted_at timestamptz,
  seconds_to_deadline integer, cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, v.name,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
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

drop function if exists public.customer_order_detail(uuid);
create function public.customer_order_detail(p_order_id uuid)
returns table (
  order_id uuid, order_number text, vendor_name text, vendor_location text,
  stage text, order_status public.order_status, payment_status public.payment_status,
  delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
  order_type public.order_type,
  subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint,
  total_pesewas bigint, destination text, destination_note text,
  submitted_at timestamptz, seconds_to_deadline integer,
  accepted_at timestamptz, preparing_at timestamptz, ready_at timestamptz,
  assigned_at timestamptz, picked_up_at timestamptz, completed_at timestamptz,
  cancellation_reason text, payment_id uuid, payment_txn_status public.payment_txn_status,
  partner_name text, partner_phone text, delivery_code text, pickup_code text,
  disputed boolean, dispute_reason text, items jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, v.name, public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas, o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.full_name end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         -- THE DELIVERY CODE. The customer holds it and reads it out on
         -- arrival; the Partner types in what they hear. Shown from assignment,
         -- withheld once the delivery is over — it has no further use.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         -- THE SELF-PICKUP CODE, and a completely different thing: it exists
         -- only for an order the customer collects themselves, and it is what
         -- the vendor checks at the counter.
         case when o.fulfilment_type = 'PICKUP' and o.payment_status = 'PAID'
                   and o.order_status in ('PREPARING', 'READY')
              then s.pickup_code end,
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
grant execute on function public.customer_order_detail(uuid) to authenticated;
