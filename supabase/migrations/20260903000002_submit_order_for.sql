-- ============================================================================
-- Phase 5 — server-side order submission
-- ============================================================================
-- submit_order() derives the customer from auth.uid(), which is right for a
-- real customer request but leaves no way for a trusted server context to place
-- an order on someone's behalf. Phase 5 needs that to exercise the vendor
-- module before the customer UI exists in Phase 6.
--
-- Rather than duplicate the pricing and snapshot logic — the one place a second
-- copy would be genuinely dangerous — the body moves into submit_order_for(),
-- and submit_order() becomes a thin wrapper that supplies auth.uid().
--
-- submit_order_for() is NOT granted to any client role and asserts a server
-- context internally, so it cannot be used to place an order as someone else.
-- ============================================================================

create or replace function public.submit_order_for(
  p_customer_id             uuid,
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
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_total    bigint;
  v_zone     uuid;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Placing an order AS someone else is a server-only capability.
  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
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
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accept_deadline_at
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'SUBMITTED',
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

-- The customer-facing entry point. Identical behaviour, but the customer can
-- only ever be whoever is signed in.
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
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(
      auth.uid(), p_vendor_id, p_fulfilment_type, p_items,
      p_destination_location_id, p_destination_note
    );
end;
$$;

-- submit_order_for is deliberately NOT granted to anon or authenticated.
revoke execute on function
  public.submit_order_for(uuid, uuid, public.fulfilment_type, jsonb, uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.submit_order(uuid, public.fulfilment_type, jsonb, uuid, text) to authenticated;
