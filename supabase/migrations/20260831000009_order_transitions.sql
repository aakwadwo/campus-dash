-- ============================================================================
-- Order state transitions
-- ============================================================================
-- Every one of these is a CONDITIONAL UPDATE guarded on the current state.
-- Zero rows affected means the transition lost — it is logged and reported,
-- never retried by overwriting.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- submit_order — the price snapshot happens HERE
-- ---------------------------------------------------------------------------
-- The client sends menu item ids and quantities. It does NOT send prices, and
-- any price it did send would be ignored: the server reads current prices,
-- copies them onto the order, and computes every total itself.
create or replace function public.submit_order(
  p_vendor_id               uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_items                   jsonb,
  p_destination_location_id uuid default null,
  p_destination_note        text default null
)
returns table (order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_customer    uuid := auth.uid();
  v_cfg         public.pricing_config%rowtype;
  v_order_id    uuid;
  v_number      text;
  v_subtotal    bigint := 0;
  v_delivery    bigint := 0;
  v_earnings    bigint := 0;
  v_total       bigint;
  v_zone        uuid;
  v_item        jsonb;
  v_menu        public.menu_items%rowtype;
  v_qty         integer;
begin
  if v_customer is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_customer and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- The vendor must be open. An unavailable vendor cannot receive new orders.
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

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location' using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Integer division floors, so the Partner's share can never exceed the fee.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  -- total_pesewas is set explicitly here, not left to default to 0: the
  -- orders_total_is_sum constraint is checked on THIS statement, long before
  -- the item loop below has a subtotal to add. Starting balanced (subtotal 0)
  -- keeps the invariant true at every step rather than only at the end.
  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accept_deadline_at
  )
  values (
    v_customer, p_vendor_id, p_fulfilment_type, 'SUBMITTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    p_destination_note,
    v_zone,
    0, v_cfg.service_fee_pesewas, v_delivery,
    v_earnings, v_cfg.service_fee_pesewas + v_delivery,
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

  v_total := v_subtotal + v_cfg.service_fee_pesewas + v_delivery;

  update public.orders
     set subtotal_pesewas = v_subtotal, total_pesewas = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_total, 'item_count', jsonb_array_length(p_items))
  );

  return query select v_order_id, v_number, v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vendor: accept / reject
-- ---------------------------------------------------------------------------
create or replace function public.vendor_accept_order(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  -- CONDITIONAL UPDATE: only SUBMITTED may become ACCEPTED, and only before the
  -- deadline. A vendor cannot accept a READY order, or one already expired.
  update public.orders
     set order_status = 'ACCEPTED', accepted_at = now()
   where id = p_order_id
     and order_status = 'SUBMITTED'
     and accept_deadline_at > now()
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_ACCEPT', false, 'VENDOR',
      'order_status', v_prev::text, 'ACCEPTED', 'order was not SUBMITTED within its window');
    return row(false, format('order cannot be accepted from state %s', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_ACCEPT', true, 'VENDOR',
    'order_status', 'SUBMITTED', 'ACCEPTED');
  return row(true, null)::public.transition_result;
end;
$$;

create or replace function public.vendor_reject_order(p_order_id uuid, p_reason text default null)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders
     set order_status = 'REJECTED', cancelled_at = now(), cancellation_reason = p_reason
   where id = p_order_id and order_status = 'SUBMITTED'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_REJECT', false, 'VENDOR',
      'order_status', v_prev::text, 'REJECTED', 'order was not SUBMITTED');
    return row(false, format('order cannot be rejected from state %s', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_REJECT', true, 'VENDOR',
    'order_status', 'SUBMITTED', 'REJECTED', p_reason);
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vendor timeout — auto-reject
-- ---------------------------------------------------------------------------
-- No payment has been taken at this point, so expiry costs the customer
-- nothing. Server-side only; a scheduled job calls it.
create or replace function public.expire_stale_orders()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_id    uuid;
begin
  perform public.assert_service_or_admin();

  for v_id in
    update public.orders
       set order_status = 'EXPIRED', cancelled_at = now(),
           cancellation_reason = 'vendor did not respond within the acceptance window'
     where order_status = 'SUBMITTED' and accept_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'ORDER_EXPIRED', true, 'SYSTEM',
      'order_status', 'SUBMITTED', 'EXPIRED', 'vendor acceptance window elapsed');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vendor: preparing -> ready
-- ---------------------------------------------------------------------------
create or replace function public.vendor_mark_preparing(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  -- Preparation starts only once the money is actually in. The vendor never
  -- cooks on the strength of a browser saying the customer paid.
  update public.orders
     set order_status = 'PREPARING', preparing_at = now()
   where id = p_order_id and order_status = 'ACCEPTED' and payment_status = 'PAID'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_PREPARING', false, 'VENDOR',
      'order_status', v_prev::text, 'PREPARING', 'order was not ACCEPTED and PAID');
    return row(false, format('order cannot start preparing from state %s (payment must be PAID)', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_PREPARING', true, 'VENDOR',
    'order_status', 'ACCEPTED', 'PREPARING');
  return row(true, null)::public.transition_result;
end;
$$;

-- READY is where Partner dispatch begins — never at order time. A Partner
-- should never be standing at the vendor waiting for food to be cooked.
create or replace function public.vendor_mark_ready(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
  v_cfg   public.pricing_config%rowtype;
begin
  select order_status into v_prev from public.orders where id = p_order_id;
  select * into v_cfg from public.pricing_config where id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders o
     set order_status = 'READY',
         ready_at = now(),
         -- Dispatch opens only for delivery orders. Pickup stays NONE forever.
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case when o.fulfilment_type = 'DELIVERY' then now() end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY'
           then now() + make_interval(secs => v_cfg.partner_search_seconds) end
   where o.id = p_order_id and o.order_status = 'PREPARING'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'order was not PREPARING');
    return row(false, format('order cannot be marked ready from state %s', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_READY', true, 'VENDOR',
    'order_status', 'PREPARING', 'READY');

  if v_order.fulfilment_type = 'DELIVERY' then
    perform public.log_order_event(p_order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
      'delivery_status', 'NONE', 'SEARCHING');
  end if;

  return row(true, null)::public.transition_result;
end;
$$;
