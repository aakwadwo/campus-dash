-- ============================================================================
-- Customer becomes a capability
-- ============================================================================
-- IDENTITY IS NOT CAPABILITY.
--
-- The identity half of this was already right: public.users.id IS
-- auth.users.id, partner_profiles is an optional one-to-one row on that id,
-- is_admin is a boolean on the same row, and vendor access is a vendor_users
-- join. Nothing was ever a mutually exclusive account type.
--
-- The capability half was not. my_capabilities() computed
--
--     can_order := not u.is_suspended
--
-- so EVERY provisioned account could place an order: a vendor account, an
-- administrator, an applicant who had uploaded nothing. There was no way to
-- say "admin does not imply customer" because there was no customer capability
-- to withhold. This migration adds one.
--
-- CUSTOMER IS A ROW THAT EXISTS
-- -----------------------------
-- Exactly the shape partner_profiles already has, so nothing in the codebase
-- has to learn a new idea. public.users keeps identity and contact — phone,
-- email, name, suspension, admin. The student facts that evidence the CUSTOMER
-- capability move to customer_profiles, where they belong.
--
-- PARTNER ⇒ CUSTOMER IS A FOREIGN KEY
-- -----------------------------------
-- Not a check in a function that a service-role INSERT could route around: a
-- real FK from partner_profiles.user_id to customer_profiles.user_id, ON DELETE
-- RESTRICT. A Partner profile cannot exist without a Customer profile beneath
-- it, and a Customer profile cannot be removed from under a Partner. That is
-- the invariant "a Partner is always also a Customer", stated where it cannot
-- be forgotten.
--
-- CUSTOMER ⇏ PARTNER is unchanged: is_approved_partner() still requires status
-- APPROVED, and approval is still a manual admin decision.
--
-- ADMIN AND VENDOR ARE UNCHANGED, DELIBERATELY
-- --------------------------------------------
-- is_admin() and every admin_* body keep their own re-check. vendor_users stays
-- exactly as it is — which is what keeps the Partner vendor-staff exclusion
-- working. Neither creates a customer_profiles row, so "admin does not imply
-- customer" and "vendor does not imply customer" are true by construction
-- rather than by a rule someone has to remember.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH
-- ----------------------------------
-- get_delivery_offers(), partner_accept_delivery(), the own-order exclusion,
-- the vendor-staff exclusion, the atomic claim, payments, webhooks, settlement,
-- payouts, transfers, the 5% service fee, pg_cron and the delivery state
-- machine. submit_order_for() is recreated verbatim apart from one added
-- assertion; every pesewa of its arithmetic is byte-identical.
--
-- NOTHING HERE DELETES DATA. The only DELETEs are none; the only destructive
-- verbs are DROP COLUMN on two columns whose values are copied first, and DROP
-- FUNCTION on signatures that are immediately recreated. Where existing data
-- cannot satisfy a new invariant this migration RAISES and names the rows
-- rather than repairing them silently.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The Customer capability
-- ---------------------------------------------------------------------------
create table if not exists public.customer_profiles (
  user_id               uuid primary key references public.users (id) on delete cascade,

  -- Declared, never verified against a registry — there is no registry to ask.
  -- The ID photograph is what a human can check if a dispute ever needs it.
  student_id_number     text not null,
  class_year            text not null,

  -- Private Storage object path, same bucket and same rules as the Partner
  -- face photograph: no public URL ever, admin-only through a signed URL.
  student_id_image_path text not null,

  -- The moment the capability was granted. Not nullable: a row that exists IS
  -- the capability, so there is no half-onboarded state to represent.
  onboarded_at          timestamptz not null default now(),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint customer_student_id_shape check (btrim(student_id_number) <> ''),
  constraint customer_class_year_shape check (btrim(class_year) <> ''),
  constraint customer_id_image_shape   check (btrim(student_id_image_path) <> '')
);

comment on table public.customer_profiles is
  'The CUSTOMER capability. A row here is the capability; there is no flag. '
  'Admin and vendor-staff accounts do not get one automatically.';

drop trigger if exists customer_profiles_set_updated_at on public.customer_profiles;
create trigger customer_profiles_set_updated_at
  before update on public.customer_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Relocate the student facts, without inventing any
-- ---------------------------------------------------------------------------
-- users.student_id_number and users.class_year were written only by
-- partner_apply(). They are evidence for a capability, not identity, so they
-- move to the capability's own row.
--
-- Anyone who already holds a partner_profiles row must end up with a
-- customer_profiles row, or the foreign key added in step 3 cannot be created.
-- Their student ID PHOTOGRAPH is the same document in both models, so it is
-- carried across rather than re-collected.
--
-- If a legacy applicant is missing a value this migration REFUSES rather than
-- substituting a placeholder. A fabricated class year in an identity record is
-- worse than a failed migration, and the failure names exactly who to look at.
do $$
declare
  v_incomplete text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'users'
       and column_name = 'student_id_number'
  ) then
    return;  -- already migrated
  end if;

  select string_agg(p.user_id::text, ', ' order by p.user_id)
    into v_incomplete
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
   where not exists (select 1 from public.customer_profiles c where c.user_id = p.user_id)
     and (
       nullif(btrim(coalesce(u.student_id_number, '')), '') is null
       or nullif(btrim(coalesce(u.class_year, '')), '') is null
       or nullif(btrim(coalesce(p.student_id_image_path, '')), '') is null
     );

  if v_incomplete is not null then
    raise exception
      'cannot grant the CUSTOMER capability to existing Partner records %: '
      'student ID number, class year or ID photograph is missing. '
      'Complete or remove these partner_profiles rows and re-run. '
      'Nothing has been changed.', v_incomplete
      using errcode = 'check_violation';
  end if;

  insert into public.customer_profiles (
    user_id, student_id_number, class_year, student_id_image_path, onboarded_at
  )
  select p.user_id, btrim(u.student_id_number), btrim(u.class_year),
         p.student_id_image_path, coalesce(p.applied_at, now())
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
  on conflict (user_id) do nothing;
end;
$$;

-- The approved-Partner student ID uniqueness index moves with the column it
-- guards. Same rule, better home: one student ID backs one Customer identity.
drop index if exists public.partner_profiles_student_id_unique;

create unique index if not exists customer_profiles_student_id_unique
  on public.customer_profiles (student_id_number);

alter table public.users drop column if exists student_id_number;
alter table public.users drop column if exists class_year;
alter table public.users drop constraint if exists users_class_year_shape;

-- partner_profiles no longer holds the student ID photograph: that is the
-- Customer's document now, collected at onboarding and reused by the
-- application. The Partner application adds exactly one thing — the live face.
alter table public.partner_profiles drop column if exists student_id_image_path;

-- ---------------------------------------------------------------------------
-- 3. PARTNER ⇒ CUSTOMER, as a constraint rather than a convention
-- ---------------------------------------------------------------------------
alter table public.partner_profiles
  drop constraint if exists partner_requires_customer;
alter table public.partner_profiles
  add constraint partner_requires_customer
  foreign key (user_id) references public.customer_profiles (user_id)
  on delete restrict;

comment on constraint partner_requires_customer on public.partner_profiles is
  'A Partner is always also a Customer. The Customer capability cannot be '
  'removed from under an existing Partner profile.';

-- ---------------------------------------------------------------------------
-- 4. One email, one identity
-- ---------------------------------------------------------------------------
-- users.email had a shape CHECK and no uniqueness at all, so two distinct auth
-- identities could hold the same address. That is the finding with the longest
-- tail: a future OAuth provider linking accounts by verified email would merge
-- two people who were never the same person.
--
-- The index is on lower(email) rather than the raw column, because
-- Ama@example.com and ama@example.com are one address to every mail system on
-- earth and must be one address here. set_my_email() already lowercased on
-- write; partner_apply() did not, so existing values are normalised first.
-- Lower-casing an address is a formatting normalisation, not a change of fact.
--
-- THIS IS NOT AN IDENTITY KEY. Identity remains auth.users.id. Email is a
-- contact and credential attribute that happens to be unique — which is
-- precisely what makes future OAuth linking unambiguous without ever making
-- the address something a capability hangs off.
update public.users
   set email = lower(btrim(email))
 where email is not null and email <> lower(btrim(email));

do $$
declare
  v_dupes text;
begin
  select string_agg(distinct email, ', ')
    into v_dupes
    from (
      select email from public.users
       where email is not null
       group by email having count(*) > 1
    ) d;

  if v_dupes is not null then
    raise exception
      'these email addresses are held by more than one account: %. '
      'One email must belong to one identity. Resolve them by hand — this '
      'migration will not choose which account keeps an address. '
      'Nothing has been changed.', v_dupes
      using errcode = 'unique_violation';
  end if;
end;
$$;

create unique index if not exists users_email_unique
  on public.users (lower(email))
  where email is not null;

comment on index public.users_email_unique is
  'ONE EMAIL → ONE ACCOUNT IDENTITY. Not an identity key: auth.users.id is. '
  'Makes future OAuth account-linking unambiguous.';

-- ---------------------------------------------------------------------------
-- 5. is_customer()
-- ---------------------------------------------------------------------------
-- Same shape as is_approved_partner(), and suspension is checked in exactly the
-- same place, so the two capabilities behave alike under suspension.
create or replace function public.is_customer(p_user_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.customer_profiles c
      join public.users u on u.id = c.user_id
     where c.user_id = coalesce(p_user_id, auth.uid())
       and not u.is_suspended
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Onboarding — the only way to acquire the Customer capability
-- ---------------------------------------------------------------------------
-- Terms acceptance happens in THIS transaction, not on a later screen the user
-- can skip. A capability granted before the agreement it depends on is a gate
-- that opens itself.
create or replace function public.complete_customer_onboarding(
  p_full_name             text,
  p_student_id_number     text,
  p_class_year            text,
  p_email                 text,
  p_student_id_image_path text,
  p_terms_id              uuid
)
returns public.customer_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_profile public.customer_profiles%rowtype;
  v_doc     public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- Every field is required. A half-filled identity record is not a lighter
  -- version of this capability, it is an unusable one.
  if nullif(btrim(coalesce(p_full_name, '')), '') is null then
    raise exception 'your full name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_student_id_number, '')), '') is null then
    raise exception 'a student ID number is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_class_year, '')), '') is null then
    raise exception 'a class year is required' using errcode = 'check_violation';
  end if;
  if v_email = '' then
    raise exception 'an email address is required' using errcode = 'check_violation';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address does not look like an address'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null then
    raise exception 'a photograph of your student ID is required'
      using errcode = 'check_violation';
  end if;

  -- The terms must be the CURRENT published customer terms. Accepting a
  -- superseded version, or a Partner document, is not consent to these.
  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null or v_doc.audience <> 'CUSTOMER' then
    raise exception 'the customer terms must be accepted to continue'
      using errcode = 'check_violation';
  end if;
  if v_doc.version <> (
    select max(t.version) from public.terms_documents t
     where t.audience = 'CUSTOMER' and t.published_at is not null
  ) then
    raise exception 'those terms have been superseded; reload and try again'
      using errcode = 'check_violation';
  end if;

  -- Identity fields live on public.users; capability evidence lives on the
  -- profile. The split is the whole point of this migration.
  begin
    update public.users
       set full_name = btrim(p_full_name),
           email     = v_email
     where id = v_user;
  exception when unique_violation then
    raise exception 'that email address is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end;

  begin
    insert into public.customer_profiles (
      user_id, student_id_number, class_year, student_id_image_path
    )
    values (
      v_user, btrim(p_student_id_number), btrim(p_class_year), btrim(p_student_id_image_path)
    )
    -- Re-running onboarding updates the declared facts. It never revokes the
    -- capability, and it never moves onboarded_at: when someone became a
    -- customer is a fact about the past.
    on conflict (user_id) do update
       set student_id_number     = excluded.student_id_number,
           class_year            = excluded.class_year,
           student_id_image_path = excluded.student_id_image_path
    returning * into v_profile;
  exception when unique_violation then
    raise exception 'that student ID number is already registered to another account'
      using errcode = 'unique_violation';
  end;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (v_user, v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version)
    do update set accepted_at = public.terms_acceptances.accepted_at;

  return v_profile;
end;
$$;

-- What the signed-in account has declared about itself. Never the storage path:
-- the customer has no reason to hold a storage key.
create or replace function public.my_customer_profile()
returns table (
  student_id_number text,
  class_year        text,
  has_student_id    boolean,
  onboarded_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.student_id_number, c.class_year,
         nullif(btrim(c.student_id_image_path), '') is not null,
         c.onboarded_at
    from public.customer_profiles c
   where c.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 7. Capabilities — additive, and now honest about Customer
-- ---------------------------------------------------------------------------
-- Every capability is independent and every one is derived from the database on
-- this request. Holding one never confers another:
--
--   is_admin     users.is_admin
--   is_customer  a customer_profiles row
--   is_partner   a customer_profiles row AND an APPROVED partner_profiles row
--   vendor_ids   vendor_users links
--
-- can_order keeps its name because half the application reads it, but it is no
-- longer "has a pulse". It is the Customer capability.
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

        -- CUSTOMER: a completed onboarding, not merely an account.
        'is_customer',      (c.user_id is not null) and not u.is_suspended,
        'can_order',        (c.user_id is not null) and not u.is_suspended,
        'customer_status',  case when c.user_id is not null then 'ONBOARDED'
                                 else 'NOT_ONBOARDED' end,
        'student_id_number', c.student_id_number,
        'class_year',       c.class_year,

        -- PARTNER: the same identity, one capability further on.
        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),

        -- VENDOR: a business the account may operate. Never a customer grant.
        'vendor_ids',       coalesce(
                              (select jsonb_agg(vu.vendor_id)
                                 from public.vendor_users vu where vu.user_id = u.id),
                              '[]'::jsonb)
      )
      from public.users u
      left join public.customer_profiles c on c.user_id = u.id
      left join public.partner_profiles  p on p.user_id = u.id
      where u.id = auth.uid()
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Ordering requires the Customer capability
-- ---------------------------------------------------------------------------
-- Recreated from 20260907000001 with ONE addition: the is_customer() assertion
-- below. Fee arithmetic, the price snapshot, the half-up rounding, the 5%
-- service fee and the order_secrets insert are byte-for-byte unchanged.
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
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_total    bigint;
  v_service  bigint := 0;
  v_zone     uuid;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
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

  -- THE CUSTOMER CAPABILITY. An authorisation failure, so it raises rather than
  -- returning — this is not a lost race, it is an account that may not order.
  --
  -- Checked against p_customer_id rather than auth.uid() so that a server-side
  -- order placed on somebody's behalf is held to the same rule. An
  -- administrator ordering FOR a customer does not lend them the capability.
  if not public.is_customer(p_customer_id) then
    raise exception 'this account has not completed student onboarding'
      using errcode = 'insufficient_privilege';
  end if;

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
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

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
    p_destination_note,
    v_zone,
    0, 0, v_delivery,
    v_earnings, v_delivery,
    'NONE', now(), now() + make_interval(secs => v_cfg.vendor_response_seconds)
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
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- The service fee is a percentage of the food, so it cannot be known until
  -- the item loop above has a subtotal. Half-up, integer arithmetic only.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_total, 'item_count', jsonb_array_length(p_items))
  );

  return query select v_order_id, v_number, v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. The Partner application adds ONE thing
-- ---------------------------------------------------------------------------
-- Everything the old five-argument form collected — student ID number, class
-- year, email, ID photograph — is already on the account by the time anyone can
-- reach this. The application's own requirement is the live face photograph and
-- nothing else.
--
-- The old signature is DROPPED rather than left beside this one. Two overloads
-- of an entry point that writes identity fields is how one of them quietly
-- keeps being called.
drop function if exists public.partner_apply(text, text, text, text, text);
drop function if exists public.partner_apply(text, text, text);

create or replace function public.partner_apply(p_face_image_path text)
returns public.partner_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
  v_status  public.partner_application_status;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- PARTNER ⇒ CUSTOMER. The foreign key would refuse this anyway; checking it
  -- here is what turns a constraint violation into a sentence a person can act
  -- on. This is an upgrade to an existing account, never a new one.
  if not exists (select 1 from public.customer_profiles where user_id = v_user) then
    raise exception 'complete your student onboarding before applying to be a Partner'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_face_image_path, '')), '') is null then
    raise exception 'a live face photograph is required' using errcode = 'check_violation';
  end if;

  select status into v_status from public.partner_profiles where user_id = v_user;

  -- An approved or suspended Partner does not re-apply; that is an admin
  -- decision, not a form.
  if v_status = 'APPROVED' then
    raise exception 'you are already an approved Partner' using errcode = 'check_violation';
  end if;
  if v_status = 'SUSPENDED' then
    raise exception 'your Partner access is suspended; contact Campus Dash support'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.partner_profiles (
    user_id, status, face_image_path, is_available, applied_at
  )
  values (v_user, 'PENDING_REVIEW', btrim(p_face_image_path), false, now())
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         face_image_path       = excluded.face_image_path,
         is_available          = false,
         applied_at            = now(),
         -- A re-application clears the previous decision so the queue shows a
         -- fresh case rather than a stale rejection.
         reviewed_at           = null,
         reviewed_by           = null,
         review_notes          = null,
         documents_purge_after = null
  returning * into v_profile;

  return v_profile;
end;
$$;

-- What an applicant sees about their own application. Never a document path:
-- the applicant has no reason to hold a storage key, and it is the one field
-- that would let a client try to construct a URL.
--
-- has_documents now means the face photograph, because that is the only
-- document this application supplies. The student ID lives on the Customer
-- profile and is required before applying at all.
create or replace function public.my_partner_application()
returns table (
  status       public.partner_application_status,
  applied_at   timestamptz,
  reviewed_at  timestamptz,
  review_notes text,
  is_available boolean,
  has_documents boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.status, p.applied_at, p.reviewed_at, p.review_notes, p.is_available,
         nullif(btrim(coalesce(p.face_image_path, '')), '') is not null
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 10. The review queue reads the student facts from where they now live
-- ---------------------------------------------------------------------------
-- Return-table columns cannot be changed with CREATE OR REPLACE, so this is a
-- drop and recreate. The reviewer still sees exactly what they saw before: the
-- declared identity beside the two photographs to compare.
drop function if exists public.admin_list_partner_applications(public.partner_application_status);

create or replace function public.admin_list_partner_applications(
  p_status public.partner_application_status default null
)
returns table (
  user_id               uuid,
  full_name             text,
  phone                 text,
  student_id_number     text,
  class_year            text,
  email                 text,
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
  select p.user_id, u.full_name, u.phone,
         c.student_id_number, c.class_year, u.email, p.status,
         c.student_id_image_path, p.face_image_path, p.is_available,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.documents_purge_after
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    join public.customer_profiles c on c.user_id = p.user_id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin()
     and (p_status is null or p.status = p_status)
   order by
     case when p.status = 'PENDING_REVIEW' then 0 else 1 end,
     p.applied_at asc;
$$;

-- ---------------------------------------------------------------------------
-- 11. Document retention follows the photographs
-- ---------------------------------------------------------------------------
-- The face photograph is the Partner's; the student ID photograph is now the
-- Customer's. Both are still due for purge on the Partner retention clock,
-- because the Partner review is the reason we hold either at this quality of
-- privacy risk.
drop function if exists public.admin_partner_documents_due_for_purge();

create or replace function public.admin_partner_documents_due_for_purge()
returns table (
  user_id               uuid,
  student_id_image_path text,
  face_image_path       text,
  status                public.partner_application_status,
  documents_purge_after timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, c.student_id_image_path, p.face_image_path,
         p.status, p.documents_purge_after
    from public.partner_profiles p
    left join public.customer_profiles c on c.user_id = p.user_id
   where public.is_admin()
     and p.documents_purge_after is not null
     and p.documents_purge_after <= now()
     and (c.student_id_image_path is not null or p.face_image_path is not null)
   order by p.documents_purge_after asc;
$$;

-- Clears the Partner's face path once the object is gone. The Customer's ID
-- photograph is NOT cleared here: it is evidence for a capability the person
-- still holds, and customer_profiles.student_id_image_path is NOT NULL.
create or replace function public.admin_clear_partner_documents(p_user_id uuid, p_reason text)
returns public.partner_profiles
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner profile for this user' using errcode = 'no_data_found';
  end if;

  update public.partner_profiles
     set face_image_path = null,
         documents_purge_after = null
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_DOCUMENTS_PURGED', 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Terms are asked of the audience that has the capability
-- ---------------------------------------------------------------------------
-- CUSTOMER terms were required of every authenticated account, which meant a
-- pure vendor account was asked to accept terms about ordering food. Each
-- audience is now keyed to the capability it describes.
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
     where exists (select 1 from public.vendor_users vu where vu.user_id = auth.uid())
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

-- ---------------------------------------------------------------------------
-- 13. Row level security and grants
-- ---------------------------------------------------------------------------
-- Deny by default, exactly like every other table here: RLS on, no write grant
-- for any client role, SELECT only, and every write through a SECURITY DEFINER
-- function above. Adding a table without this is what the schema allowlist test
-- exists to catch.
alter table public.customer_profiles enable row level security;

revoke all on public.customer_profiles from public, anon, authenticated;
grant select on public.customer_profiles to authenticated;

drop policy if exists customer_profiles_read_self on public.customer_profiles;
create policy customer_profiles_read_self on public.customer_profiles
  for select to authenticated using (user_id = auth.uid());

-- An administrator reviews Partner applications, and the student ID on those is
-- now a customer_profiles row.
drop policy if exists customer_profiles_read_admin on public.customer_profiles;
create policy customer_profiles_read_admin on public.customer_profiles
  for select to authenticated using (public.is_admin());

revoke execute on function public.is_customer(uuid) from public;
grant  execute on function public.is_customer(uuid) to anon, authenticated;

revoke execute on function public.complete_customer_onboarding(text, text, text, text, text, uuid)
  from public, anon;
grant  execute on function public.complete_customer_onboarding(text, text, text, text, text, uuid)
  to authenticated;

revoke execute on function public.my_customer_profile() from public, anon;
grant  execute on function public.my_customer_profile() to authenticated;

revoke execute on function public.partner_apply(text) from public, anon;
grant  execute on function public.partner_apply(text) to authenticated;

revoke execute on function public.my_partner_application() from public, anon;
grant  execute on function public.my_partner_application() to authenticated;

grant execute on function public.my_capabilities() to authenticated;
grant execute on function public.my_outstanding_terms() to authenticated;

revoke execute on function public.admin_list_partner_applications(public.partner_application_status)
  from public, anon;
grant  execute on function public.admin_list_partner_applications(public.partner_application_status)
  to authenticated;

revoke execute on function public.admin_partner_documents_due_for_purge() from public, anon;
grant  execute on function public.admin_partner_documents_due_for_purge() to authenticated;
