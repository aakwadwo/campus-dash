-- ============================================================================
-- Campus locations
-- ============================================================================
-- No Google Maps. No GPS. No live tracking.
-- A database-backed tree the admin manages:
--   Academic City -> Hostel Block A -> Floor 2 -> Room 204
-- ============================================================================

create table public.locations (
  id           uuid primary key default gen_random_uuid(),
  parent_id    uuid references public.locations (id) on delete restrict,
  kind         public.location_kind not null,
  name         text not null,

  -- Can a customer choose this as a delivery destination? Floors and blocks are
  -- usually navigational nodes, not destinations.
  is_deliverable boolean not null default false,
  is_active      boolean not null default true,

  -- Admin-supplied walking minutes from the campus hub. NULL = unknown; the
  -- Partner offer omits the estimate rather than inventing one.
  walk_minutes integer check (walk_minutes >= 0),

  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A campus is the root of a tree and has no parent; everything else does.
  constraint locations_root_is_campus check (
    (parent_id is null) = (kind = 'CAMPUS')
  ),
  constraint locations_no_self_parent check (id <> parent_id)
);

create index locations_parent_idx on public.locations (parent_id);
create index locations_deliverable_idx on public.locations (id)
  where is_deliverable and is_active;
create unique index locations_sibling_name_unique
  on public.locations (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

create trigger locations_set_updated_at
  before update on public.locations
  for each row execute function public.set_updated_at();

alter table public.vendors
  add constraint vendors_location_fk
  foreign key (location_id) references public.locations (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Tree helpers
-- ---------------------------------------------------------------------------

-- Full readable path, e.g. "Academic City / Hostel Block A / Floor 2 / Room 204".
-- Shown to the Partner ONLY after the vendor confirms handoff.
create or replace function public.location_path(p_location_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up as (
    select l.id, l.parent_id, l.name, 0 as depth
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.name, up.depth + 1
      from public.locations l
      join up on l.id = up.parent_id
  )
  select string_agg(name, ' / ' order by depth desc) from up;
$$;

-- The BLOCK-level ancestor. This is the "zone" a Partner sees BEFORE accepting:
-- enough to judge the walk, not enough to identify the customer's room.
create or replace function public.location_zone(p_location_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with recursive up as (
    select l.id, l.parent_id, l.kind
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.kind
      from public.locations l
      join up on l.id = up.parent_id
  )
  select id from up where kind = 'BLOCK' limit 1;
$$;

-- Cycle guard. The tree is admin-editable, and a cycle would hang every
-- recursive query above.
create or replace function public.locations_prevent_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ancestor uuid := new.parent_id;
  v_hops     integer := 0;
begin
  while v_ancestor is not null loop
    if v_ancestor = new.id then
      raise exception 'location cycle detected at %', new.id using errcode = 'check_violation';
    end if;
    v_hops := v_hops + 1;
    if v_hops > 32 then
      raise exception 'location tree deeper than 32 levels' using errcode = 'check_violation';
    end if;
    select parent_id into v_ancestor from public.locations where id = v_ancestor;
  end loop;
  return new;
end;
$$;

create trigger locations_no_cycles
  before insert or update of parent_id on public.locations
  for each row execute function public.locations_prevent_cycle();
