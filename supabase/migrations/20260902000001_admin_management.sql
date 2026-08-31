-- ============================================================================
-- Phase 4 — admin management of vendors, staff, menus and locations
-- ============================================================================
-- Vendor registration is CLOSED. There is no public signup: admins hand-recruit
-- and create every vendor here.
--
-- Every function follows the Phase 2 contract:
--   * is_admin() is re-derived from the database, never taken from the client;
--   * the mutation and its admin_actions row happen in ONE transaction, so
--     there is no path that changes something administratively without leaving
--     a record;
--   * a stated reason is required by the audit table itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_vendor(
  p_name                   text,
  p_phone                  text,
  p_reason                 text,
  p_location_id            uuid    default null,
  p_location_note          text    default null,
  p_walk_minutes_to_campus integer default null
)
returns public.vendors
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'vendor name is required' using errcode = 'check_violation';
  end if;

  -- A vendor is created DRAFT and not accepting orders. Going live is a
  -- separate, separately-audited decision.
  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    location_id, location_note, walk_minutes_to_campus
  )
  values (
    btrim(p_name), p_phone, 'DRAFT', false,
    p_location_id, p_location_note, p_walk_minutes_to_campus
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor)
  );

  return v_vendor;
end;
$$;

create or replace function public.admin_update_vendor(
  p_vendor_id              uuid,
  p_reason                 text,
  p_name                   text    default null,
  p_phone                  text    default null,
  p_location_id            uuid    default null,
  p_location_note          text    default null,
  p_walk_minutes_to_campus integer default null
)
returns public.vendors
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  -- NULL means "leave unchanged", so a partial edit form cannot blank a field
  -- it did not intend to touch.
  update public.vendors
     set name                   = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         phone                  = coalesce(p_phone, phone),
         location_id            = coalesce(p_location_id, location_id),
         location_note          = coalesce(p_location_note, location_note),
         walk_minutes_to_campus = coalesce(p_walk_minutes_to_campus, walk_minutes_to_campus)
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_UPDATE', 'vendor', p_vendor_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vendor staff
-- ---------------------------------------------------------------------------
-- Staff are attached by PHONE, because that is the only identifier an admin
-- actually has for someone standing in front of them. The person must already
-- have signed in once — we never create an account on their behalf, which would
-- mean claiming a phone number nobody proved.
create or replace function public.admin_add_vendor_user(
  p_vendor_id uuid,
  p_phone     text,
  p_reason    text
)
returns public.vendor_users
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_link    public.vendor_users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select id into v_user_id from public.users where phone = p_phone;
  if v_user_id is null then
    raise exception 'no Campus Dash account for %. Ask them to sign in once first.', p_phone
      using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from public.vendors where id = p_vendor_id) then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  insert into public.vendor_users (vendor_id, user_id)
  values (p_vendor_id, v_user_id)
  on conflict (vendor_id, user_id) do nothing
  returning * into v_link;

  if v_link.vendor_id is null then
    -- Already staff. Idempotent, and not worth an audit entry.
    select * into v_link from public.vendor_users
     where vendor_id = p_vendor_id and user_id = v_user_id;
    return v_link;
  end if;

  perform public.log_admin_action(
    'VENDOR_STAFF_ADD', 'vendor', p_vendor_id, p_reason, null,
    jsonb_build_object('user_id', v_user_id, 'phone', p_phone)
  );

  return v_link;
end;
$$;

create or replace function public.admin_remove_vendor_user(
  p_vendor_id uuid,
  p_user_id   uuid,
  p_reason    text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.vendor_users
   where vendor_id = p_vendor_id and user_id = p_user_id;
  get diagnostics v_removed = row_count;

  if v_removed = 0 then
    return false;
  end if;

  perform public.log_admin_action(
    'VENDOR_STAFF_REMOVE', 'vendor', p_vendor_id, p_reason,
    jsonb_build_object('user_id', p_user_id), null
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Menu items
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_menu_item(
  p_vendor_id     uuid,
  p_name          text,
  p_price_pesewas bigint,
  p_reason        text,
  p_description   text    default null,
  p_sort_order    integer default 0
)
returns public.menu_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Money is integer pesewas. A caller sending 35.50 is a bug, not a rounding
  -- opportunity, so it is refused rather than truncated.
  if p_price_pesewas is null or p_price_pesewas <= 0 then
    raise exception 'price must be a positive whole number of pesewas'
      using errcode = 'check_violation';
  end if;

  insert into public.menu_items (vendor_id, name, description, price_pesewas, sort_order)
  values (p_vendor_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''),
          p_price_pesewas, coalesce(p_sort_order, 0))
  returning * into v_item;

  perform public.log_admin_action(
    'MENU_ITEM_CREATE', 'menu_item', v_item.id, p_reason, null, to_jsonb(v_item)
  );

  return v_item;
end;
$$;

-- A price change here NEVER reaches an order already placed: order_items carry
-- their own name and unit price, snapshotted at submit time.
create or replace function public.admin_update_menu_item(
  p_menu_item_id  uuid,
  p_reason        text,
  p_name          text    default null,
  p_description   text    default null,
  p_price_pesewas bigint  default null,
  p_sort_order    integer default null
)
returns public.menu_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.menu_items%rowtype;
  v_after  public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  if p_price_pesewas is not null and p_price_pesewas <= 0 then
    raise exception 'price must be a positive whole number of pesewas'
      using errcode = 'check_violation';
  end if;

  update public.menu_items
     set name          = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         description   = coalesce(p_description, description),
         price_pesewas = coalesce(p_price_pesewas, price_pesewas),
         sort_order    = coalesce(p_sort_order, sort_order)
   where id = p_menu_item_id
  returning * into v_after;

  perform public.log_admin_action(
    case when v_after.price_pesewas is distinct from v_before.price_pesewas
         then 'MENU_ITEM_PRICE_CHANGE' else 'MENU_ITEM_UPDATE' end,
    'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

create or replace function public.admin_set_menu_item_available(
  p_menu_item_id uuid,
  p_available    boolean,
  p_reason       text
)
returns public.menu_items
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.menu_items%rowtype;
  v_after  public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  update public.menu_items set is_available = p_available
   where id = p_menu_item_id
  returning * into v_after;

  perform public.log_admin_action(
    case when p_available then 'MENU_ITEM_ENABLE' else 'MENU_ITEM_DISABLE' end,
    'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- Deletion is allowed ONLY for an item nothing has ever ordered. Once an item
-- appears on an order, disabling is the correct move: deleting would sever the
-- reporting link between that order line and the item it came from. (The order
-- itself is safe either way — it holds its own price and name snapshot.)
create or replace function public.admin_delete_menu_item(p_menu_item_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.menu_items%rowtype;
  v_orders integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    return false;
  end if;

  select count(*) into v_orders from public.order_items where menu_item_id = p_menu_item_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order line(s) reference this item. Disable it instead.', v_orders
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.menu_items where id = p_menu_item_id;

  perform public.log_admin_action(
    'MENU_ITEM_DELETE', 'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), null
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Campus locations
-- ---------------------------------------------------------------------------
-- No GPS. This is the whole location model: a tree the admin maintains.
create or replace function public.admin_create_location(
  p_kind           public.location_kind,
  p_name           text,
  p_reason         text,
  p_parent_id      uuid    default null,
  p_is_deliverable boolean default false,
  p_walk_minutes   integer default null,
  p_sort_order     integer default 0
)
returns public.locations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_location public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_kind <> 'CAMPUS' and p_parent_id is null then
    raise exception 'only a CAMPUS may be a root location' using errcode = 'check_violation';
  end if;

  insert into public.locations (parent_id, kind, name, is_deliverable, walk_minutes, sort_order)
  values (p_parent_id, p_kind, btrim(p_name), coalesce(p_is_deliverable, false),
          p_walk_minutes, coalesce(p_sort_order, 0))
  returning * into v_location;

  perform public.log_admin_action(
    'LOCATION_CREATE', 'location', v_location.id, p_reason, null, to_jsonb(v_location)
  );

  return v_location;
end;
$$;

create or replace function public.admin_update_location(
  p_location_id    uuid,
  p_reason         text,
  p_name           text    default null,
  p_is_deliverable boolean default null,
  p_walk_minutes   integer default null,
  p_sort_order     integer default null
)
returns public.locations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.locations%rowtype;
  v_after  public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;

  -- parent_id is deliberately NOT editable here. Re-parenting a live tree would
  -- silently move the destination zone of orders already in flight; it needs
  -- its own operation with its own thinking.
  update public.locations
     set name           = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         is_deliverable = coalesce(p_is_deliverable, is_deliverable),
         walk_minutes   = coalesce(p_walk_minutes, walk_minutes),
         sort_order     = coalesce(p_sort_order, sort_order)
   where id = p_location_id
  returning * into v_after;

  perform public.log_admin_action(
    'LOCATION_UPDATE', 'location', p_location_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- Deactivating hides a location from new orders. Orders already heading there
-- are untouched — the Partner still needs to find the room.
create or replace function public.admin_set_location_active(
  p_location_id uuid,
  p_active      boolean,
  p_reason      text
)
returns public.locations
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.locations%rowtype;
  v_after  public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;

  update public.locations set is_active = p_active where id = p_location_id
  returning * into v_after;

  -- Deactivating a block must not leave its rooms selectable underneath it.
  if not p_active then
    update public.locations set is_active = false
     where id in (
       with recursive descendants as (
         select id from public.locations where parent_id = p_location_id
         union all
         select l.id from public.locations l join descendants d on l.parent_id = d.id
       )
       select id from descendants
     );
  end if;

  perform public.log_admin_action(
    case when p_active then 'LOCATION_ACTIVATE' else 'LOCATION_DEACTIVATE' end,
    'location', p_location_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

create or replace function public.admin_delete_location(p_location_id uuid, p_reason text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before   public.locations%rowtype;
  v_children integer;
  v_orders   integer;
  v_vendors  integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    return false;
  end if;

  select count(*) into v_children from public.locations where parent_id = p_location_id;
  if v_children > 0 then
    raise exception 'cannot delete: % child location(s). Deactivate it instead.', v_children
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_orders from public.orders
   where destination_location_id = p_location_id or destination_zone_id = p_location_id;
  if v_orders > 0 then
    raise exception 'cannot delete: % order(s) reference this location. Deactivate it instead.', v_orders
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_vendors from public.vendors where location_id = p_location_id;
  if v_vendors > 0 then
    raise exception 'cannot delete: % vendor(s) sit at this location.', v_vendors
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.locations where id = p_location_id;

  perform public.log_admin_action(
    'LOCATION_DELETE', 'location', p_location_id, p_reason, to_jsonb(v_before), null
  );

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Partner applications
-- ---------------------------------------------------------------------------
-- The review queue. Returns the document PATHS, never URLs: the images live in
-- a private bucket and are reachable only through short-lived signed URLs
-- minted server-side at the moment an admin opens them.
create or replace function public.admin_list_partner_applications(
  p_status public.partner_application_status default null
)
returns table (
  user_id               uuid,
  full_name             text,
  phone                 text,
  student_id_number     text,
  status                public.partner_application_status,
  student_id_image_path text,
  face_image_path       text,
  is_available          boolean,
  applied_at            timestamptz,
  reviewed_at           timestamptz,
  reviewed_by_name      text,
  review_notes          text,
  documents_purge_after timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, u.full_name, u.phone, u.student_id_number, p.status,
         p.student_id_image_path, p.face_image_path, p.is_available,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.documents_purge_after
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin()
     and (p_status is null or p.status = p_status)
   order by
     -- Applications waiting on a human come first; nothing else matters as much.
     case when p.status = 'PENDING_REVIEW' then 0 else 1 end,
     p.applied_at asc;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Reachable by any signed-in user; each re-checks is_admin() internally, so the
-- grant only decides who may attempt the call, never who succeeds.
grant execute on function public.admin_create_vendor(text, text, text, uuid, text, integer) to authenticated;
grant execute on function public.admin_update_vendor(uuid, text, text, text, uuid, text, integer) to authenticated;
grant execute on function public.admin_add_vendor_user(uuid, text, text) to authenticated;
grant execute on function public.admin_remove_vendor_user(uuid, uuid, text) to authenticated;

grant execute on function public.admin_create_menu_item(uuid, text, bigint, text, text, integer) to authenticated;
grant execute on function public.admin_update_menu_item(uuid, text, text, text, bigint, integer) to authenticated;
grant execute on function public.admin_set_menu_item_available(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_menu_item(uuid, text) to authenticated;

grant execute on function public.admin_create_location(public.location_kind, text, text, uuid, boolean, integer, integer) to authenticated;
grant execute on function public.admin_update_location(uuid, text, text, boolean, integer, integer) to authenticated;
grant execute on function public.admin_set_location_active(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_location(uuid, text) to authenticated;

grant execute on function public.admin_list_partner_applications(public.partner_application_status) to authenticated;
