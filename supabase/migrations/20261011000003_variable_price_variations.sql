-- ============================================================================
-- ONE ITEM, SEVERAL PRICES, ONE ORDER
-- ============================================================================
-- A customer buying kelewele at GH₵10 once and at GH₵20 twice is buying two
-- different things from the same catalogue item. order_items has always been
-- able to hold that — it has no uniqueness on (order_id, menu_item_id), and
-- every line carries its own unit_price_pesewas snapshot — but price_order()
-- and submit_order_for() refused any menu_item_id that appeared twice, with
-- "appears more than once; send a single line with a quantity".
--
-- That rule was right for a fixed item and is kept for one: a fixed price has
-- one line with a quantity. For a variable item the line is now identified by
-- the item AND its chosen price, so different prices coexist and the same price
-- twice is still refused (the basket sends it once, with a quantity).
--
-- NO SCHEMA CHANGE. Only these two function bodies, each otherwise identical to
-- 20261011000001: every line is still priced by menu_item_unit_price(), checked
-- against the store's capability and the item's current rule, snapshotted onto
-- order_items, and summed on the server.
-- ============================================================================


create or replace function public.price_order(p_vendor_id uuid, p_items jsonb)
returns table(subtotal_pesewas bigint, service_fee_pesewas bigint, total_pesewas bigint, lines jsonb)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_unit     bigint;
  v_seen     text[] := '{}';
  v_key      text;
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
       and is_available
       -- ON THE ACTIVE MENU. A catalogue item the store has turned OFF is not
       -- being offered at all, and a browser that still shows it is stale.
       and is_active;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;


    -- THE UNIT PRICE: the fixed price, or the customer's chosen amount once it
    -- has been checked against the item's rule.
    v_unit := public.menu_item_unit_price(v_menu, v_item);

    -- ONE LINE PER THING BOUGHT. A fixed item is one thing, so it appears once
    -- with a quantity, exactly as before. A variable item bought at two prices
    -- is two things — GH₵10 of kelewele and GH₵20 of kelewele — so the line is
    -- the item AND its price, and only the same item at the same price twice
    -- is refused. Checked after the price, which is what makes it a key.
    v_key := case when v_menu.pricing_mode = 'FIXED' then v_menu.id::text
                  else v_menu.id::text || '@' || v_unit::text end;
    if v_key = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_key;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_unit,
      'quantity',           v_qty,
      'line_total_pesewas', v_unit * v_qty
    );

    v_subtotal := v_subtotal + (v_unit * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. UNCHANGED, and
  -- deliberately restated rather than refactored away: this expression is the
  -- platform's entire revenue model and it should be readable in one place.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;

  return query select v_subtotal, v_service, v_subtotal + v_service, v_lines;
end;
$$;


create or replace function public.submit_order_for(
  p_customer_id uuid,
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note text default null,
  p_order_note text default null
)
returns table(order_id uuid, order_number text, vendor_order_no integer, total_pesewas bigint)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_no       integer;
  v_day      date := (now() at time zone 'UTC')::date;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_total    bigint;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_unit     bigint;
  v_seen     text[] := '{}';
  v_key      text;
  v_note     text := nullif(btrim(coalesce(p_order_note, '')), '');
  v_extra    text := nullif(btrim(coalesce(p_destination_note, '')), '');
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

  -- A CLOSED store takes no new orders. Orders already in the kitchen are
  -- untouched by closing: this guards submission and nothing else.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  if length(v_note) > 280 then
    raise exception 'keep the order information under 280 characters' using errcode = 'check_violation';
  end if;
  if length(v_extra) > 280 then
    raise exception 'keep the additional information under 280 characters' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    -- THE GLOBAL SWITCH, checked at submission and nowhere else that matters.
    -- Turning Partner delivery off stops NEW delivery orders. It does not
    -- reach an order somebody has already paid for, and must not.
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'partner delivery is unavailable right now; choose pickup'
        using errcode = 'check_violation';
    end if;
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
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  v_no := public.next_vendor_order_no(p_vendor_id, v_day);

  -- ONE ORDER, ONE VENDOR. Enforced by the column: there is no basket spanning
  -- two kitchens and no way to express one.
  --
  -- ACCEPTED at birth. The state name is inherited and now means "priced and
  -- payable" — there is nobody left to accept anything. accept_deadline_at is
  -- reused as the PAY-BY deadline, so an order nobody pays for is swept rather
  -- than sitting in the customer's list for ever.
  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accepted_at, accept_deadline_at,
    order_day, vendor_order_no
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'ACCEPTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    -- ADDITIONAL INFORMATION is for the Partner, so it is kept only when there
    -- is one. On a collection nobody would ever read it.
    case when p_fulfilment_type = 'DELIVERY' then v_extra end,
    v_zone,
    0, 0, v_delivery, v_earnings, v_delivery,
    'NONE', now(), now(),
    now() + make_interval(secs => v_cfg.payment_pending_timeout_seconds),
    v_day, v_no
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
       and is_available
       -- ON THE ACTIVE MENU. A catalogue item the store has turned OFF is not
       -- being offered at all, and a browser that still shows it is stale.
       and is_active;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;


    -- THE UNIT PRICE: the fixed price, or the customer's chosen amount once it
    -- has been checked against the item's rule and the store's capability, in
    -- this transaction. A basket built before either changed is refused here.
    v_unit := public.menu_item_unit_price(v_menu, v_item);

    -- ONE LINE PER THING BOUGHT. A fixed item is one thing, so it appears once
    -- with a quantity, exactly as before. A variable item bought at two prices
    -- is two things — GH₵10 of kelewele and GH₵20 of kelewele — so the line is
    -- the item AND its price, and only the same item at the same price twice
    -- is refused. Checked after the price, which is what makes it a key.
    v_key := case when v_menu.pricing_mode = 'FIXED' then v_menu.id::text
                  else v_menu.id::text || '@' || v_unit::text end;
    if v_key = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_key;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_unit, v_qty, v_unit * v_qty
    );

    v_subtotal := v_subtotal + (v_unit * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. The delivery fee is not
  -- in the base: the service fee is a share of what the food costs.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  -- ORDER INFORMATION, for the store. Written in the same transaction as the
  -- order, so it exists before a payment can even be created and the store
  -- never opens an order whose note is still on its way.
  if v_note is not null then
    insert into public.order_notes (order_id, body) values (v_order_id, v_note);
  end if;

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'ACCEPTED',
    null, jsonb_build_object(
      'total_pesewas', v_total,
      'item_count', jsonb_array_length(p_items),
      'fulfilment_type', p_fulfilment_type::text,
      'vendor_order_no', v_no)
  );

  return query select v_order_id, v_number, v_no, v_total;
end;
$$;
