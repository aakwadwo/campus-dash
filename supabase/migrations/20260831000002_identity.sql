-- ============================================================================
-- Identity: users, partner profiles, vendors, vendor staff
-- ============================================================================
-- ONE account per person. Partner capability is a role on that same account —
-- never a second login. A user can be Customer and Partner simultaneously and
-- switch modes in the UI.
-- ============================================================================

create table public.users (
  id                  uuid primary key references auth.users (id) on delete cascade,
  phone               text not null,
  full_name           text,
  is_admin            boolean not null default false,
  is_suspended        boolean not null default false,
  -- Student status stays deliberately lightweight and nullable: the
  -- verification method is still being evaluated, and customers must never be
  -- blocked on it. See docs/OPEN-QUESTIONS.md.
  student_id_number   text,
  student_verified_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint users_phone_e164 check (phone ~ '^\+[1-9]\d{7,14}$')
);

-- One account per phone number, enforced by the database.
create unique index users_phone_key on public.users (phone);
create index users_is_admin_idx on public.users (id) where is_admin;

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Partner profiles
-- ---------------------------------------------------------------------------
-- A row exists only once a user applies. Approval is manual in V1: an admin
-- compares the live face photograph against the student ID.
create table public.partner_profiles (
  user_id             uuid primary key references public.users (id) on delete cascade,
  status              public.partner_application_status not null default 'PENDING_REVIEW',

  -- Private Storage object paths. NEVER public URLs — an admin views these
  -- through short-lived signed URLs generated server-side.
  student_id_image_path text,
  face_image_path       text,

  -- Partner-controlled: are they currently willing to receive delivery offers?
  is_available        boolean not null default false,

  applied_at          timestamptz not null default now(),
  reviewed_at         timestamptz,
  reviewed_by         uuid references public.users (id),
  review_notes        text,

  -- Retention: verification documents are deleted after the approval period.
  documents_purge_after timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- An approved or rejected profile must record who decided and when.
  constraint partner_reviewed_consistently check (
    (status in ('APPROVED', 'REJECTED', 'SUSPENDED'))
      = (reviewed_at is not null and reviewed_by is not null)
  )
);

create index partner_profiles_status_idx on public.partner_profiles (status);

-- Partner dispatch reads this constantly: who is approved AND available?
create index partner_profiles_dispatchable_idx
  on public.partner_profiles (user_id)
  where status = 'APPROVED' and is_available;

-- A student ID may back at most one APPROVED Partner account. Prevents one
-- person holding several approved Partner identities.
create unique index partner_profiles_student_id_unique
  on public.users (student_id_number)
  where student_id_number is not null;

create trigger partner_profiles_set_updated_at
  before update on public.partner_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Vendors
-- ---------------------------------------------------------------------------
-- Registration is CLOSED in V1. Admins hand-recruit, create and approve.
create table public.vendors (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  phone               text not null,
  status              public.vendor_status not null default 'DRAFT',

  -- Vendor-controlled kill switch. When false, no NEW orders may be submitted;
  -- orders already in flight are unaffected.
  is_accepting_orders boolean not null default false,

  location_id         uuid,
  location_note       text,

  -- Admin-supplied walking minutes from this vendor to the campus hub. Feeds
  -- the Partner's pre-acceptance effort estimate. NULL means "unknown" and the
  -- estimate is simply omitted rather than guessed.
  walk_minutes_to_campus integer check (walk_minutes_to_campus >= 0),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint vendors_phone_e164 check (phone ~ '^\+[1-9]\d{7,14}$')
);

create unique index vendors_phone_key on public.vendors (phone);
create index vendors_open_idx on public.vendors (id)
  where status = 'ACTIVE' and is_accepting_orders;

create trigger vendors_set_updated_at
  before update on public.vendors
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Vendor staff
-- ---------------------------------------------------------------------------
-- Real stalls have more than one person on the counter. A join table keeps
-- vendor RLS honest without forcing a shared login.
create table public.vendor_users (
  vendor_id  uuid not null references public.vendors (id) on delete cascade,
  user_id    uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (vendor_id, user_id)
);

create index vendor_users_user_idx on public.vendor_users (user_id);
