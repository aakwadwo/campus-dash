-- ============================================================================
-- Vendor accounts, categories and store images
-- ============================================================================
-- The states this needs were added in the previous migration, on their own,
-- because Postgres will not let a transaction use an enum value it just added.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Categories — fixed, but the administrator owns the list
-- ---------------------------------------------------------------------------
-- Not an enum. An enum would need a migration (and a deploy) to add "Laundry",
-- and the person who knows a new kind of stall has opened is an operator with a
-- browser, not an engineer with a branch. Rows, with a stable slug: the slug is
-- what a vendor row and a bookmarked filter URL actually point at, so renaming
-- "Meals & Food" to "Hot Food" changes a label and breaks nothing.
create table if not exists public.vendor_categories (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null,
  name        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint vendor_categories_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint vendor_categories_name_shape check (btrim(name) <> '')
);

create unique index if not exists vendor_categories_slug_unique
  on public.vendor_categories (slug);

comment on table public.vendor_categories is
  'What kind of business a vendor is. Admin-managed rows rather than an enum, '
  'so the list can change without a deploy. Disabling a category hides it from '
  'the sign-up form and the customer filter; it never detaches the vendors '
  'already in it, and it never touches a historical order.';

comment on column public.vendor_categories.slug is
  'The stable identifier. Filters and vendor rows point at the category by id, '
  'and this is what makes a rename safe: the display name is free to change.';

drop trigger if exists set_vendor_categories_updated_at on public.vendor_categories;
create trigger set_vendor_categories_updated_at
  before update on public.vendor_categories
  for each row execute function public.set_updated_at();

-- Reference data. Every environment needs these, so they live in the migration
-- rather than the development seed. Fixed ids so a hosted project and a local
-- one agree.
insert into public.vendor_categories (id, slug, name, sort_order) values
  ('40000000-0000-4000-8000-000000000001', 'meals-food',         'Meals & Food',              10),
  ('40000000-0000-4000-8000-000000000002', 'snacks',             'Snacks',                    20),
  ('40000000-0000-4000-8000-000000000003', 'drinks-beverages',   'Drinks & Beverages',        30),
  ('40000000-0000-4000-8000-000000000004', 'bakery-pastries',    'Bakery & Pastries',         40),
  ('40000000-0000-4000-8000-000000000005', 'groceries',          'Groceries',                 50),
  ('40000000-0000-4000-8000-000000000006', 'fruits',             'Fruits',                    60),
  ('40000000-0000-4000-8000-000000000007', 'desserts',           'Desserts',                  70),
  ('40000000-0000-4000-8000-000000000008', 'personal-care',      'Personal Care',             80),
  ('40000000-0000-4000-8000-000000000009', 'fashion-accessories','Fashion & Accessories',     90),
  ('40000000-0000-4000-8000-00000000000a', 'electronics',        'Electronics & Accessories',100),
  ('40000000-0000-4000-8000-00000000000b', 'printing-stationery','Printing & Stationery',    110),
  ('40000000-0000-4000-8000-00000000000c', 'other',              'Other',                    120)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. A vendor has an owner
-- ---------------------------------------------------------------------------
alter table public.vendors
  add column if not exists owner_user_id    uuid references public.users(id) on delete restrict,
  add column if not exists category_id      uuid references public.vendor_categories(id) on delete restrict,
  add column if not exists description      text,
  add column if not exists applicant_name   text,
  add column if not exists owner_is_student boolean,
  add column if not exists rejection_reason text,
  add column if not exists submitted_at     timestamptz,
  add column if not exists reviewed_at      timestamptz,
  add column if not exists reviewed_by      uuid references public.users(id) on delete set null;

-- ONE IDENTITY, AT MOST ONE STORE. Not a limitation of the model — a deliberate
-- narrowing of it. Multiple stores per account would mean every vendor screen
-- needed a store picker, for a pilot in which nobody runs two.
create unique index if not exists vendors_owner_unique
  on public.vendors (owner_user_id) where owner_user_id is not null;

-- A rejection without a reason is a dead end: the vendor is told no and cannot
-- act on it. The state and the explanation travel together or not at all.
alter table public.vendors drop constraint if exists vendors_rejection_has_reason;
alter table public.vendors add constraint vendors_rejection_has_reason
  check (status <> 'REJECTED' or nullif(btrim(coalesce(rejection_reason, '')), '') is not null);

-- The phone was a contact number an admin typed in. For a self-registered
-- vendor it is the SIGN-IN CREDENTIAL, carried on the owner's identity row.
-- Kept here as well because a catalogue-only vendor has no owner to carry one,
-- and because a store's public number and its owner's login need not be the
-- same number forever.
comment on column public.vendors.phone is
  'The business contact number. NOT published on the storefront and NOT the '
  'owner''s sign-in credential — that lives on users.phone, on the owner''s own '
  'identity row, and is never exposed through a vendor read model.';

comment on column public.vendors.owner_user_id is
  'The identity that operates this business. NULL means a catalogue-only entry '
  '— a restaurant Campus Dash lists so a scan can be fetched from it, which has '
  'signed up for nothing and operates no dashboard. A NULL owner grants '
  'nothing to anybody: my_vendor_ids() matches no row.';

comment on column public.vendors.owner_is_student is
  'Whether the owner told us they are a student. INFORMATIONAL ONLY. It is not '
  'a capability and confers none — a student vendor is not thereby a Customer.';

-- Carry the staff links over. The earliest link becomes the owner; in practice
-- there has only ever been one per vendor.
update public.vendors v
   set owner_user_id = link.user_id,
       applicant_name = coalesce(v.applicant_name, u.full_name),
       submitted_at = coalesce(v.submitted_at, v.created_at)
  from (
    select distinct on (vendor_id) vendor_id, user_id
      from public.vendor_users
     order by vendor_id, created_at asc
  ) link
  join public.users u on u.id = link.user_id
 where link.vendor_id = v.id
   and v.owner_user_id is null;

-- Everything already live gets a category, so no existing storefront lands in
-- the customer list uncategorised.
update public.vendors
   set category_id = '40000000-0000-4000-8000-000000000001'
 where category_id is null;

-- ---------------------------------------------------------------------------
-- 3. The staff join table goes
-- ---------------------------------------------------------------------------
drop policy if exists vendor_users_read_self on public.vendor_users;
drop function if exists public.admin_add_vendor_user(uuid, text, text);
drop function if exists public.admin_remove_vendor_user(uuid, uuid, text);

create or replace function public.my_vendor_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select v.id
    from public.vendors v
    join public.users u on u.id = v.owner_user_id
   where v.owner_user_id = auth.uid() and not u.is_suspended;
$$;

-- Every remaining reader of vendor_users, repointed at the owner column. The
-- logic is unchanged in all of them; only the source of "who operates this
-- business" moved.
create or replace function public.my_outstanding_terms()
returns table (audience public.terms_audience, version integer, title text)
language sql
stable
security definer
set search_path = ''
as $$
  with required as (
    select 'CUSTOMER'::public.terms_audience as audience
     where exists (select 1 from public.customer_profiles c where c.user_id = auth.uid())
    union all
    select 'VENDOR'::public.terms_audience
     where exists (select 1 from public.vendors v where v.owner_user_id = auth.uid())
    union all
    select 'PARTNER'::public.terms_audience
     where exists (
       select 1 from public.partner_profiles p
        where p.user_id = auth.uid() and p.status = 'APPROVED'
     )
  ),
  current_docs as (
    select distinct on (t.audience) t.audience, t.version, t.title
      from public.terms_documents t
     where t.published_at is not null
     order by t.audience, t.version desc
  )
  select c.audience, c.version, c.title
    from required r
    join current_docs c on c.audience = r.audience
   where not exists (
     select 1 from public.terms_acceptances a
      where a.user_id = auth.uid() and a.audience = c.audience and a.version = c.version
   );
$$;

create or replace function public.my_capabilities()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then jsonb_build_object('authenticated', false)
    else (
      select jsonb_build_object(
        'authenticated',    true,
        'user_id',          u.id,
        'phone',            u.phone,
        'full_name',        u.full_name,
        'email',            u.email,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,

        'is_customer',      (c.user_id is not null) and not u.is_suspended,
        'can_order',        (c.user_id is not null) and not u.is_suspended,
        'customer_status',  case when c.user_id is not null then 'ONBOARDED'
                                 else 'NOT_ONBOARDED' end,
        'student_id_number', c.student_id_number,
        'level',            c.level,

        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),

        -- VENDOR. `vendor_ids` is what every existing screen and guard reads,
        -- and it still lists only OPERABLE businesses — an application still
        -- being reviewed is not one. `vendor_status` is what tells a pending
        -- applicant why their dashboard is a status page.
        'vendor_ids',       coalesce(
                              (select jsonb_agg(v.id)
                                 from public.vendors v
                                where v.owner_user_id = u.id
                                  and v.status = 'ACTIVE'
                                  and not u.is_suspended),
                              '[]'::jsonb),
        'vendor_status',    coalesce(
                              (select v.status::text from public.vendors v
                                where v.owner_user_id = u.id),
                              'NOT_APPLIED'),
        'vendor_id',        (select v.id from public.vendors v where v.owner_user_id = u.id)
      )
      from public.users u
      left join public.customer_profiles c on c.user_id = u.id
      left join public.partner_profiles  p on p.user_id = u.id
      where u.id = auth.uid()
    )
  end;
$$;

create or replace function public.get_delivery_offers()
returns table (
  order_id uuid, order_number text, vendor_name text, vendor_location text,
  destination_zone text, walk_minutes integer, earnings_pesewas bigint,
  item_count bigint, ready_at timestamptz, food_is_ready boolean,
  order_type public.order_type
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.order_number, v.name, public.location_path(v.location_id),
    coalesce(z.name, 'Campus'),
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    (o.order_type = 'FOOD'),
    o.order_type
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  where o.delivery_status = 'SEARCHING'
    and o.order_status = 'READY'
    and o.payment_status = 'PAID'
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    and not exists (
      select 1 from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
    and o.customer_id <> auth.uid()
    -- CONFLICT OF INTEREST: never a store you own.
    and v.owner_user_id is distinct from auth.uid()
  order by o.ready_at asc;
$$;

create or replace function public.admin_customer_detail(p_user_id uuid)
returns table (
  user_id uuid, full_name text, phone text, email text,
  student_id_number text, level text, is_suspended boolean, is_admin boolean,
  onboarded_at timestamptz, created_at timestamptz,
  partner_status text, partner_applied_at timestamptz,
  vendor_names text[], order_count bigint, completed_count bigint,
  spent_pesewas bigint, recent_orders jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.level,
         u.is_suspended, u.is_admin, c.onboarded_at, u.created_at,
         coalesce(p.status::text, 'NOT_APPLIED'), p.applied_at,
         coalesce((select array_agg(v.name order by v.name)
                     from public.vendors v where v.owner_user_id = u.id), '{}'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select coalesce(sum(pay.amount_pesewas),0)::bigint
            from public.payments pay
            join public.orders o on o.id = pay.order_id
           where o.customer_id = u.id and pay.status = 'SUCCEEDED'),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'order_status', o.order_status,
                     'payment_status', o.payment_status, 'delivery_status', o.delivery_status,
                     'total_pesewas', o.total_pesewas, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2
                    where o2.customer_id = u.id and o2.order_status <> 'DRAFT'
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.customer_profiles c on c.user_id = u.id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin() and u.id = p_user_id;
$$;

create or replace function public.partner_accept_delivery(p_order_id uuid)
returns table (success boolean, reason text, order_number text, pickup_code text, vendor_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_code    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
      from public.orders o
      join public.vendors v on v.id = o.vendor_id
     where o.id = p_order_id and v.owner_user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a store you own'
      using errcode = 'insufficient_privilege';
  end if;

  v_code := public.generate_numeric_code(4);

  update public.orders o
     set partner_id = v_partner,
         delivery_status = 'ASSIGNED',
         assigned_at = now()
   where o.id = p_order_id
     and o.delivery_status = 'SEARCHING'
     and o.order_status = 'READY'
     and o.payment_status = 'PAID'
     and o.partner_id is null
     and exists (
       select 1 from public.partner_profiles p
        where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
     )
     and not exists (
       select 1 from public.orders a
        where a.partner_id = v_partner
          and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
     )
     and o.customer_id <> v_partner
     and not exists (
       select 1 from public.vendors v
        where v.id = o.vendor_id and v.owner_user_id = v_partner
     )
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text, null::text;
    return;
  end if;

  update public.order_secrets
     set pickup_code = v_code,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now())
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED');

  return query
    select true, null::text, v_order.order_number, v_code, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;

drop table if exists public.vendor_users;

-- ---------------------------------------------------------------------------
-- 4. Store images
-- ---------------------------------------------------------------------------
-- One gallery, no separate logo. A logo is a second thing to design, upload,
-- crop and moderate, and the pilot's stalls do not have one.
create table if not exists public.vendor_images (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references public.vendors(id) on delete cascade,
  storage_path text not null,
  content_type text not null,
  byte_size    bigint not null check (byte_size > 0),
  caption      text,
  sort_order   integer not null default 0,
  uploaded_by  uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint vendor_images_path_shape check (btrim(storage_path) <> '')
);

create index if not exists vendor_images_vendor_idx
  on public.vendor_images (vendor_id, sort_order, created_at);

comment on table public.vendor_images is
  'A vendor''s storefront gallery. The objects live in the PUBLIC vendor-images '
  'bucket, because an unauthenticated visitor browsing the marketplace has to '
  'be able to see them and a signed URL per photo per page load is a cost with '
  'no matching secret. Nothing private is ever put here; the bucket takes no '
  'client writes, so what appears in it went through a server that checked who '
  'was asking.';

-- Public to read, because the marketplace is browsable signed out. Writes go
-- nowhere near a client: no INSERT/UPDATE/DELETE policy exists, and the grant
-- below is SELECT only.
alter table public.vendor_images enable row level security;

drop policy if exists vendor_images_read_public on public.vendor_images;
create policy vendor_images_read_public on public.vendor_images
  for select to anon, authenticated
  using (exists (select 1 from public.vendors v where v.id = vendor_id and v.status = 'ACTIVE'));

drop policy if exists vendor_images_read_own on public.vendor_images;
create policy vendor_images_read_own on public.vendor_images
  for select to authenticated using (public.is_vendor_staff(vendor_id));

drop policy if exists vendor_images_read_admin on public.vendor_images;
create policy vendor_images_read_admin on public.vendor_images
  for select to authenticated using (public.is_admin());

grant select on public.vendor_images to anon, authenticated;

alter table public.vendor_categories enable row level security;

drop policy if exists vendor_categories_read_active on public.vendor_categories;
create policy vendor_categories_read_active on public.vendor_categories
  for select to anon, authenticated using (is_active or public.is_admin());

grant select on public.vendor_categories to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vendor-images', 'vendor-images',
  true,                                    -- storefront photography, not evidence
  5 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
   set public             = true,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- No storage.objects policies, exactly as with the private buckets: RLS denies
-- every client write. Reads on a public bucket are served without one.

-- ---------------------------------------------------------------------------
-- 5. Signing up
-- ---------------------------------------------------------------------------
-- The FORM comes first and the code second, which is the opposite of what the
-- old flow did and the opposite of what is easy to build. Asking for a phone
-- number and a 6-digit code before saying what the thing is asks somebody to
-- prove who they are before they have decided to be here. So the applicant
-- fills the form, verifies the number, and this runs with the form data on the
-- session that verification just created.
create or replace function public.vendor_signup(
  p_applicant_name text,
  p_store_name     text,
  p_is_student     boolean,
  p_description    text,
  p_category_id    uuid,
  p_terms_id       uuid
)
returns public.vendors
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_phone  text;
  v_vendor public.vendors%rowtype;
  v_doc    public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- The verified number IS the vendor's credential, so it is read from the
  -- identity row rather than accepted as a parameter.
  select phone into v_phone from public.users where id = v_user;
  if coalesce(v_phone, '') = '' then
    raise exception 'verify your phone number before registering a store'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_applicant_name, '')), '') is null then
    raise exception 'your name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_store_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null then
    raise exception 'describe what your store sells' using errcode = 'check_violation';
  end if;
  if p_is_student is null then
    raise exception 'say whether you are a student' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.vendor_categories where id = p_category_id and is_active
  ) then
    raise exception 'choose a business category' using errcode = 'check_violation';
  end if;

  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null or v_doc.audience <> 'VENDOR' then
    raise exception 'the vendor terms must be accepted to continue'
      using errcode = 'check_violation';
  end if;
  if v_doc.version <> (
    select max(t.version) from public.terms_documents t
     where t.audience = 'VENDOR' and t.published_at is not null
  ) then
    raise exception 'those terms have been superseded; reload and try again'
      using errcode = 'check_violation';
  end if;

  select * into v_vendor from public.vendors where owner_user_id = v_user;

  if found then
    -- RESUBMISSION. A rejected applicant corrects what was wrong and comes
    -- back; that is the whole point of telling them the reason. Anything else
    -- is not a second application.
    if v_vendor.status <> 'REJECTED' then
      raise exception 'this account already has a store (%)' , v_vendor.status
        using errcode = 'check_violation';
    end if;

    update public.vendors
       set name             = btrim(p_store_name),
           description      = btrim(p_description),
           category_id      = p_category_id,
           applicant_name   = btrim(p_applicant_name),
           owner_is_student = p_is_student,
           phone            = v_phone,
           status           = 'PENDING_APPROVAL',
           rejection_reason = null,
           reviewed_at      = null,
           reviewed_by      = null,
           submitted_at     = now()
     where id = v_vendor.id
    returning * into v_vendor;
  else
    insert into public.vendors (
      name, phone, status, is_accepting_orders,
      owner_user_id, category_id, description, applicant_name, owner_is_student,
      submitted_at
    )
    values (
      btrim(p_store_name), v_phone, 'PENDING_APPROVAL', false,
      v_user, p_category_id, btrim(p_description), btrim(p_applicant_name),
      p_is_student, now()
    )
    returning * into v_vendor;
  end if;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (v_user, v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version)
    do update set accepted_at = public.terms_acceptances.accepted_at;

  return v_vendor;
end;
$$;

revoke all on function public.vendor_signup(text, text, boolean, text, uuid, uuid) from public;
grant execute on function public.vendor_signup(text, text, boolean, text, uuid, uuid) to authenticated;

-- The applicant's own view of where their application stands. Deliberately
-- NOT gated on being approved: a pending or rejected vendor has to be able to
-- sign in and see why.
create or replace function public.my_vendor_application()
returns table (
  vendor_id uuid, name text, status public.vendor_status,
  description text, category_id uuid, category_name text,
  applicant_name text, owner_is_student boolean,
  is_accepting_orders boolean, rejection_reason text,
  submitted_at timestamptz, reviewed_at timestamptz,
  location_id uuid, location_note text, walk_minutes_to_campus integer,
  can_accept_scans boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.status, v.description, v.category_id, k.name,
         v.applicant_name, v.owner_is_student, v.is_accepting_orders,
         v.rejection_reason, v.submitted_at, v.reviewed_at,
         v.location_id, v.location_note, v.walk_minutes_to_campus,
         v.can_accept_scans
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.owner_user_id = auth.uid();
$$;

grant execute on function public.my_vendor_application() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The vendor's own profile
-- ---------------------------------------------------------------------------
-- The store name, what it sells, where it is and what kind of business it is
-- are the vendor's own facts. An operator should not have to email an
-- administrator to fix a typo in their own shop name.
create or replace function public.vendor_update_profile(
  p_vendor_id     uuid,
  p_name          text,
  p_description   text,
  p_category_id   uuid,
  p_location_id   uuid default null,
  p_location_note text default null,
  p_walk_minutes  integer default null
)
returns public.vendors
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if p_category_id is not null and not exists (
    select 1 from public.vendor_categories where id = p_category_id
  ) then
    raise exception 'that category does not exist' using errcode = 'check_violation';
  end if;
  if p_walk_minutes is not null and p_walk_minutes < 0 then
    raise exception 'walking time cannot be negative' using errcode = 'check_violation';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.locations where id = p_location_id
  ) then
    raise exception 'that location does not exist' using errcode = 'check_violation';
  end if;

  update public.vendors
     set name                   = btrim(p_name),
         description            = nullif(btrim(coalesce(p_description, '')), ''),
         category_id            = coalesce(p_category_id, category_id),
         location_id            = p_location_id,
         location_note          = nullif(btrim(coalesce(p_location_note, '')), ''),
         walk_minutes_to_campus = p_walk_minutes
   where id = p_vendor_id
  returning * into v_vendor;

  return v_vendor;
end;
$$;

revoke all on function public.vendor_update_profile(uuid, text, text, uuid, uuid, text, integer) from public;
grant execute on function public.vendor_update_profile(uuid, text, text, uuid, uuid, text, integer) to authenticated;

-- Images. The same function serves the vendor and the administrator, because
-- the authorisation question is the same one and duplicating it would be two
-- places to get it wrong. The object itself is uploaded server-side first; this
-- records it.
create or replace function public.vendor_add_image(
  p_vendor_id    uuid,
  p_storage_path text,
  p_content_type text,
  p_byte_size    bigint,
  p_caption      text default null
)
returns public.vendor_images
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image public.vendor_images%rowtype;
  v_count integer;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'no image was received' using errcode = 'check_violation';
  end if;

  -- A gallery, not a photo dump. Twelve is more than any pilot stall will use
  -- and small enough that the storefront stays a page rather than a scroll.
  select count(*) into v_count from public.vendor_images where vendor_id = p_vendor_id;
  if v_count >= 12 then
    raise exception 'a store may have at most 12 images; delete one first'
      using errcode = 'check_violation';
  end if;

  insert into public.vendor_images (
    vendor_id, storage_path, content_type, byte_size, caption, sort_order, uploaded_by
  )
  values (
    p_vendor_id, btrim(p_storage_path), p_content_type, p_byte_size,
    nullif(btrim(coalesce(p_caption, '')), ''), v_count, auth.uid()
  )
  returning * into v_image;

  return v_image;
end;
$$;

revoke all on function public.vendor_add_image(uuid, text, text, bigint, text) from public;
grant execute on function public.vendor_add_image(uuid, text, text, bigint, text) to authenticated;

create or replace function public.vendor_delete_image(p_image_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_image public.vendor_images%rowtype;
begin
  select * into v_image from public.vendor_images where id = p_image_id;
  if not found then
    raise exception 'no such image' using errcode = 'no_data_found';
  end if;
  if not public.is_vendor_staff(v_image.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  delete from public.vendor_images where id = p_image_id;

  -- The caller deletes the object itself; SQL cannot reach the Storage API.
  return v_image.storage_path;
end;
$$;

revoke all on function public.vendor_delete_image(uuid) from public;
grant execute on function public.vendor_delete_image(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Review
-- ---------------------------------------------------------------------------
create or replace function public.admin_review_vendor(
  p_vendor_id uuid,
  p_status    public.vendor_status,
  p_reason    text
)
returns public.vendors
language plpgsql
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
  if p_status not in ('ACTIVE', 'REJECTED') then
    raise exception 'a review decision is APPROVE (ACTIVE) or REJECT (REJECTED)'
      using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required, and is recorded in the audit log'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  update public.vendors
     set status = p_status,
         rejection_reason = case when p_status = 'REJECTED' then btrim(p_reason) end,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         -- APPROVAL DOES NOT OPEN THE STORE. Going live is the vendor's own
         -- decision, made when they are actually standing behind the counter.
         is_accepting_orders = false
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    case when p_status = 'ACTIVE' then 'VENDOR_APPROVED' else 'VENDOR_REJECTED' end,
    'vendor', p_vendor_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

revoke all on function public.admin_review_vendor(uuid, public.vendor_status, text) from public;
grant execute on function public.admin_review_vendor(uuid, public.vendor_status, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Category administration
-- ---------------------------------------------------------------------------
create or replace function public.admin_vendor_categories()
returns table (
  id uuid, slug text, name text, sort_order integer, is_active boolean,
  vendor_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.slug, k.name, k.sort_order, k.is_active,
         (select count(*) from public.vendors v where v.category_id = k.id)
    from public.vendor_categories k
   where public.is_admin()
   order by k.sort_order, k.name;
$$;
grant execute on function public.admin_vendor_categories() to authenticated;

create or replace function public.admin_create_vendor_category(
  p_slug text, p_name text, p_sort_order integer, p_reason text
)
returns public.vendor_categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.vendor_categories%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.vendor_categories (slug, name, sort_order)
  values (lower(btrim(p_slug)), btrim(p_name), coalesce(p_sort_order, 0))
  returning * into v_row;

  perform public.log_admin_action(
    'VENDOR_CATEGORY_CREATE', 'vendor_category', v_row.id, p_reason, null, to_jsonb(v_row)
  );
  return v_row;
end;
$$;
revoke all on function public.admin_create_vendor_category(text, text, integer, text) from public;
grant execute on function public.admin_create_vendor_category(text, text, integer, text) to authenticated;

create or replace function public.admin_update_vendor_category(
  p_category_id uuid, p_name text, p_sort_order integer, p_is_active boolean, p_reason text
)
returns public.vendor_categories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.vendor_categories%rowtype;
  v_after  public.vendor_categories%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendor_categories where id = p_category_id;
  if not found then
    raise exception 'no such category' using errcode = 'no_data_found';
  end if;

  -- DISABLING IS NOT DELETING, and nothing about it touches a vendor row. A
  -- disabled category disappears from the sign-up form and the customer filter;
  -- the stalls already in it keep trading and every historical order keeps the
  -- category it was placed under.
  update public.vendor_categories
     set name       = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         sort_order = coalesce(p_sort_order, sort_order),
         is_active  = coalesce(p_is_active, is_active)
   where id = p_category_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_CATEGORY_UPDATE', 'vendor_category', p_category_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$$;
revoke all on function public.admin_update_vendor_category(uuid, text, integer, boolean, text) from public;
grant execute on function public.admin_update_vendor_category(uuid, text, integer, boolean, text) to authenticated;

-- Public list, for the sign-up form and the customer filter. Active only.
create or replace function public.vendor_categories()
returns table (id uuid, slug text, name text, sort_order integer)
language sql
stable
security definer
set search_path = ''
as $$
  select k.id, k.slug, k.name, k.sort_order
    from public.vendor_categories k
   where k.is_active
   order by k.sort_order, k.name;
$$;
grant execute on function public.vendor_categories() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Admin read models
-- ---------------------------------------------------------------------------
drop function if exists public.admin_vendors();
create function public.admin_vendors(
  p_search      text default null,
  p_status      text default null,
  p_category_id uuid default null
)
returns table (
  vendor_id uuid, name text, phone text, status public.vendor_status,
  is_accepting_orders boolean, can_accept_scans boolean, location_path text,
  category_id uuid, category_name text, description text,
  applicant_name text, owner_is_student boolean, owner_user_id uuid,
  owner_name text, owner_phone text, rejection_reason text,
  submitted_at timestamptz, reviewed_at timestamptz,
  image_count bigint, menu_count bigint, order_count bigint, owed_pesewas bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.phone, v.status, v.is_accepting_orders, v.can_accept_scans,
         public.location_path(v.location_id),
         v.category_id, k.name, v.description,
         v.applicant_name, v.owner_is_student, v.owner_user_id,
         o.full_name, o.phone, v.rejection_reason,
         v.submitted_at, v.reviewed_at,
         (select count(*) from public.vendor_images i where i.vendor_id = v.id),
         (select count(*) from public.menu_items m where m.vendor_id = v.id),
         (select count(*) from public.orders ord where ord.vendor_id = v.id and ord.order_status <> 'DRAFT'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'VENDOR' and a.payee_id = v.id and a.status in ('PENDING','ELIGIBLE'))
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
    left join public.users o on o.id = v.owner_user_id
   where public.is_admin()
     and (p_status is null or btrim(p_status) = '' or v.status::text = p_status)
     and (p_category_id is null or v.category_id = p_category_id)
     and (p_search is null or btrim(p_search) = ''
          or v.name ilike '%' || btrim(p_search) || '%'
          or coalesce(v.phone,'') ilike '%' || btrim(p_search) || '%'
          or coalesce(v.applicant_name,'') ilike '%' || btrim(p_search) || '%')
   order by
     case v.status when 'PENDING_APPROVAL' then 0 when 'ACTIVE' then 1 else 2 end,
     v.name;
$$;
grant execute on function public.admin_vendors(text, text, uuid) to authenticated;

-- Admin vendor creation survives, narrowed to what it is now FOR: a catalogue
-- entry for a business that has not signed up and will not — a restaurant a
-- scan is fetched from. It creates no account, no owner and no login.
drop function if exists public.admin_create_vendor(text, text, text, uuid, text, integer);
create function public.admin_create_vendor(
  p_name                   text,
  p_phone                  text,
  p_reason                 text,
  p_category_id            uuid    default null,
  p_location_id            uuid    default null,
  p_location_note          text    default null,
  p_walk_minutes_to_campus integer default null
)
returns public.vendors
language plpgsql
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

  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    category_id, location_id, location_note, walk_minutes_to_campus
  )
  values (
    btrim(p_name), p_phone, 'DRAFT', false,
    coalesce(p_category_id, '40000000-0000-4000-8000-000000000001'),
    p_location_id, p_location_note, p_walk_minutes_to_campus
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor)
  );

  return v_vendor;
end;
$$;
revoke all on function public.admin_create_vendor(text, text, text, uuid, uuid, text, integer) from public;
grant execute on function public.admin_create_vendor(text, text, text, uuid, uuid, text, integer) to authenticated;

-- The admin edit form gains the category, so a miscategorised stall can be
-- fixed without asking its owner to do it.
drop function if exists public.admin_update_vendor(uuid, text, text, text, uuid, text, integer);
create function public.admin_update_vendor(
  p_vendor_id              uuid,
  p_reason                 text,
  p_name                   text    default null,
  p_phone                  text    default null,
  p_category_id            uuid    default null,
  p_description            text    default null,
  p_location_id            uuid    default null,
  p_location_note          text    default null,
  p_walk_minutes_to_campus integer default null
)
returns public.vendors
language plpgsql
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
         category_id            = coalesce(p_category_id, category_id),
         description            = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
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
revoke all on function public.admin_update_vendor(uuid, text, text, text, uuid, text, uuid, text, integer) from public;
grant execute on function public.admin_update_vendor(uuid, text, text, text, uuid, text, uuid, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10. The storefront a customer sees
-- ---------------------------------------------------------------------------
-- Browsable signed out, so this is anon-callable and returns only what a
-- storefront shows. THE VENDOR'S PHONE NUMBER IS NOT IN IT — a customer has no
-- business ringing a stall directly, and the owner's number is their login.
create or replace function public.storefront_vendors(
  p_category_id uuid default null,
  p_search      text default null
)
returns table (
  vendor_id uuid, name text, description text,
  category_id uuid, category_name text, category_slug text,
  location_path text, walk_minutes_to_campus integer,
  is_accepting_orders boolean, can_accept_scans boolean,
  image_path text, image_count bigint, menu_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.vendor_images i where i.vendor_id = v.id),
         (select count(*) from public.menu_items m where m.vendor_id = v.id and m.is_available)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.status = 'ACTIVE'
     and (p_category_id is null or v.category_id = p_category_id)
     and (p_search is null or btrim(p_search) = ''
          or v.name ilike '%' || btrim(p_search) || '%'
          or coalesce(v.description,'') ilike '%' || btrim(p_search) || '%')
   -- Open stalls first. A CLOSED one still appears, with its menu, because
   -- "they are closed right now" is information a customer wants; a stall that
   -- vanishes at 9pm reads as one that has left the platform.
   order by v.is_accepting_orders desc, v.name;
$$;
grant execute on function public.storefront_vendors(uuid, text) to anon, authenticated;

create or replace function public.storefront_vendor(p_vendor_id uuid)
returns table (
  vendor_id uuid, name text, description text,
  category_id uuid, category_name text, category_slug text,
  location_path text, location_note text, walk_minutes_to_campus integer,
  is_accepting_orders boolean, can_accept_scans boolean, images jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.location_note, v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', i.id, 'storage_path', i.storage_path, 'caption', i.caption
                   ) order by i.sort_order, i.created_at)
                     from public.vendor_images i where i.vendor_id = v.id), '[]'::jsonb)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.id = p_vendor_id and v.status = 'ACTIVE';
$$;
grant execute on function public.storefront_vendor(uuid) to anon, authenticated;
