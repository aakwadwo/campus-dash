-- ---------------------------------------------------------------------------
-- A CATALOGUE YOU BUILD ONCE, AND A MENU YOU TURN ON
-- ---------------------------------------------------------------------------
-- A stall sells eggs in the morning, plantain at eleven and jollof at one. The
-- menu model made that a chore: the only way to stop offering something was to
-- take it off and the only way to offer it again was to put it back, item by
-- item, several times a day — and the vendors who found that tedious solved it
-- by deleting and re-adding dishes, which is how a store ends up unable to
-- delete anything because every name has an order behind it.
--
-- So the two questions are separated for good:
--
--   THE CATALOGUE   everything this store sells, ever. Added once. Never
--                   removed by a toggle, never emptied by closing.
--   THE ACTIVE MENU which of those it is serving right now. menu_items.is_active.
--
-- AND "OFF" IS NOT "SOLD OUT". They were one column with a reason, which was
-- right while both meant "a customer cannot order this" — but they no longer
-- mean the same thing to a customer:
--
--   OFF                the customer does not see it at all
--   ON  + SOLD OUT     the customer sees it, marked, and cannot order it
--   ON  + AVAILABLE    the customer sees it and can order it
--
-- Those are three states, so WITHDRAWN — the old "off the menu" reason — is
-- retired into is_active and unavailable_reason goes back to meaning one thing.
-- Collapsing them again would cost the store the ability to say "we have run
-- out of jollof" without also saying "we do not sell jollof".
--
-- OPEN AND CLOSED IS STILL THE STORE'S OWN SWITCH, and it is now tied to the
-- active menu by one invariant the database maintains rather than hopes for:
--
--        a store is OPEN if and only if at least one item is ON
--
-- which reads, in the five transitions a vendor can actually perform:
--
--   close the store         → every active item goes OFF. The catalogue stays.
--   turn one of several OFF → the rest stay ON and the store stays open.
--   turn the LAST one OFF   → the store closes itself.
--   turn one ON while closed→ the store opens itself.
--   open with nothing ON    → REFUSED, with the reason. An open store showing
--                             an empty menu is a customer walking to a counter.
--
-- Every one of those goes through a function that takes the vendor row with
-- SELECT … FOR UPDATE first, so two taps in the same second serialise instead
-- of racing to leave the store open with nothing on it. The count is read
-- inside that lock; nothing here trusts a number a browser was holding.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. THE COLUMN, AND WHAT THE OLD ONE BECOMES
-- ---------------------------------------------------------------------------
-- DEFAULT FALSE. A new item joins the CATALOGUE, not the service: a vendor
-- adding six dishes at eleven at night has not decided to start selling them,
-- and a default of true would open their store from the menu screen.

alter table public.menu_items
  add column if not exists is_active boolean not null default false;

comment on column public.menu_items.is_active is
  'Whether this catalogue item is on the menu the store is serving RIGHT NOW. OFF is invisible to customers and is NOT sold out — the item keeps its price, its photograph and its history, and the store turns it back on when it next serves it. A store is open if and only if at least one of its items is active; see vendor_apply_menu_state().';

-- Everything that was orderable, and everything merely sold out, was ON the
-- menu a customer could see, so it stays on it.
update public.menu_items
   set is_active = true
 where is_available or unavailable_reason = 'SOLD_OUT';

-- WITHDRAWN was "off the menu until I put it back", by hand, on the same column
-- as sold out. That is exactly is_active = false, so the reason retires and the
-- item stops pretending to be unavailable.
update public.menu_items
   set is_active = false, is_available = true, unavailable_reason = null
 where unavailable_reason = 'WITHDRAWN';

alter table public.menu_items drop constraint if exists menu_items_unavailable_reason_shape;
alter table public.menu_items
  add constraint menu_items_unavailable_reason_shape
  check (unavailable_reason is null or unavailable_reason = 'SOLD_OUT');

comment on column public.menu_items.unavailable_reason is
  'Why is_available is false. SOLD_OUT is the only reason there is: today''s problem, cleared when the store next reopens. "Off the menu" is not a kind of unavailability and lives on is_active instead. Null whenever is_available is true.';

create index if not exists menu_items_active_idx
  on public.menu_items (vendor_id) where is_active;

-- The scan index covered the wrong pair once is_active existed: a scan
-- restaurant's eligible items are the ones it is actually serving.
drop index if exists public.menu_items_scan_eligible_idx;
create index menu_items_scan_eligible_idx
  on public.menu_items (vendor_id) where (scan_eligible and is_available and is_active);

-- ---------------------------------------------------------------------------
-- 2. A CUSTOMER SEES THE ACTIVE MENU, AND THE POLICY SAYS SO
-- ---------------------------------------------------------------------------
-- The storefront reads menu_items directly through RLS, so this is where "OFF
-- is invisible" has to live. A page that merely filtered would still have sent
-- the row over the wire, and every other reader — the marketplace search, a
-- future screen nobody has written — would have had to remember the same
-- filter. The store's own policies are untouched: a vendor and an admin see the
-- whole catalogue, which is the entire point of having one.

drop policy if exists "menu_items_read_public" on public.menu_items;
create policy "menu_items_read_public" on public.menu_items
  for select to authenticated, anon
  using (
    is_active
    and exists (
      select 1 from public.vendors v
       where v.id = menu_items.vendor_id and v.status = 'ACTIVE'
    )
  );

-- ---------------------------------------------------------------------------
-- 3. THE INVARIANT, IN ONE PLACE
-- ---------------------------------------------------------------------------
-- INTERNAL. Not granted to any client role: it is the shared tail of the
-- vendor functions below, and every one of them has already decided that the
-- caller is entitled to move this store.
--
-- THE CALLER MUST HAVE LOCKED THE VENDOR ROW. That is not a convention this
-- function can check, so each caller does `select … for update` first and this
-- takes it again, which is free inside the same transaction and safe outside it.

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
  v_open := v_vendor.status = 'ACTIVE' and exists (
    select 1 from public.menu_items m
     where m.vendor_id = p_vendor_id and m.is_active
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
  'Makes vendors.is_accepting_orders agree with the active menu: open if and only if at least one item is ON and the store is ACTIVE. Internal — every caller has already authorised the move and locked the vendor row. A CLOSED → OPEN transition here clears sold-out marks, exactly as pressing Open always has.';

revoke all on function public.vendor_apply_menu_state(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. THE TOGGLE
-- ---------------------------------------------------------------------------

create or replace function public.vendor_set_menu_item_active(
  p_menu_item_id uuid,
  p_active boolean
)
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

comment on function public.vendor_set_menu_item_active(uuid, boolean) is
  'Turns a catalogue item ON or OFF. OFF hides it from customers and deletes nothing — not the item, not its price, not its sold-out mark''s meaning. Returns the store''s resulting open state, because turning the last item off closes the store and turning any item on opens it.';

revoke all on function public.vendor_set_menu_item_active(uuid, boolean) from public, anon;
grant execute on function public.vendor_set_menu_item_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. SOLD OUT IS STILL ITS OWN THING
-- ---------------------------------------------------------------------------
-- Unchanged in everything that matters, and narrowed in one: WITHDRAWN is gone,
-- so this function now says exactly one thing — whether a customer may order an
-- item that is on the menu. Marking an item sold out never takes it off the
-- menu, and never closes a store.

create or replace function public.vendor_set_menu_item_available(
  p_menu_item_id uuid,
  p_available boolean,
  p_reason text default 'SOLD_OUT'
)
returns public.menu_items
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
  v_reason text := upper(coalesce(p_reason, 'SOLD_OUT'));
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  -- TAKING SOMETHING OFF THE MENU IS A DIFFERENT CALL, and the message says so
  -- rather than quietly doing the nearest thing.
  if not p_available and v_reason <> 'SOLD_OUT' then
    raise exception
      'sold out is the only reason an item on the menu is unavailable; to stop offering it, turn it off'
      using errcode = 'check_violation';
  end if;

  update public.menu_items m
     set is_available = p_available,
         unavailable_reason = case when p_available then null else 'SOLD_OUT' end,
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. ADDING, DELETING
-- ---------------------------------------------------------------------------

-- A NEW ITEM JOINS THE CATALOGUE, NOT THE SERVICE, and vendor_create_menu_item()
-- needs no change to say so: is_active takes its column default of false.
-- Adding a dish is not the same decision as starting to sell it, and a default
-- of true would open a closed store from the menu screen. Every other rule that
-- function enforces — the name, the price ceiling, the sixty-item limit — is
-- deliberately left exactly where it is.

/**
 * Removing an item for good.
 *
 * REFUSED IF ANY ORDER REFERENCES IT, and the message says what to do instead.
 * Deleting the last ACTIVE item closes the store, for the same reason turning
 * it off does: there is nothing left to sell.
 */
create or replace function public.vendor_delete_menu_item(p_menu_item_id uuid)
returns boolean
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item   public.menu_items%rowtype;
  v_orders integer;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    return false;
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_orders from public.order_items where menu_item_id = p_menu_item_id;
  if v_orders > 0 then
    raise exception
      'somebody has ordered this before, so it cannot be deleted. Take it off the menu instead.'
      using errcode = 'foreign_key_violation';
  end if;

  perform 1 from public.vendors where id = v_item.vendor_id for update;
  delete from public.menu_items where id = p_menu_item_id;
  perform public.vendor_apply_menu_state(v_item.vendor_id);

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. THE STORE'S OWN SWITCH
-- ---------------------------------------------------------------------------

create or replace function public.vendor_set_accepting_orders(
  p_vendor_id uuid,
  p_accepting boolean
)
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
    -- are cooking. The message names the one thing that fixes it.
    if not exists (
      select 1 from public.menu_items m where m.vendor_id = p_vendor_id and m.is_active
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

comment on function public.vendor_set_accepting_orders(uuid, boolean) is
  'Open or close the store. Closing turns every active item OFF and keeps the catalogue whole. Opening is REFUSED while nothing is on, because an open store with an empty menu is a customer walking to a counter for nothing. Both run under a lock on the vendor row, so a close and a toggle arriving together cannot leave the store open with no menu.';

-- ---------------------------------------------------------------------------
-- 8. WHAT THE STORE SEES
-- ---------------------------------------------------------------------------
-- The whole catalogue, with the one fact the screen is built around.

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
  order_count bigint
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
         (select count(*) from public.order_items oi where oi.menu_item_id = m.id)
    from public.menu_items m
   where m.vendor_id = p_vendor_id
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   -- ON FIRST. The items a store is serving are the ones it is looking for.
   order by m.is_active desc, m.sort_order, m.name;
$$;

revoke all on function public.vendor_menu(uuid) from public, anon;
grant execute on function public.vendor_menu(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. WHAT A CUSTOMER SEES
-- ---------------------------------------------------------------------------
-- Both scan reads and the marketplace count. A store's menu count is what a
-- customer would find on its page, so an off item must not be in it.

create or replace function public.scan_menu(p_vendor_id uuid)
returns table(id uuid, name text, description text, price_pesewas bigint, is_available boolean, image_path text)
language sql
stable
security definer
set search_path to ''
as $$
  select m.id, m.name, m.description, m.price_pesewas, m.is_available, m.image_path
    from public.menu_items m
    join public.vendors v on v.id = m.vendor_id
   where m.vendor_id = p_vendor_id
     and m.scan_eligible
     and m.is_active
     and v.status = 'ACTIVE'
     and v.can_accept_scans
   order by m.sort_order, m.name;
$$;

create or replace function public.scan_restaurants()
returns table(id uuid, name text, location_path text, is_accepting_orders boolean, image_path text, eligible_item_count bigint)
language sql
stable
security definer
set search_path to ''
as $$
  select v.id, v.name, public.location_path(v.location_id), v.is_accepting_orders,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.menu_items m
           where m.vendor_id = v.id and m.scan_eligible and m.is_available and m.is_active)
    from public.vendors v
   where v.status = 'ACTIVE'
     and v.can_accept_scans
     and exists (
       select 1 from public.menu_items m
        where m.vendor_id = v.id and m.scan_eligible and m.is_available and m.is_active
     )
   order by v.is_accepting_orders desc, v.name;
$$;

create or replace function public.storefront_vendors(p_category_id uuid default null, p_search text default null)
returns table(vendor_id uuid, name text, description text, category_id uuid, category_name text, category_slug text, location_path text, walk_minutes_to_campus integer, is_accepting_orders boolean, can_accept_scans boolean, image_path text, image_count bigint, menu_count bigint)
language sql
stable
security definer
set search_path to ''
as $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.vendor_images i where i.vendor_id = v.id),
         -- WHAT A CUSTOMER WOULD FIND ON THE PAGE. The active menu, not the
         -- catalogue behind it: a card promising nine dishes and a page showing
         -- two is worse than a card that says two.
         (select count(*) from public.menu_items m
           where m.vendor_id = v.id and m.is_active and m.is_available)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.status = 'ACTIVE'
     and (p_category_id is null or v.category_id = p_category_id)
     and (p_search is null or btrim(p_search) = ''
          or v.name ilike '%' || btrim(p_search) || '%'
          or coalesce(v.description,'') ilike '%' || btrim(p_search) || '%')
   -- Open stalls first. A CLOSED one still appears, because "they are closed
   -- right now" is information a customer wants; a stall that vanishes at 9pm
   -- reads as one that has left the platform. Its menu is empty while it is
   -- closed, which is now a fact about the store rather than a filter here.
   order by v.is_accepting_orders desc, v.name;
$$;

-- ---------------------------------------------------------------------------
-- 10. THE ORDERING PATH RE-CHECKS THE ACTIVE MENU
-- ---------------------------------------------------------------------------
-- THE BROWSER CANNOT BE TRUSTED TO HOLD CURRENT MENU STATE, and a customer with
-- a page open from twenty minutes ago is the ordinary case rather than an
-- attack. Each of these already re-read is_available and the store's open flag
-- at the server boundary; they now read is_active with them, in the same
-- statement, so a stale basket is refused by the same check that refuses a
-- sold-out one. Nothing else about them changes — every price is still
-- snapshotted onto the order exactly as before.

CREATE OR REPLACE FUNCTION public.price_order(p_vendor_id uuid, p_items jsonb) RETURNS TABLE(subtotal_pesewas bigint, service_fee_pesewas bigint, total_pesewas bigint, lines jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
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

CREATE OR REPLACE FUNCTION public.price_scan_order(p_vendor_id uuid, p_items jsonb, p_fulfilment_type public.fulfilment_type, p_destination_location_id uuid DEFAULT NULL::uuid, p_wants_pack boolean DEFAULT false) RETURNS TABLE(scanned_value_pesewas bigint, subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint, pack_fee_pesewas bigint, partner_earnings_pesewas bigint, total_pesewas bigint, destination_zone_id uuid, lines jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_scanned  bigint := 0;
  v_service  bigint;
  v_delivery bigint := 0;
  v_pack     bigint := 0;
  v_earnings bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id
       and status = 'ACTIVE'
       and is_accepting_orders
       and can_accept_scans
  ) then
    raise exception 'this store is not accepting meal scans right now'
      using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'choose at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- The refusal that keeps an unpriced product off the shelf: null is
  -- "undecided", and guessing here would be inventing revenue policy in a
  -- pricing function.
  if v_cfg.scan_service_fee_pesewas is null then
    raise exception
      'meal scans are not configured yet: an administrator must set the scan service fee'
      using errcode = 'check_violation';
  end if;

  -- SCAN ELIGIBILITY IS CHECKED HERE, per item, against the live menu. A screen
  -- that only offered eligible items is a convenience; this is the enforcement.
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
       and is_active
       and scan_eligible;

    if not found then
      raise exception 'that item cannot be paid for with a meal scan'
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

    v_scanned := v_scanned + (v_menu.price_pesewas * v_qty);
  end loop;

  -- FLAT, ALWAYS, AND NEVER A SHARE OF THE SCANNED VALUE. The scanned value is
  -- the store's price for food Campus Dash did not sell; a percentage of it
  -- would be a commission on somebody else's transaction.
  v_service := v_cfg.scan_service_fee_pesewas;

  if p_fulfilment_type = 'DELIVERY' then
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'no Partners are available right now'
        using errcode = 'check_violation';
    end if;

    if p_destination_location_id is null then
      raise exception 'choose where the Partner should bring it'
        using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'that is not a place a Partner can bring an order to'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Same carve as a food order. The Partner is paid for the errand, and the
    -- errand is identical work whether the food was bought or scanned.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;

    -- THE PACK COMES WITH THE PARTNER, and p_wants_pack is not consulted. A
    -- Partner cannot carry a meal without something to carry it in, so the
    -- screen never offers the choice — and a request that reached here without
    -- passing the screen is overridden rather than honoured.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  elsif coalesce(p_wants_pack, false) then
    -- A COLLECTION MAY BRING ITS OWN CONTAINER. Charging GH4 for a pack
    -- somebody refused is charging for nothing.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  end if;

  return query select
    v_scanned,
    -- WHAT CAMPUS DASH SOLD, which is no food at all. This is the number the
    -- ledger divides on, and it must stay zero or a store would appear to be
    -- owed money for a meal the university already paid for.
    0::bigint,
    v_service,
    v_delivery,
    v_pack,
    v_earnings,
    v_service + v_delivery + v_pack,
    case when p_fulfilment_type = 'DELIVERY'
         then public.location_zone(p_destination_location_id) end,
    v_lines;
end;
$$;

CREATE OR REPLACE FUNCTION public.submit_order_for(p_customer_id uuid, p_vendor_id uuid, p_items jsonb, p_fulfilment_type public.fulfilment_type, p_destination_location_id uuid DEFAULT NULL::uuid, p_destination_note text DEFAULT NULL::text) RETURNS TABLE(order_id uuid, order_number text, vendor_order_no integer, total_pesewas bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
  v_seen     uuid[] := '{}';
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
    case when p_fulfilment_type = 'DELIVERY'
         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
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

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
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
