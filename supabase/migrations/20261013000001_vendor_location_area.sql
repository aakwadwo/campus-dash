-- ===========================================================================
-- WHERE A STORE IS, IN THE STORE'S OWN WORDS
-- ===========================================================================
--
-- Two facts a vendor states about themselves: whether the store is ON or OFF
-- campus, and where exactly, as free text. A customer reads them under the
-- store's name.
--
-- NEW COLUMNS, NOT location_note. That column already has a meaning (an
-- administrator's "Location note", a vendor's "Directions") and rows written
-- under it were never written for a customer to read. Reusing it would put
-- text on a storefront that nobody chose to publish there.
--
-- BOTH NULLABLE, AND NOTHING IS BACKFILLED. Every store that existed before
-- this migration keeps NULL in both until its owner fills them in. There is no
-- default and no guessed value: a store with no stated location shows none.
-- Nothing here reads either column to decide status, approval, opening,
-- ordering, scans, dispatch or money.
--
-- NOT A replacement for location_id. That is the campus place tree a Partner
-- is sent to; this is what the store says about itself. Both stay.

alter table public.vendors
  add column if not exists location_area    text,
  add column if not exists location_details text;

-- NULL passes both checks, which is what keeps every existing row valid.
-- Dropped first so the file can be re-applied, as the hosted deploy may.
alter table public.vendors drop constraint if exists vendors_location_area_check;
alter table public.vendors drop constraint if exists vendors_location_details_shape;
alter table public.vendors
  add constraint vendors_location_area_check
    check (location_area in ('ON_CAMPUS', 'OFF_CAMPUS')),
  add constraint vendors_location_details_shape
    check (location_details is null
           or char_length(btrim(location_details)) between 1 and 160);

comment on column public.vendors.location_area is
  'ON_CAMPUS or OFF_CAMPUS, as the vendor states it. NULL means not stated yet: stores that predate the question keep NULL until their owner answers it. Informational only; nothing decides anything on it.';
comment on column public.vendors.location_details is
  'Where the store is, in the vendor''s own words, shown to customers under the store name. NULL means not stated. Free text by design, not an address system.';


-- ---------------------------------------------------------------------------
-- 1. THE ONE WRITER
-- ---------------------------------------------------------------------------
--
-- Owner only. is_vendor_staff() is the ownership check every vendor write
-- uses, and it already refuses a suspended account. No admin branch: an
-- administrator's vendor tools are unchanged and do not touch these columns.
--
-- Touches these two columns and nothing else, so saving a location cannot
-- move a store's status, opening, category or anything a customer orders.

create or replace function public.vendor_update_location(
  p_vendor_id uuid,
  p_area      text,
  p_details   text
)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_vendor  public.vendors%rowtype;
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
begin
  if not public.is_vendor_staff(p_vendor_id) then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if p_area is null or p_area not in ('ON_CAMPUS', 'OFF_CAMPUS') then
    raise exception 'say whether the store is on or off campus' using errcode = 'check_violation';
  end if;
  if v_details is null then
    raise exception 'say where the store is' using errcode = 'check_violation';
  end if;
  if char_length(v_details) > 160 then
    raise exception 'keep the location under 160 characters' using errcode = 'check_violation';
  end if;

  update public.vendors
     set location_area    = p_area,
         location_details = v_details
   where id = p_vendor_id
  returning * into v_vendor;

  return v_vendor;
end;
$$;

revoke all on function public.vendor_update_location(uuid, text, text) from public, anon;
grant execute on function public.vendor_update_location(uuid, text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. THE READ MODELS CARRY IT
-- ---------------------------------------------------------------------------
--
-- Same bodies, same filters, same grants. The two columns are appended at the
-- end of each result, so nothing that reads the existing columns by name sees
-- a difference. A return type cannot change in place, hence drop and create.

drop function if exists public.storefront_vendor(uuid);
create function public.storefront_vendor(p_vendor_id uuid)
returns table (
  vendor_id uuid,
  name text,
  description text,
  category_id uuid,
  category_name text,
  category_slug text,
  location_path text,
  location_note text,
  walk_minutes_to_campus integer,
  is_accepting_orders boolean,
  can_accept_scans boolean,
  images jsonb,
  location_area text,
  location_details text
)
language sql
stable
security definer
set search_path to ''
as $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.location_note, v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', i.id, 'storage_path', i.storage_path, 'caption', i.caption
                   ) order by i.sort_order, i.created_at)
                     from (select * from public.vendor_images i2
                            where i2.vendor_id = v.id
                            order by i2.sort_order, i2.created_at
                            limit 4) i), '[]'::jsonb),
         v.location_area, v.location_details
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.id = p_vendor_id and v.status = 'ACTIVE';
$$;

revoke all on function public.storefront_vendor(uuid) from public;
grant execute on function public.storefront_vendor(uuid) to anon, authenticated, service_role;


drop function if exists public.storefront_vendors(uuid, text);
create function public.storefront_vendors(
  p_category_id uuid default null,
  p_search      text default null
)
returns table (
  vendor_id uuid,
  name text,
  description text,
  category_id uuid,
  category_name text,
  category_slug text,
  location_path text,
  walk_minutes_to_campus integer,
  is_accepting_orders boolean,
  can_accept_scans boolean,
  image_path text,
  image_count bigint,
  menu_count bigint,
  location_area text,
  location_details text
)
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
           where m.vendor_id = v.id and m.is_active and m.is_available),
         v.location_area, v.location_details
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

revoke all on function public.storefront_vendors(uuid, text) from public;
grant execute on function public.storefront_vendors(uuid, text) to anon, authenticated, service_role;


drop function if exists public.my_vendor_application();
create function public.my_vendor_application()
returns table (
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
  can_use_variable_pricing boolean,
  location_area text,
  location_details text
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
         v.can_use_variable_pricing,
         v.location_area, v.location_details
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.owner_user_id = auth.uid();
$$;

revoke all on function public.my_vendor_application() from public;
grant execute on function public.my_vendor_application() to authenticated, service_role;
