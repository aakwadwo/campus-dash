-- ============================================================================
-- Partner application
-- ============================================================================
-- Becoming a Partner is deliberately heavier than becoming a customer. An
-- applicant proves a phone number, photographs their student ID, and takes a
-- LIVE face photograph so an admin can compare the two.
--
-- Ordering food needs none of that. Nothing here touches the customer path.
-- ============================================================================

-- One approved Partner per phone number. Phone uniqueness on public.users
-- already guarantees one ACCOUNT per number; this makes the Partner rule
-- explicit and survives any future relaxation of the account rule.
create unique index if not exists partner_profiles_one_approved_per_user
  on public.partner_profiles (user_id)
  where status = 'APPROVED';

-- Applicants declare a student ID number. Uniqueness across APPROVED partners
-- is enforced on public.users.student_id_number (partner_profiles_student_id_unique).

-- ---------------------------------------------------------------------------
-- Applying
-- ---------------------------------------------------------------------------
-- Both document paths are REQUIRED. An application without them cannot be
-- reviewed, and a half-application sitting in the admin queue wastes the one
-- scarce resource in this flow: a human's attention.
create or replace function public.partner_apply(
  p_student_id_number     text,
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

  -- The declared student ID goes on the user, where the approved-uniqueness
  -- index lives.
  update public.users
     set student_id_number = btrim(p_student_id_number)
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

-- ---------------------------------------------------------------------------
-- What an applicant sees about their own application
-- ---------------------------------------------------------------------------
-- Never the document paths: the applicant has no reason to hold a storage key,
-- and it is the one field that would let a client try to construct a URL.
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
         (p.student_id_image_path is not null and p.face_image_path is not null)
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;

revoke execute on function public.partner_apply(text, text, text) from public, anon;
revoke execute on function public.my_partner_application() from public, anon;
grant execute on function public.partner_apply(text, text, text) to authenticated;
grant execute on function public.my_partner_application() to authenticated;
