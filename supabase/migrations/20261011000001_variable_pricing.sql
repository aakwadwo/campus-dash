-- ============================================================================
-- A PRICE THE CUSTOMER CHOOSES
-- ============================================================================
-- Some things are sold by the amount somebody wants to spend. Kelewele is the
-- example. An item is priced in one of three ways, named by pricing_mode:
--
--   FIXED    price_pesewas. Every item before this migration, unchanged.
--
--   STEPPED  a RULE, because a list of every price would have no end:
--              variable_min_pesewas    the starting price, and the first valid one
--              variable_step_pesewas   how far apart the valid prices are
--              variable_max_pesewas    the highest valid price, or NULL for none
--            p is valid when  p >= min  AND  (p - min) % step = 0  AND, when a
--            maximum is set,  p <= max.  GH₵10, 15, 20 … or GH₵10, 15, 20, 25.
--
--   CHOICES  a LIST, for prices that follow no pattern:
--              variable_choices_pesewas   e.g. {1000, 1500, 3000, 5000}
--            p is valid when it is one of them. Not expressed as a rule: GH₵10,
--            15, 30, 50 has no step, and forcing one onto it would invent
--            prices the store never offered.
--
-- STEPPED and CHOICES are both "variable": the customer chooses the unit price.
-- Nothing is rounded to fit. An amount that breaks the item's rule is refused,
-- because a price that moves after the customer chose it is a price they did
-- not agree to.
--
-- WHO MAY USE IT. It is a capability Campus Dash grants per store:
-- vendors.can_use_variable_pricing, written by admin_set_vendor_variable_pricing()
-- and by nothing else, audited like every administrator change. With it, the
-- store chooses which of ITS OWN items are variable; every other item stays
-- FIXED, and every existing item is FIXED after this migration.
--
-- TURNING THE CAPABILITY OFF DELETES NOTHING. The items keep pricing_mode,
-- its rule or its list, dormant. While the store lacks the
-- capability a variable item is not sold at all — not at its minimum, not at
-- price_pesewas, not at anything — and it is hidden from the storefront by
-- the public read policy. Turning it back on restores exactly what was there.
--
-- THE SERVER PRICES EVERY LINE. The basket sends a chosen unit price for a
-- variable item and nothing for a FIXED one. menu_item_unit_price() is the one
-- place that decides whether that number is acceptable, and price_order() and
-- submit_order_for() both call it, so the quote and the charge cannot disagree.
-- The chosen price is snapshotted onto order_items exactly as a fixed price is;
-- nothing downstream (fees, payment, allocation, settlement) reads the menu.
--
-- NEVER WITH A MEAL SCAN. A scan's value is the store's fixed price for food
-- Campus Dash did not sell; a customer-chosen amount has no place in it. A
-- table constraint makes a variable mode and scan_eligible mutually exclusive, and
-- price_scan_order() already requires scan_eligible, so it is untouched.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE STORE'S CAPABILITY
-- ---------------------------------------------------------------------------

alter table public.vendors
  add column if not exists can_use_variable_pricing boolean not null default false;

comment on column public.vendors.can_use_variable_pricing is
  'Whether this store may sell items at a price the customer chooses. Set by an administrator only, through admin_set_vendor_variable_pricing(). Turning it off preserves every item''s variable configuration, dormant and unsellable, until it is turned back on.';


-- ---------------------------------------------------------------------------
-- 2. THE ITEM'S RULE
-- ---------------------------------------------------------------------------
-- An explicit mode rather than "a null price means variable": the configuration
-- survives a switch back to FIXED, and price_pesewas stays the fixed price it
-- always was.

alter table public.menu_items
  add column if not exists pricing_mode text not null default 'FIXED',
  add column if not exists variable_min_pesewas bigint,
  add column if not exists variable_step_pesewas bigint,
  add column if not exists variable_max_pesewas bigint,
  add column if not exists variable_choices_pesewas bigint[];

alter table public.menu_items drop constraint if exists menu_items_pricing_mode_check;
alter table public.menu_items add constraint menu_items_pricing_mode_check
  check (pricing_mode in ('FIXED', 'STEPPED', 'CHOICES'));

-- Every stored part of the rule is positive and consistent, whatever the mode:
-- a dormant configuration is still one that would be valid if switched on.
alter table public.menu_items drop constraint if exists menu_items_variable_rule_shape;
alter table public.menu_items add constraint menu_items_variable_rule_shape
  check (
    (variable_min_pesewas is null or variable_min_pesewas > 0)
    and (variable_step_pesewas is null or variable_step_pesewas > 0)
    and (
      variable_max_pesewas is null
      or (
        variable_min_pesewas is not null
        and variable_step_pesewas is not null
        and variable_max_pesewas >= variable_min_pesewas
        and (variable_max_pesewas - variable_min_pesewas) % variable_step_pesewas = 0
      )
    )
  );

-- A list of one to twenty positive prices, no gaps. assert_price_choices()
-- also refuses duplicates and stores it ascending; that needs a subquery a
-- CHECK cannot hold, so it lives in the only two functions that write it.
alter table public.menu_items drop constraint if exists menu_items_price_choices_shape;
alter table public.menu_items add constraint menu_items_price_choices_shape
  check (
    variable_choices_pesewas is null
    or (
      cardinality(variable_choices_pesewas) between 1 and 20
      and array_position(variable_choices_pesewas, null) is null
      and 0 < all (variable_choices_pesewas)
    )
  );

alter table public.menu_items drop constraint if exists menu_items_variable_is_configured;
alter table public.menu_items add constraint menu_items_variable_is_configured
  check (
    pricing_mode = 'FIXED'
    or (pricing_mode = 'STEPPED'
        and variable_min_pesewas is not null and variable_step_pesewas is not null)
    or (pricing_mode = 'CHOICES' and variable_choices_pesewas is not null)
  );

alter table public.menu_items drop constraint if exists menu_items_variable_is_not_scan;
alter table public.menu_items add constraint menu_items_variable_is_not_scan
  check (pricing_mode = 'FIXED' or not scan_eligible);

comment on column public.menu_items.pricing_mode is
  'FIXED: sold at price_pesewas. STEPPED: the customer chooses the unit price, from variable_min_pesewas in steps of variable_step_pesewas up to variable_max_pesewas (or without limit when that is null). CHOICES: the customer chooses one of variable_choices_pesewas. STEPPED and CHOICES are sellable only while vendors.can_use_variable_pricing is true, and are never scan_eligible.';

comment on column public.menu_items.variable_min_pesewas is
  'The starting price of a STEPPED item, and the first valid one. Kept when the item returns to FIXED or the store loses the capability.';

comment on column public.menu_items.variable_step_pesewas is
  'The distance between valid prices of a STEPPED item. A chosen price p is valid when (p - min) is an exact multiple of this. Never rounded to.';

comment on column public.menu_items.variable_max_pesewas is
  'The highest valid price of a STEPPED item, itself on a step. NULL means there is no ceiling.';

comment on column public.menu_items.variable_choices_pesewas is
  'The exact prices of a CHOICES item, ascending, each once. Nothing between or beyond them is valid. Kept when the item changes mode or the store loses the capability.';


-- ---------------------------------------------------------------------------
-- 3. WHAT A VISITOR CAN SEE
-- ---------------------------------------------------------------------------
-- Narrower than before and never wider: a variable item at a store without the
-- capability is dormant, and a dormant item is not on the storefront or in the
-- marketplace search. The store still reads it through menu_items_read_own and
-- vendor_menu(); an administrator through menu_items_read_admin.

drop policy if exists menu_items_read_public on public.menu_items;
create policy menu_items_read_public on public.menu_items
  for select to authenticated, anon
  using (
    is_active
    and exists (
      select 1 from public.vendors v
       where v.id = menu_items.vendor_id
         and v.status = 'ACTIVE'
         and (menu_items.pricing_mode = 'FIXED' or v.can_use_variable_pricing)
    )
  );


-- ---------------------------------------------------------------------------
-- 4. THE ADMINISTRATOR'S SWITCH
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_vendor_variable_pricing(
  p_vendor_id uuid,
  p_enabled boolean,
  p_reason text
)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_enabled is null then
    raise exception 'say whether the store may use customer-chosen prices'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  -- THE STORE'S ROW ONLY. No item is touched either way: switching off leaves
  -- every configuration where it is, dormant, and switching on brings it back.
  update public.vendors
     set can_use_variable_pricing = p_enabled,
         updated_at = now()
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_VARIABLE_PRICING_SET', 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

comment on function public.admin_set_vendor_variable_pricing(uuid, boolean, text) is
  'The only writer of vendors.can_use_variable_pricing. Administrator only, re-checked in the body, audited. Touches no menu item: a disabled store''s variable items stay configured and dormant.';

revoke all on function public.admin_set_vendor_variable_pricing(uuid, boolean, text) from public, anon;
grant execute on function public.admin_set_vendor_variable_pricing(uuid, boolean, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. THE RULE, CHECKED IN ONE PLACE EACH WAY ROUND
-- ---------------------------------------------------------------------------

-- What a STORE may configure. Raises; called by the two item writers.
create or replace function public.assert_variable_price_rule(
  p_min bigint,
  p_step bigint,
  p_max bigint
)
returns void
language plpgsql
immutable
set search_path to ''
as $$
begin
  if p_min is null or p_min <= 0 then
    raise exception 'give the item a starting price' using errcode = 'check_violation';
  end if;
  -- The same typo guard a fixed price has. It bounds what the STORE types as a
  -- starting point and a step, never what a customer may choose above it.
  if p_min > 100000 then
    raise exception 'that starting price looks wrong — the most it can be is GHS 1000'
      using errcode = 'check_violation';
  end if;
  if p_step is null or p_step <= 0 then
    raise exception 'give the item a price step' using errcode = 'check_violation';
  end if;
  if p_step > 100000 then
    raise exception 'that price step looks wrong — the most it can be is GHS 1000'
      using errcode = 'check_violation';
  end if;
  if p_max is not null and (p_max < p_min or (p_max - p_min) % p_step <> 0) then
    raise exception 'the maximum price must be one of the prices the steps reach'
      using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.assert_variable_price_rule(bigint, bigint, bigint) from public, anon, authenticated;

-- A store's list of exact prices. Raises on a bad one; returns it ascending,
-- because order is presentation and the store typed a set.
create or replace function public.assert_price_choices(p_choices bigint[])
returns bigint[]
language plpgsql
immutable
set search_path to ''
as $$
declare
  v_sorted bigint[];
begin
  if p_choices is null or cardinality(p_choices) = 0 then
    raise exception 'give the item at least one price' using errcode = 'check_violation';
  end if;
  if cardinality(p_choices) > 20 then
    raise exception 'an item can have at most 20 prices' using errcode = 'check_violation';
  end if;
  if array_position(p_choices, null) is not null or not (0 < all (p_choices)) then
    raise exception 'give the item a price' using errcode = 'check_violation';
  end if;
  if not (100000 >= all (p_choices)) then
    raise exception 'that price looks wrong — the most an item can cost is GHS 1000'
      using errcode = 'check_violation';
  end if;

  select array_agg(c order by c) into v_sorted from unnest(p_choices) c;
  if cardinality(v_sorted) <> (select count(distinct c) from unnest(p_choices) c) then
    raise exception 'each price can be listed once' using errcode = 'check_violation';
  end if;

  return v_sorted;
end;
$$;

revoke all on function public.assert_price_choices(bigint[]) from public, anon, authenticated;

-- What a CUSTOMER may pay for one unit of one line. Raises on anything else.
--
-- p_line is the basket line as sent: { menu_item_id, quantity,
-- unit_price_pesewas? }. The price is honoured only for a variable item at a
-- store that holds the capability, and only if it is exactly on the rule. A
-- price sent for a FIXED item is IGNORED, exactly as it always has been: the
-- fixed price is charged, and the checkout shows the server's quote.
create or replace function public.menu_item_unit_price(
  p_item public.menu_items,
  p_line jsonb
)
returns bigint
language plpgsql
stable
set search_path to ''
as $$
declare
  v_raw    jsonb := p_line -> 'unit_price_pesewas';
  v_sent   boolean := v_raw is not null and jsonb_typeof(v_raw) <> 'null';
  v_amount numeric;
begin
  -- UNCHANGED FOR A FIXED ITEM: the menu price, whatever the request says.
  if p_item.pricing_mode = 'FIXED' then
    return p_item.price_pesewas;
  end if;

  -- DORMANT. The store has lost the capability since this was put in a basket:
  -- the item is not for sale at any price, including the one the basket kept.
  if not exists (
    select 1 from public.vendors
     where id = p_item.vendor_id and can_use_variable_pricing
  ) then
    raise exception 'menu item % is unavailable', p_item.id using errcode = 'check_violation';
  end if;

  if not v_sent or jsonb_typeof(v_raw) <> 'number' then
    raise exception 'choose an amount for %', p_item.name using errcode = 'check_violation';
  end if;

  v_amount := (v_raw #>> '{}')::numeric;

  -- WHOLE PESEWAS, ON THE ITEM'S OWN RULE, OR REFUSED. Never rounded,
  -- snapped or clamped to the nearest valid price.
  if v_amount <> trunc(v_amount) then
    raise exception 'the amount for % is not one of its prices', p_item.name
      using errcode = 'check_violation';
  end if;

  if p_item.pricing_mode = 'CHOICES' then
    if not (v_amount = any (p_item.variable_choices_pesewas::numeric[])) then
      raise exception 'the amount for % is not one of its prices', p_item.name
        using errcode = 'check_violation';
    end if;
  elsif v_amount < p_item.variable_min_pesewas
     or (p_item.variable_max_pesewas is not null and v_amount > p_item.variable_max_pesewas)
     or mod(v_amount - p_item.variable_min_pesewas, p_item.variable_step_pesewas) <> 0
  then
    raise exception 'the amount for % is not one of its prices', p_item.name
      using errcode = 'check_violation';
  end if;

  -- No business ceiling without a maximum, only what the column can hold.
  if v_amount > 92233720368547758 then
    raise exception 'the amount for % is not one of its prices', p_item.name
      using errcode = 'check_violation';
  end if;

  return v_amount::bigint;
end;
$$;

revoke all on function public.menu_item_unit_price(public.menu_items, jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. PRICING AND SUBMISSION: THE LINE PRICE COMES FROM THE RULE
-- ---------------------------------------------------------------------------
-- Both bodies are unchanged except that the unit price is menu_item_unit_price()
-- rather than v_menu.price_pesewas. For a FIXED item that is the same number.

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
       and is_available
       -- ON THE ACTIVE MENU. A catalogue item the store has turned OFF is not
       -- being offered at all, and a browser that still shows it is stale.
       and is_active;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    -- THE UNIT PRICE: the fixed price, or the customer's chosen amount once it
    -- has been checked against the item's rule.
    v_unit := public.menu_item_unit_price(v_menu, v_item);

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
  v_seen     uuid[] := '{}';
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

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    -- THE UNIT PRICE: the fixed price, or the customer's chosen amount once it
    -- has been checked against the item's rule and the store's capability, in
    -- this transaction. A basket built before either changed is refused here.
    v_unit := public.menu_item_unit_price(v_menu, v_item);

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


-- ---------------------------------------------------------------------------
-- 7. THE STORE'S ITEM WRITERS
-- ---------------------------------------------------------------------------
-- Three optional arguments on each, appended so every existing call reads the
-- same. On update, null means "leave it", exactly as the other arguments do.
--
-- CHOOSING VARIABLE, OR CHANGING ITS RULE, needs the capability — for an
-- administrator too, because the capability is the decision and editing an
-- item is not the place to overrule it. Returning an item to FIXED never does:
-- leaving variable pricing is always allowed.

drop function if exists public.vendor_create_menu_item(uuid, text, bigint, text, boolean);

create or replace function public.vendor_create_menu_item(
  p_vendor_id uuid,
  p_name text,
  p_price_pesewas bigint,
  p_description text default null,
  p_scan_eligible boolean default false,
  p_pricing_mode text default 'FIXED',
  p_variable_min_pesewas bigint default null,
  p_variable_step_pesewas bigint default null,
  p_variable_max_pesewas bigint default null,
  p_variable_choices_pesewas bigint[] default null
)
returns public.menu_items
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
  v_choices bigint[];
  v_next integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_mode text := coalesce(p_pricing_mode, 'FIXED');
  v_price bigint := p_price_pesewas;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if v_mode not in ('FIXED', 'STEPPED', 'CHOICES') then
    raise exception 'an item is sold at a set price or a price the customer chooses'
      using errcode = 'check_violation';
  end if;

  if v_name is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;
  if length(v_name) > 120 then
    raise exception 'keep the name under 120 characters' using errcode = 'check_violation';
  end if;

  if v_mode <> 'FIXED' then
    if not exists (
      select 1 from public.vendors where id = p_vendor_id and can_use_variable_pricing
    ) then
      raise exception 'customer-chosen prices are not enabled for this store'
        using errcode = 'insufficient_privilege';
    end if;
    if coalesce(p_scan_eligible, false) then
      raise exception 'an item with a customer-chosen price cannot take meal scans'
        using errcode = 'check_violation';
    end if;
    -- price_pesewas is the FIXED price, and an item created variable has not
    -- had one. Its lowest price is the honest placeholder should it ever be
    -- switched to fixed without a new one.
    if v_mode = 'STEPPED' then
      perform public.assert_variable_price_rule(
        p_variable_min_pesewas, p_variable_step_pesewas, p_variable_max_pesewas);
      v_price := coalesce(v_price, p_variable_min_pesewas);
    else
      v_choices := public.assert_price_choices(p_variable_choices_pesewas);
      v_price := coalesce(v_price, v_choices[1]);
    end if;
  end if;

  -- MONEY IS INTEGER PESEWAS. A caller sending 35.50 is a bug, not a rounding
  -- opportunity, so it is refused rather than truncated.
  if v_price is null or v_price <= 0 then
    raise exception 'give the item a price' using errcode = 'check_violation';
  end if;
  if v_price > 100000 then
    raise exception 'that price looks wrong — the most an item can cost is GHS 1000'
      using errcode = 'check_violation';
  end if;

  -- A menu, not a catalogue. Sixty is more than any pilot store will use and
  -- small enough that the storefront stays a page.
  if (select count(*) from public.menu_items where vendor_id = p_vendor_id) >= 60 then
    raise exception 'a store may have at most 60 items; delete one first'
      using errcode = 'check_violation';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_next
    from public.menu_items where vendor_id = p_vendor_id;

  insert into public.menu_items (
    vendor_id, name, description, price_pesewas, sort_order, scan_eligible,
    pricing_mode, variable_min_pesewas, variable_step_pesewas, variable_max_pesewas,
    variable_choices_pesewas
  )
  values (
    p_vendor_id, v_name, nullif(btrim(coalesce(p_description, '')), ''),
    v_price, v_next, coalesce(p_scan_eligible, false),
    v_mode,
    case when v_mode = 'STEPPED' then p_variable_min_pesewas end,
    case when v_mode = 'STEPPED' then p_variable_step_pesewas end,
    case when v_mode = 'STEPPED' then p_variable_max_pesewas end,
    v_choices
  )
  returning * into v_item;

  return v_item;
end;
$$;

revoke all on function public.vendor_create_menu_item(uuid, text, bigint, text, boolean, text, bigint, bigint, bigint, bigint[]) from public, anon;
grant execute on function public.vendor_create_menu_item(uuid, text, bigint, text, boolean, text, bigint, bigint, bigint, bigint[]) to authenticated, service_role;


drop function if exists public.vendor_update_menu_item(uuid, text, bigint, text, boolean);

-- p_clear_variable_max: the one change "null means leave it" cannot express —
-- going from a limited range back to no ceiling.
create or replace function public.vendor_update_menu_item(
  p_menu_item_id uuid,
  p_name text default null,
  p_price_pesewas bigint default null,
  p_description text default null,
  p_scan_eligible boolean default null,
  p_pricing_mode text default null,
  p_variable_min_pesewas bigint default null,
  p_variable_step_pesewas bigint default null,
  p_variable_max_pesewas bigint default null,
  p_clear_variable_max boolean default false,
  p_variable_choices_pesewas bigint[] default null
)
returns public.menu_items
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
  v_mode text;
  v_min  bigint;
  v_step bigint;
  v_max  bigint;
  v_choices bigint[];
  v_scan boolean;
  v_rule_touched boolean;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if p_pricing_mode is not null and p_pricing_mode not in ('FIXED', 'STEPPED', 'CHOICES') then
    raise exception 'an item is sold at a set price or a price the customer chooses'
      using errcode = 'check_violation';
  end if;

  if p_price_pesewas is not null and (p_price_pesewas <= 0 or p_price_pesewas > 100000) then
    raise exception 'give the item a sensible price' using errcode = 'check_violation';
  end if;
  if p_name is not null and nullif(btrim(p_name), '') is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;

  v_mode := coalesce(p_pricing_mode, v_item.pricing_mode);
  v_min  := coalesce(p_variable_min_pesewas, v_item.variable_min_pesewas);
  v_step := coalesce(p_variable_step_pesewas, v_item.variable_step_pesewas);
  v_max  := case when coalesce(p_clear_variable_max, false) then null
                 else coalesce(p_variable_max_pesewas, v_item.variable_max_pesewas) end;
  v_choices := coalesce(p_variable_choices_pesewas, v_item.variable_choices_pesewas);
  v_scan := coalesce(p_scan_eligible, v_item.scan_eligible);

  -- CONFIGURING variable pricing: choosing it, or changing any part of its
  -- rule or its list. A store without the capability can do neither, however
  -- the request was built. Choosing FIXED is not configuring it and is always
  -- allowed.
  v_rule_touched := coalesce(p_pricing_mode in ('STEPPED', 'CHOICES'), false)
    or p_variable_min_pesewas is not null
    or p_variable_step_pesewas is not null
    or p_variable_max_pesewas is not null
    or p_variable_choices_pesewas is not null
    or coalesce(p_clear_variable_max, false);

  if v_rule_touched and not exists (
    select 1 from public.vendors where id = v_item.vendor_id and can_use_variable_pricing
  ) then
    raise exception 'customer-chosen prices are not enabled for this store'
      using errcode = 'insufficient_privilege';
  end if;

  if v_mode = 'STEPPED' then
    perform public.assert_variable_price_rule(v_min, v_step, v_max);
  elsif v_mode = 'CHOICES' then
    v_choices := public.assert_price_choices(v_choices);
  end if;

  if v_mode <> 'FIXED' then
    if v_scan then
      raise exception 'an item with a customer-chosen price cannot take meal scans'
        using errcode = 'check_violation';
    end if;
  end if;

  -- A PRICE CHANGE REACHES NO EXISTING ORDER. price_order() snapshots every
  -- figure onto the order at submission and order_items keeps its own copy, so
  -- this moves what the NEXT customer is quoted and nothing else. That is the
  -- whole reason a store can be trusted with its own prices.
  --
  -- The variable rule is written only when it was touched, so an edit to a
  -- dormant item's name leaves its configuration exactly as it was.
  update public.menu_items m
     set name = coalesce(nullif(btrim(p_name), ''), m.name),
         price_pesewas = coalesce(p_price_pesewas, m.price_pesewas),
         description = case
           when p_description is null then m.description
           else nullif(btrim(p_description), '') end,
         scan_eligible = v_scan,
         pricing_mode = v_mode,
         variable_min_pesewas = case when v_rule_touched then v_min else m.variable_min_pesewas end,
         variable_step_pesewas = case when v_rule_touched then v_step else m.variable_step_pesewas end,
         variable_max_pesewas = case when v_rule_touched then v_max else m.variable_max_pesewas end,
         variable_choices_pesewas = case when v_rule_touched then v_choices else m.variable_choices_pesewas end,
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;

revoke all on function public.vendor_update_menu_item(uuid, text, bigint, text, boolean, text, bigint, bigint, bigint, boolean, bigint[]) from public, anon;
grant execute on function public.vendor_update_menu_item(uuid, text, bigint, text, boolean, text, bigint, bigint, bigint, boolean, bigint[]) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 8. A DORMANT ITEM CANNOT BE PUT ON THE MENU
-- ---------------------------------------------------------------------------
-- Turning it on would open the store around something no customer can see or
-- buy. Turning it OFF is always allowed. Otherwise unchanged.

create or replace function public.vendor_set_menu_item_active(p_menu_item_id uuid, p_active boolean)
returns table(menu_item_id uuid, name text, is_active boolean, store_open boolean)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
  v_open boolean;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if p_active and v_item.pricing_mode <> 'FIXED' and not exists (
    select 1 from public.vendors where id = v_item.vendor_id and can_use_variable_pricing
  ) then
    raise exception 'customer-chosen prices are not enabled for this store'
      using errcode = 'insufficient_privilege';
  end if;

  -- THE VENDOR ROW FIRST, ALWAYS IN THAT ORDER. Every function that can move
  -- the store or the menu takes this lock before it reads the count, so two
  -- toggles arriving together cannot both see "one other item is still on".
  perform 1 from public.vendors where id = v_item.vendor_id for update;

  update public.menu_items m
     set is_active = p_active, updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  v_open := public.vendor_apply_menu_state(v_item.vendor_id);

  return query select v_item.id, v_item.name, v_item.is_active, v_open;
end;
$$;


-- ---------------------------------------------------------------------------
-- 9. THE STORE'S OWN READS CARRY THE NEW FACTS
-- ---------------------------------------------------------------------------
-- Columns appended, so nothing that reads the old ones by name changes.

drop function if exists public.vendor_menu(uuid);

create or replace function public.vendor_menu(p_vendor_id uuid)
returns table(
  id uuid,
  name text,
  description text,
  price_pesewas bigint,
  is_active boolean,
  is_available boolean,
  unavailable_reason text,
  scan_eligible boolean,
  image_path text,
  sort_order integer,
  order_count bigint,
  pricing_mode text,
  variable_min_pesewas bigint,
  variable_step_pesewas bigint,
  variable_max_pesewas bigint,
  variable_choices_pesewas bigint[]
)
language sql
stable
security definer
set search_path to ''
as $$
  select m.id, m.name, m.description, m.price_pesewas,
         m.is_active, m.is_available, m.unavailable_reason, m.scan_eligible,
         m.image_path, m.sort_order,
         -- WHETHER IT CAN BE DELETED, answered on the row rather than by
         -- letting somebody press Delete and read an error. An item any order
         -- references is turned off, never removed.
         (select count(*) from public.order_items oi where oi.menu_item_id = m.id),
         m.pricing_mode, m.variable_min_pesewas, m.variable_step_pesewas, m.variable_max_pesewas,
         m.variable_choices_pesewas
    from public.menu_items m
   where m.vendor_id = p_vendor_id
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   -- NEWEST FIRST, AND NEVER BY WHETHER IT IS ON.
   order by m.created_at desc, m.sort_order, m.name, m.id;
$$;

revoke all on function public.vendor_menu(uuid) from public, anon;
grant execute on function public.vendor_menu(uuid) to authenticated, service_role;


drop function if exists public.my_vendor_application();

create or replace function public.my_vendor_application()
returns table(
  vendor_id uuid,
  name text,
  status public.vendor_status,
  description text,
  category_id uuid,
  category_name text,
  applicant_name text,
  owner_is_student boolean,
  is_accepting_orders boolean,
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  location_id uuid,
  location_note text,
  walk_minutes_to_campus integer,
  can_accept_scans boolean,
  can_use_variable_pricing boolean
)
language sql
stable
security definer
set search_path to ''
as $$
  select v.id, v.name, v.status, v.description, v.category_id, k.name,
         v.applicant_name, v.owner_is_student, v.is_accepting_orders,
         v.rejection_reason, v.submitted_at, v.reviewed_at,
         v.location_id, v.location_note, v.walk_minutes_to_campus,
         v.can_accept_scans,
         v.can_use_variable_pricing
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.owner_user_id = auth.uid();
$$;

revoke all on function public.my_vendor_application() from public, anon;
grant execute on function public.my_vendor_application() to authenticated, service_role;
