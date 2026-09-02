-- ============================================================================
-- Partner application — class year and contact email
-- ============================================================================
-- The application already proved a phone number, a student ID number and two
-- photographs. Two declared facts were missing that a reviewer actually uses:
--
--   class_year  which cohort the applicant says they are in ("Class of 2029").
--               It is how a reviewer sanity-checks a student ID against a
--               plausible enrolment, and it is what tells us a Partner is about
--               to graduate out of the pilot.
--   email       a second channel. SMS is the only way to reach a Partner today,
--               and the one time we most need to reach them is when SMS is the
--               thing that has failed.
--
-- Both live on public.users, beside student_id_number, because that is where
-- the declared-identity fields already are and where the approved-uniqueness
-- index for the student ID lives.
--
-- DELIBERATELY NOT ENFORCED: an institutional email domain. Applicants are
-- students of one university, but requiring @acity.edu.gh would reject a real
-- applicant whose only working address is personal, and an email address is
-- corroborating detail here, not proof of anything. The reviewer compares a
-- face against an ID; that is the control.
-- ============================================================================

alter table public.users
  add column if not exists class_year text,
  add column if not exists email      text;

-- Shape only, and only when present. A rejected address at this level would be
-- a validation rule pretending to be a constraint.
alter table public.users
  drop constraint if exists users_email_shape;
alter table public.users
  add constraint users_email_shape
  check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

alter table public.users
  drop constraint if exists users_class_year_shape;
alter table public.users
  add constraint users_class_year_shape
  check (class_year is null or btrim(class_year) <> '');

comment on column public.users.class_year is
  'Applicant-declared cohort, e.g. "Class of 2029". Declared, never verified.';
comment on column public.users.email is
  'Applicant-declared contact address. No institutional domain is required.';

-- ---------------------------------------------------------------------------
-- partner_apply — now carries the two new declared fields
-- ---------------------------------------------------------------------------
-- The old three-argument form is DROPPED rather than left beside this one.
-- Two overloads of an entry point that writes identity fields is how one of
-- them quietly keeps being called and the new columns stay null.
drop function if exists public.partner_apply(text, text, text);

create or replace function public.partner_apply(
  p_student_id_number     text,
  p_class_year            text,
  p_email                 text,
  p_student_id_image_path text,
  p_face_image_path       text
)
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

  if nullif(btrim(coalesce(p_student_id_number, '')), '') is null then
    raise exception 'a student ID number is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_class_year, '')), '') is null then
    raise exception 'a class year is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'an email address is required' using errcode = 'check_violation';
  end if;
  if btrim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address does not look like an address'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null
     or nullif(btrim(coalesce(p_face_image_path, '')), '') is null then
    raise exception 'both a student ID photograph and a live face photograph are required'
      using errcode = 'check_violation';
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

  -- The declared fields go on the user, where the approved-uniqueness index
  -- for the student ID lives.
  update public.users
     set student_id_number = btrim(p_student_id_number),
         class_year        = btrim(p_class_year),
         email             = btrim(p_email)
   where id = v_user;

  insert into public.partner_profiles (
    user_id, status, student_id_image_path, face_image_path, is_available, applied_at
  )
  values (
    v_user, 'PENDING_REVIEW', p_student_id_image_path, p_face_image_path, false, now()
  )
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         student_id_image_path = excluded.student_id_image_path,
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

revoke execute on function public.partner_apply(text, text, text, text, text) from public, anon;
grant  execute on function public.partner_apply(text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The review queue shows what the applicant declared
-- ---------------------------------------------------------------------------
-- Return-table columns cannot be added with CREATE OR REPLACE, so this is a
-- drop and recreate. The body is unchanged apart from the two new fields.
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
  select p.user_id, u.full_name, u.phone, u.student_id_number, u.class_year, u.email, p.status,
         p.student_id_image_path, p.face_image_path, p.is_available,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.documents_purge_after
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin()
     and (p_status is null or p.status = p_status)
   order by
     case when p.status = 'PENDING_REVIEW' then 0 else 1 end,
     p.applied_at asc;
$$;

revoke execute on function public.admin_list_partner_applications(public.partner_application_status)
  from public, anon;
grant  execute on function public.admin_list_partner_applications(public.partner_application_status)
  to authenticated;
