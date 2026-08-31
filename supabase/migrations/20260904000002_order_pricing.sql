-- ============================================================================
-- Phase 6 — one pricing implementation, used by both the quote and the order
-- ============================================================================
-- The customer needs to see a total before they commit, and the server must
-- charge exactly that. Two code paths computing it is the obvious way to get a
-- basket that says GH₵97 and an order that says GH₵102.
--
-- So pricing lives here, once. quote_order() reads it; submit_order_for()
-- writes with it. Neither can drift from the other because there is nothing to
-- drift from.
--
-- The CLIENT SENDS ONLY menu item ids and quantities. Any price, total, fee or
-- name it includes is ignored — not validated, ignored, because this function
-- never looks at anything else in the payload.
-- ============================================================================

create or replace function public.price_order(
  p_vendor_id               uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_items                   jsonb,
  p_destination_location_id uuid default null
)
returns table (
  subtotal_pesewas         bigint,
  service_fee_pesewas      bigint,
  delivery_fee_pesewas     bigint,
  partner_earnings_pesewas bigint,
  total_pesewas            bigint,
  destination_zone_id      uuid,
  lines                    jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
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

    -- One line per item. A basket that listed the same dish twice would
    -- otherwise produce two lines and an order the customer cannot read.
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

  return query select
    v_subtotal,
    v_cfg.service_fee_pesewas,
    v_delivery,
    v_earnings,
    v_subtotal + v_cfg.service_fee_pesewas + v_delivery,
    v_zone,
    v_lines;
end;
$$;

-- ---------------------------------------------------------------------------
-- The customer's basket total, before they commit
-- ---------------------------------------------------------------------------
-- Read-only, and returns exactly what submitting would charge. Fees are not
-- secret — the customer is entitled to see what they are paying for.
create or replace function public.quote_order(
  p_vendor_id               uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_items                   jsonb,
  p_destination_location_id uuid default null
)
returns table (
  subtotal_pesewas     bigint,
  service_fee_pesewas  bigint,
  delivery_fee_pesewas bigint,
  total_pesewas        bigint,
  lines                jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.subtotal_pesewas, p.service_fee_pesewas, p.delivery_fee_pesewas,
         p.total_pesewas, p.lines
    from public.price_order(p_vendor_id, p_fulfilment_type, p_items, p_destination_location_id) p;
$$;

-- ---------------------------------------------------------------------------
-- submit_order_for, now built on the same pricing
-- ---------------------------------------------------------------------------
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
  v_price    record;
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_line     jsonb;
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

  -- Everything the order costs, derived here and nowhere else.
  select * into v_price
    from public.price_order(p_vendor_id, p_fulfilment_type, p_items, p_destination_location_id);

  select * into v_cfg from public.pricing_config where id;

  -- total is set explicitly rather than defaulted: orders_total_is_sum is
  -- checked on THIS statement, before the lines below exist.
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
    nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    v_price.subtotal_pesewas, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas,
    v_price.partner_earnings_pesewas, v_price.total_pesewas,
    'NONE', now(), now() + make_interval(secs => v_cfg.vendor_response_seconds)
  )
  returning id, orders.order_number into v_order_id, v_number;

  -- --- PRICE SNAPSHOT ------------------------------------------------------
  -- The name and unit price are COPIED. If the vendor moves this dish from
  -- GH₵35 to GH₵50 tomorrow, this order still says GH₵35 for ever.
  for v_line in select * from jsonb_array_elements(v_price.lines) loop
    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id,
      (v_line ->> 'menu_item_id')::uuid,
      v_line ->> 'name',
      (v_line ->> 'unit_price_pesewas')::bigint,
      (v_line ->> 'quantity')::integer,
      (v_line ->> 'line_total_pesewas')::bigint
    );
  end loop;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_price.total_pesewas,
                             'item_count', jsonb_array_length(v_price.lines))
  );

  return query select v_order_id, v_number, v_price.total_pesewas;
end;
$$;

revoke execute on function
  public.price_order(uuid, public.fulfilment_type, jsonb, uuid) from public, anon, authenticated;
revoke execute on function
  public.submit_order_for(uuid, uuid, public.fulfilment_type, jsonb, uuid, text)
  from public, anon, authenticated;

revoke execute on function
  public.quote_order(uuid, public.fulfilment_type, jsonb, uuid) from public, anon;
grant execute on function
  public.quote_order(uuid, public.fulfilment_type, jsonb, uuid) to authenticated;
