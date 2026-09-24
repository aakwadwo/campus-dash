-- ============================================================================
-- CUSTOMER-CHOSEN PRICES: A TECHNICAL CEILING, AND AN HONEST OPEN SIGN
-- ============================================================================
-- Two corrections to 20261011000001_variable_pricing.
--
-- 1. THE CEILING. "Unlimited" meant the store set no maximum, and it also
--    meant a customer could type any amount at all and find out at Paystack.
--    Every price on Campus Dash already has one technical ceiling: a fixed item
--    cannot cost more than GHS 1000 (vendor_create_menu_item() and
--    vendor_update_menu_item() have refused it since the store took over its
--    own menu). A customer-chosen unit price now meets the same ceiling, in the
--    same place it is checked, so an absurd amount is refused with a sentence
--    before an order or a charge exists.
--
--    It is the PLATFORM's ceiling, not the item's. A stepped item with no
--    maximum still has no maximum of its own: its prices go up in steps until
--    the most any item on Campus Dash can cost. A store-set maximum, and every
--    price in a list, must sit at or under it too, so no item can be configured
--    to offer a price that would then be refused.
--
-- 2. THE OPEN SIGN. A store is open if and only if it is ACTIVE and has an item
--    on its menu. A variable item at a store that has lost the capability is on
--    the menu and invisible, so a store whose only active items were those
--    showed OPEN over an empty menu. "An item on the menu" now means one a
--    customer can actually order. Nothing about the item is changed: it stays
--    ON, keeps its rule, and counts again the moment the capability returns.
--    The administrator's switch re-applies the store's state, which is the only
--    new moment the answer can change.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE CEILING, IN ONE PLACE
-- ---------------------------------------------------------------------------

create or replace function public.max_item_price_pesewas()
returns bigint
language sql
immutable
set search_path to ''
as $$
  -- GHS 1000. The same figure the fixed-price writers refuse above.
  select 100000::bigint;
$$;

comment on function public.max_item_price_pesewas() is
  'The most one unit of any item can cost, in pesewas. A technical ceiling for the whole platform, not a price any store chose. Equal to the limit vendor_create_menu_item() and vendor_update_menu_item() place on a fixed price.';

revoke all on function public.max_item_price_pesewas() from public, anon, authenticated;


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
  if p_min > public.max_item_price_pesewas() then
    raise exception 'that starting price looks wrong — the most it can be is GHS 1000'
      using errcode = 'check_violation';
  end if;
  if p_step is null or p_step <= 0 then
    raise exception 'give the item a price step' using errcode = 'check_violation';
  end if;
  if p_step > public.max_item_price_pesewas() then
    raise exception 'that price step looks wrong — the most it can be is GHS 1000'
      using errcode = 'check_violation';
  end if;
  if p_max is not null and (p_max < p_min or (p_max - p_min) % p_step <> 0) then
    raise exception 'the maximum price must be one of the prices the steps reach'
      using errcode = 'check_violation';
  end if;
  -- A maximum above the ceiling would promise prices the checkout refuses.
  if p_max is not null and p_max > public.max_item_price_pesewas() then
    raise exception 'that maximum price looks wrong — the most it can be is GHS 1000'
      using errcode = 'check_violation';
  end if;
end;
$$;


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

  -- ABOVE WHAT ANY ITEM CAN COST. Checked before the rule, so an absurd number
  -- is told the one thing that is wrong with it, and never reaches a charge.
  if v_amount > public.max_item_price_pesewas() then
    raise exception 'the amount for % is more than any item can cost', p_item.name
      using errcode = 'check_violation';
  end if;

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

  return v_amount::bigint;
end;
$$;

revoke all on function public.menu_item_unit_price(public.menu_items, jsonb) from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. OPEN MEANS SOMETHING CAN BE ORDERED
-- ---------------------------------------------------------------------------

create or replace function public.vendor_apply_menu_state(p_vendor_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_vendor public.vendors%rowtype;
  v_open   boolean;
begin
  select * into v_vendor from public.vendors where id = p_vendor_id for update;
  if not found then
    return false;
  end if;

  -- A store that is not ACTIVE is not open, whatever its menu says. An
  -- applicant may build a catalogue while they wait; it sells nothing.
  --
  -- AN ITEM A CUSTOMER CAN ORDER. A variable item at a store without the
  -- capability is on the menu and hidden from everybody, so it does not hold
  -- the store open. It stays on, and counts again when the capability returns.
  v_open := v_vendor.status = 'ACTIVE' and exists (
    select 1 from public.menu_items m
     where m.vendor_id = p_vendor_id and m.is_active
       and (m.pricing_mode = 'FIXED' or v_vendor.can_use_variable_pricing)
  );

  if v_open is distinct from v_vendor.is_accepting_orders then
    update public.vendors set is_accepting_orders = v_open where id = p_vendor_id;

    -- CLOSED → OPEN CLEARS EVERY SOLD-OUT MARK, and only those. Running out of
    -- jollof is a fact about a service and clears itself with the service;
    -- being off the menu is a decision and is not touched here. Guarded on the
    -- transition, so turning a fourth item on while already open leaves a mark
    -- somebody set a minute ago alone.
    if v_open then
      update public.menu_items
         set is_available = true, unavailable_reason = null
       where vendor_id = p_vendor_id and not is_available;
    end if;
  end if;

  return v_open;
end;
$$;

comment on function public.vendor_apply_menu_state(uuid) is
  'Makes vendors.is_accepting_orders agree with the active menu: open if and only if the store is ACTIVE and at least one item is ON that a customer can order — a variable item counts only while the store holds can_use_variable_pricing. Internal — every caller has already authorised the move and locked the vendor row. A CLOSED → OPEN transition here clears sold-out marks, exactly as pressing Open always has.';


create or replace function public.vendor_set_accepting_orders(p_vendor_id uuid, p_accepting boolean)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  select * into v_vendor from public.vendors where id = p_vendor_id for update;
  if not found or v_vendor.status <> 'ACTIVE' then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;

  if p_accepting then
    -- REFUSED, RATHER THAN HELPFULLY GUESSED. An open store with an empty menu
    -- is somebody walking across campus to a counter that has nothing for them,
    -- and picking an item on the vendor's behalf would be deciding what they
    -- are cooking. The message names the one thing that fixes it. An item a
    -- customer cannot order does not count, for the same reason.
    if not exists (
      select 1 from public.menu_items m
       where m.vendor_id = p_vendor_id and m.is_active
         and (m.pricing_mode = 'FIXED' or v_vendor.can_use_variable_pricing)
    ) then
      raise exception 'turn at least one item on before you open'
        using errcode = 'check_violation';
    end if;
  else
    -- CLOSING CLEARS THE ACTIVE MENU, and that is the point of it: tomorrow is
    -- a different service and starts from what the store is actually cooking.
    -- THE CATALOGUE IS UNTOUCHED — every item, price, photograph and scan
    -- eligibility is exactly where it was.
    update public.menu_items
       set is_active = false, updated_at = now()
     where vendor_id = p_vendor_id and is_active;
  end if;

  perform public.vendor_apply_menu_state(p_vendor_id);

  select * into v_vendor from public.vendors where id = p_vendor_id;
  return v_vendor;
end;
$$;


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

  select * into v_before from public.vendors where id = p_vendor_id for update;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  -- THE STORE'S ROW ONLY. No item is touched either way: switching off leaves
  -- every configuration where it is, dormant, and switching on brings it back.
  update public.vendors
     set can_use_variable_pricing = p_enabled,
         updated_at = now()
   where id = p_vendor_id;

  -- WHAT CAN BE ORDERED HAS CHANGED, so whether the store is open may have.
  -- Off closes a store whose only active items were variable; on reopens it.
  -- Items stay exactly as the store left them.
  perform public.vendor_apply_menu_state(p_vendor_id);

  select * into v_after from public.vendors where id = p_vendor_id;

  perform public.log_admin_action(
    'VENDOR_VARIABLE_PRICING_SET', 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


comment on column public.menu_items.is_active is
  'Whether this catalogue item is on the menu the store is serving RIGHT NOW. OFF is invisible to customers and is NOT sold out — the item keeps its price, its photograph and its history, and the store turns it back on when it next serves it. A store is open if and only if at least one of its active items can be ordered; see vendor_apply_menu_state().';
