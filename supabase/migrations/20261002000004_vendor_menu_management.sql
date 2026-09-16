-- ---------------------------------------------------------------------------
-- A STORE OWNS ITS OWN MENU
-- ---------------------------------------------------------------------------
-- Vendors could mark an item sold out and nothing else. Adding a dish, changing
-- a price or putting a photograph on it meant emailing Campus Dash, which is a
-- support queue standing between a cook and their own board — and the reason it
-- worked that way was a worry that a price could move under an order somebody
-- was halfway through placing.
--
-- THAT WORRY IS ALREADY ANSWERED, and was before this migration: price_order()
-- snapshots every figure onto the order at submission, and an order that exists
-- carries its own prices for ever. A vendor editing a menu cannot reach an
-- order, a quote already given, or an order line. So the restriction was
-- protecting nothing, and cost a store the ability to run its own shop.
--
-- THREE DIFFERENT ACTS, KEPT DIFFERENT. Conflating them is the thing that makes
-- menu management confusing everywhere it is confusing:
--
--   SOLD OUT       today's problem. The item stays on the customer's menu,
--                  marked, and comes back automatically when the store reopens.
--   UNAVAILABLE    off the menu for now, deliberately, until put back by hand.
--                  Same column as sold out — see the note on reopening.
--   DELETED        it is not a thing this store sells any more. Refused
--                  outright if any order references it, because deleting it
--                  would either orphan those lines or rewrite history.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. AN ITEM CAN HAVE A PHOTOGRAPH
-- ---------------------------------------------------------------------------
-- On the same public bucket as the storefront photographs, for the same reason:
-- an unauthenticated visitor browsing the marketplace has to see it, and a
-- picture of a plate of jollof is advertising.

alter table public.menu_items
  add column if not exists image_path text,
  add column if not exists image_content_type text,
  add column if not exists image_byte_size bigint;

alter table public.menu_items drop constraint if exists menu_items_image_complete;
alter table public.menu_items
  add constraint menu_items_image_complete
  check (
    (image_path is null and image_content_type is null and image_byte_size is null)
    or (image_path is not null and image_content_type is not null and image_byte_size > 0)
  );

comment on column public.menu_items.image_path is
  'A photograph of this dish, in the PUBLIC vendor-images bucket. Null is normal and renders the designed placeholder. The three image columns move together — menu_items_image_complete says so — because a path with no content type is a broken image on every storefront.';

-- ---------------------------------------------------------------------------
-- 2. WHY "SOLD OUT" AND "UNAVAILABLE" SHARE A COLUMN
-- ---------------------------------------------------------------------------
-- Both mean "a customer cannot order this right now", which is the only thing
-- the ordering path needs to know, and price_order() already checks exactly
-- that. What differs is INTENT, and intent matters for one behaviour only:
-- reopening the store clears sold-out marks, because running out of jollof is a
-- fact about a service rather than a property of the dish.
--
-- So the distinction is recorded as the REASON rather than as a second boolean.
-- Two booleans that must never both be true is a constraint somebody breaks;
-- one column with a reason cannot disagree with itself.

alter table public.menu_items
  add column if not exists unavailable_reason text;

alter table public.menu_items drop constraint if exists menu_items_unavailable_reason_shape;
alter table public.menu_items
  add constraint menu_items_unavailable_reason_shape
  check (unavailable_reason is null or unavailable_reason in ('SOLD_OUT', 'WITHDRAWN'));

comment on column public.menu_items.unavailable_reason is
  'Why is_available is false. SOLD_OUT is today''s problem and is cleared when the store reopens; WITHDRAWN is deliberate and stays until a person puts the item back. Null whenever is_available is true. The ordering path reads is_available alone and does not care which.';

-- Existing unavailable items are treated as sold out, which is what the one
-- toggle meant before this migration.
update public.menu_items
   set unavailable_reason = 'SOLD_OUT'
 where not is_available and unavailable_reason is null;

-- ---------------------------------------------------------------------------
-- 3. THE STORE'S OWN MENU
-- ---------------------------------------------------------------------------

create or replace function public.vendor_menu(p_vendor_id uuid)
returns table(
  id uuid,
  name text,
  description text,
  price_pesewas bigint,
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
         m.is_available, m.unavailable_reason, m.scan_eligible, m.image_path, m.sort_order,
         -- WHETHER IT CAN BE DELETED, answered on the row rather than by
         -- letting somebody press Delete and read an error. An item any order
         -- references is withdrawn, never removed.
         (select count(*) from public.order_items oi where oi.menu_item_id = m.id)
    from public.menu_items m
   where m.vendor_id = p_vendor_id
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   order by m.sort_order, m.name;
$$;

-- ---------------------------------------------------------------------------
-- 4. ADD, EDIT, DELETE
-- ---------------------------------------------------------------------------

create or replace function public.vendor_create_menu_item(
  p_vendor_id uuid,
  p_name text,
  p_price_pesewas bigint,
  p_description text default null,
  p_scan_eligible boolean default false
)
returns public.menu_items
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
  v_next integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if v_name is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;
  if length(v_name) > 120 then
    raise exception 'keep the name under 120 characters' using errcode = 'check_violation';
  end if;

  -- MONEY IS INTEGER PESEWAS. A caller sending 35.50 is a bug, not a rounding
  -- opportunity, so it is refused rather than truncated.
  if p_price_pesewas is null or p_price_pesewas <= 0 then
    raise exception 'give the item a price' using errcode = 'check_violation';
  end if;
  if p_price_pesewas > 100000 then
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
    vendor_id, name, description, price_pesewas, sort_order, scan_eligible
  )
  values (
    p_vendor_id, v_name, nullif(btrim(coalesce(p_description, '')), ''),
    p_price_pesewas, v_next, coalesce(p_scan_eligible, false)
  )
  returning * into v_item;

  return v_item;
end;
$$;

create or replace function public.vendor_update_menu_item(
  p_menu_item_id uuid,
  p_name text default null,
  p_price_pesewas bigint default null,
  p_description text default null,
  p_scan_eligible boolean default null
)
returns public.menu_items
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item public.menu_items%rowtype;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if p_price_pesewas is not null and (p_price_pesewas <= 0 or p_price_pesewas > 100000) then
    raise exception 'give the item a sensible price' using errcode = 'check_violation';
  end if;
  if p_name is not null and nullif(btrim(p_name), '') is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;

  -- A PRICE CHANGE REACHES NO EXISTING ORDER. price_order() snapshots every
  -- figure onto the order at submission and order_items keeps its own copy, so
  -- this moves what the NEXT customer is quoted and nothing else. That is the
  -- whole reason a store can be trusted with its own prices.
  update public.menu_items m
     set name = coalesce(nullif(btrim(p_name), ''), m.name),
         price_pesewas = coalesce(p_price_pesewas, m.price_pesewas),
         description = case
           when p_description is null then m.description
           else nullif(btrim(p_description), '') end,
         scan_eligible = coalesce(p_scan_eligible, m.scan_eligible),
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;

/**
 * Sold out, withdrawn, or back on.
 *
 * One function for all three because they are one fact — can a customer order
 * this right now — plus a reason. See the column comment.
 */
drop function if exists public.vendor_set_menu_item_available(uuid, boolean);

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

  if not p_available and v_reason not in ('SOLD_OUT', 'WITHDRAWN') then
    raise exception 'unknown reason' using errcode = 'check_violation';
  end if;

  update public.menu_items m
     set is_available = p_available,
         unavailable_reason = case when p_available then null else v_reason end,
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;

/**
 * Removing an item for good.
 *
 * REFUSED IF ANY ORDER REFERENCES IT, and the message says what to do instead.
 * Deleting it would either orphan those lines or rewrite what somebody was
 * charged for, and neither is a thing a store should be able to do by accident
 * on a busy afternoon. Withdrawing achieves what they actually wanted.
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

  delete from public.menu_items where id = p_menu_item_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE ITEM'S PHOTOGRAPH
-- ---------------------------------------------------------------------------
-- Attaching and removing are separate calls rather than one nullable setter,
-- because the CALLER has different work to do around each: an attach follows a
-- successful upload and must be rolled back if it fails, and a remove hands
-- back the old path so the object can be deleted after the row is.

create or replace function public.vendor_set_menu_item_image(
  p_menu_item_id uuid,
  p_storage_path text,
  p_content_type text,
  p_byte_size bigint
)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item     public.menu_items%rowtype;
  v_previous text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'no image was received' using errcode = 'check_violation';
  end if;

  v_previous := v_item.image_path;

  update public.menu_items
     set image_path = btrim(p_storage_path),
         image_content_type = p_content_type,
         image_byte_size = p_byte_size,
         updated_at = now()
   where id = p_menu_item_id;

  -- THE PATH THAT WAS REPLACED, so the caller can delete the object it points
  -- at. Replacing a photograph without this leaves the old file in the bucket
  -- for ever, which is how a storage bill grows with nothing to show for it.
  return v_previous;
end;
$$;

create or replace function public.vendor_clear_menu_item_image(p_menu_item_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_item     public.menu_items%rowtype;
  v_previous text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    return null;
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  v_previous := v_item.image_path;

  update public.menu_items
     set image_path = null, image_content_type = null, image_byte_size = null, updated_at = now()
   where id = p_menu_item_id;

  return v_previous;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. THE STOREFRONT SHOWS THEM
-- ---------------------------------------------------------------------------

drop function if exists public.scan_menu(uuid);

create or replace function public.scan_menu(p_vendor_id uuid)
returns table(
  id uuid,
  name text,
  description text,
  price_pesewas bigint,
  is_available boolean,
  image_path text
)
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
     and v.status = 'ACTIVE'
     and v.can_accept_scans
   order by m.sort_order, m.name;
$$;

-- ---------------------------------------------------------------------------
-- 7. GRANTS
-- ---------------------------------------------------------------------------

revoke all on function public.vendor_menu(uuid) from public, anon;
grant execute on function public.vendor_menu(uuid) to authenticated;

revoke all on function public.vendor_create_menu_item(uuid, text, bigint, text, boolean)
  from public, anon;
grant execute on function public.vendor_create_menu_item(uuid, text, bigint, text, boolean)
  to authenticated;

revoke all on function public.vendor_update_menu_item(uuid, text, bigint, text, boolean)
  from public, anon;
grant execute on function public.vendor_update_menu_item(uuid, text, bigint, text, boolean)
  to authenticated;

revoke all on function public.vendor_set_menu_item_available(uuid, boolean, text) from public, anon;
grant execute on function public.vendor_set_menu_item_available(uuid, boolean, text) to authenticated;

revoke all on function public.vendor_delete_menu_item(uuid) from public, anon;
grant execute on function public.vendor_delete_menu_item(uuid) to authenticated;

revoke all on function public.vendor_set_menu_item_image(uuid, text, text, bigint) from public, anon;
grant execute on function public.vendor_set_menu_item_image(uuid, text, text, bigint) to authenticated;

revoke all on function public.vendor_clear_menu_item_image(uuid) from public, anon;
grant execute on function public.vendor_clear_menu_item_image(uuid) to authenticated;

revoke all on function public.scan_menu(uuid) from public;
grant execute on function public.scan_menu(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. REOPENING CLEARS SOLD OUT, AND ONLY SOLD OUT
-- ---------------------------------------------------------------------------
-- This is the one behaviour the two reasons exist to tell apart, and until the
-- reason column existed it could not: reopening cleared EVERY unavailable item,
-- so a dish a store had deliberately taken off the menu came back on the next
-- morning without anybody choosing that.
--
-- Running out of jollof is a fact about a service and clears itself. Taking
-- something off the menu is a decision and stays until a person reverses it.

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
  v_before public.vendors%rowtype;
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;

  update public.vendors set is_accepting_orders = p_accepting
   where id = p_vendor_id and status = 'ACTIVE'
  returning * into v_vendor;

  if not found then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;

  -- CLOSED → OPEN clears every SOLD-OUT mark, and nothing else. A vendor who
  -- has to untick fourteen items before they can sell anything will stop
  -- bothering; a vendor whose withdrawn dishes reappear overnight will stop
  -- trusting the switch. Guarded on the transition, so pressing Open twice does
  -- not reset a mark somebody set deliberately a minute ago while already open.
  if p_accepting and not coalesce(v_before.is_accepting_orders, false) then
    update public.menu_items
       set is_available = true, unavailable_reason = null
     where vendor_id = p_vendor_id
       and not is_available
       and unavailable_reason is distinct from 'WITHDRAWN';
  end if;

  return v_vendor;
end;
$$;

revoke all on function public.vendor_set_accepting_orders(uuid, boolean) from public, anon;
grant execute on function public.vendor_set_accepting_orders(uuid, boolean) to authenticated;
