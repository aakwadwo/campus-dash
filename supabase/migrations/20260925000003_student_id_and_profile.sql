-- ============================================================================
-- THE STUDENT ID NUMBER STOPS BEING ASKED FOR — AND THE PROFILE GAINS A PHONE
-- ============================================================================
-- WHY THE NUMBER GOES. It was collected twice over and proved nothing either
-- time. A customer's identity is established by a verified @acity.edu.gh
-- address, which is the school's own record; a Partner's is established by that
-- same address plus a photograph of the card, which a person reads. The typed
-- number was a third copy nobody checked against anything, and one more piece
-- of a student's data to hold.
--
-- WHY THE COLUMN STAYS. Every account created before today has one, an
-- administrator can still see it on a customer or Partner record, and a past
-- approval decision should remain auditable against what it was made on.
-- Dropping the column would erase that. So it becomes optional: nothing new
-- writes it, nothing requires it, and the uniqueness that guarded it is now
-- partial so the absence of a number is not a collision.
--
-- THE PHONE. Settings can change it. It is a profile fact for a customer — the
-- number a Partner rings on arrival — so the account holder owns it. It is NOT
-- editable here for anybody who signs in with it: a vendor's number is their
-- credential, and letting a form move a credential is how an account is lost.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE NUMBER BECOMES OPTIONAL
-- ---------------------------------------------------------------------------

alter table public.customer_profiles
  alter column student_id_number drop not null;

alter table public.customer_profiles
  drop constraint if exists customer_student_id_shape;

-- Blank is not a value. A row either carries a real number or carries none.
alter table public.customer_profiles
  add constraint customer_student_id_shape
  check (student_id_number is null or btrim(student_id_number) <> '');

-- Same name, so the schema invariant test still finds it; partial, so the
-- accounts that have no number do not all collide with one another.
drop index if exists public.customer_profiles_student_id_unique;
create unique index customer_profiles_student_id_unique
  on public.customer_profiles (student_id_number)
  where student_id_number is not null;

comment on column public.customer_profiles.student_id_number IS
  'HISTORICAL. Campus Dash no longer asks for this: the verified @acity.edu.gh address establishes who a student is, and the Partner application is judged on the card itself. Retained so an account created before the change keeps what it declared and a past review stays auditable. Unique when present.';

create or replace function public.complete_customer_onboarding(
  p_first_name text,
  p_last_name text,
  p_level text,
  p_phone text,
  p_terms_id uuid,
  p_student_id_number text default null
)
returns public.customer_profiles
language plpgsql
security definer
set search_path to ''
as $_$
declare
  v_user    uuid := auth.uid();
  v_email   text;
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_student text := nullif(btrim(coalesce(p_student_id_number, '')), '');
  v_profile public.customer_profiles%rowtype;
  v_doc     public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- THE VERIFIED ADDRESS, read from auth. Not a parameter.
  select lower(btrim(coalesce(u.email, ''))) into v_email
    from auth.users u
   where u.id = v_user and u.email_confirmed_at is not null;

  if coalesce(v_email, '') = '' then
    raise exception 'verify your Academic City email address before completing sign-up'
      using errcode = 'insufficient_privilege';
  end if;

  -- EXACTLY the school domain. A lookalike (@acity.edu.gh.example.com) must not
  -- pass, so this anchors the end of the string rather than searching for it.
  if v_email !~ '@acity\.edu\.gh$' then
    raise exception 'Campus Dash accounts use an @acity.edu.gh address'
      using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_last_name, '')), '') is null then
    raise exception 'your last name is required' using errcode = 'check_violation';
  end if;
  if btrim(coalesce(p_level, '')) not in ('100', '200', '300', '400') then
    raise exception 'choose your level: 100, 200, 300 or 400' using errcode = 'check_violation';
  end if;

  -- NO STUDENT ID CHECK. The parameter survives so a caller holding a legacy
  -- value can still pass it; nothing asks for one and nothing refuses its
  -- absence.

  -- The phone is how a Partner reaches somebody standing outside their door
  -- with cooling food. It is required for that reason, not as a credential.
  if v_phone is null then
    raise exception 'a phone number is required so a Partner can reach you'
      using errcode = 'check_violation';
  end if;
  if v_phone !~ '^\+[1-9]\d{7,14}$' then
    raise exception 'enter a valid phone number, e.g. 020 123 4567'
      using errcode = 'check_violation';
  end if;

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

  begin
    update public.users
       set first_name = btrim(p_first_name),
           last_name  = btrim(p_last_name),
           email      = v_email,
           phone      = v_phone
     where id = v_user;

    if not found then
      raise exception 'no profile for this account' using errcode = 'no_data_found';
    end if;
  exception when unique_violation then
    -- Two different constraints, two different mistakes, two different fixes.
    if sqlerrm like '%users_phone%' then
      raise exception 'that phone number is already used by another Campus Dash account'
        using errcode = 'unique_violation';
    end if;
    raise exception 'that email address is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end;

  begin
    insert into public.customer_profiles (user_id, student_id_number, level)
    values (v_user, v_student, btrim(p_level))
    -- Re-running sign-up updates the declared facts. It never revokes the
    -- capability, and it never moves onboarded_at: when somebody became a
    -- customer is a historical fact, not a field. A legacy number is KEPT
    -- rather than blanked by a re-run that no longer collects one.
    on conflict (user_id) do update
       set student_id_number = coalesce(excluded.student_id_number,
                                        public.customer_profiles.student_id_number),
           level             = excluded.level
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
$_$;

-- The old six-parameter form would otherwise remain as a callable overload
-- that still refuses an account with no student ID number.
drop function if exists public.complete_customer_onboarding(text, text, text, text, text, uuid);

-- ---------------------------------------------------------------------------
-- 2. THE PARTNER APPLICATION ACCEPTS THE PARTNER TERMS
-- ---------------------------------------------------------------------------
-- The form has always SAID that applying means agreeing to them. Now it records
-- it, in the same transaction as the application, against the published
-- version — so "they agreed" is a row somebody can point at rather than a
-- sentence under a button.

create or replace function public.partner_apply(
  p_student_id_image_path text,
  p_terms_id uuid default null
)
returns public.partner_profiles
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
  v_status  public.partner_application_status;
  v_doc     public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- PARTNER ⇒ CUSTOMER. The foreign key would refuse this anyway; checking it
  -- here turns a constraint violation into a sentence a person can act on. It
  -- is also the reason no email verification happens here: holding the CUSTOMER
  -- capability already means a verified @acity.edu.gh address.
  if not exists (select 1 from public.customer_profiles where user_id = v_user) then
    raise exception 'finish signing up as a customer before applying to be a Partner'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null then
    raise exception 'a photograph of your student ID is required'
      using errcode = 'check_violation';
  end if;

  -- The terms. Optional in the signature so a caller that predates this can
  -- still work, and refused below when a document IS named but is the wrong
  -- one — a silently ignored terms id would be worse than no terms id.
  if p_terms_id is not null then
    select * into v_doc from public.terms_documents where id = p_terms_id;
    if not found or v_doc.published_at is null or v_doc.audience <> 'PARTNER' then
      raise exception 'the Partner terms must be accepted to continue'
        using errcode = 'check_violation';
    end if;
    if v_doc.version <> (
      select max(t.version) from public.terms_documents t
       where t.audience = 'PARTNER' and t.published_at is not null
    ) then
      raise exception 'those terms have been superseded; reload and try again'
        using errcode = 'check_violation';
    end if;
  end if;

  select status into v_status from public.partner_profiles where user_id = v_user;

  if v_status = 'APPROVED' then
    raise exception 'you are already an approved Partner' using errcode = 'check_violation';
  end if;
  if v_status = 'SUSPENDED' then
    raise exception 'your Partner access is suspended; contact Campus Dash support'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.partner_profiles (
    user_id, status, student_id_image_path, is_available, applied_at
  )
  values (v_user, 'PENDING_REVIEW', btrim(p_student_id_image_path), false, now())
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         student_id_image_path = excluded.student_id_image_path,
         -- A re-application clears any photograph a previous one left behind.
         -- Campus Dash no longer asks for one, so it should not keep one.
         face_image_path       = null,
         is_available          = false,
         applied_at            = now(),
         reviewed_at           = null,
         reviewed_by           = null,
         review_notes          = null,
         documents_purge_after = null
  returning * into v_profile;

  if v_doc.id is not null then
    insert into public.terms_acceptances (user_id, terms_id, audience, version)
    values (v_user, v_doc.id, v_doc.audience, v_doc.version)
    on conflict (user_id, audience, version)
      do update set accepted_at = public.terms_acceptances.accepted_at;
  end if;

  return v_profile;
end;
$$;

drop function if exists public.partner_apply(text);

-- ---------------------------------------------------------------------------
-- 3. SETTINGS CAN CHANGE THE PHONE NUMBER
-- ---------------------------------------------------------------------------

create or replace function public.update_my_profile(
  p_first_name text,
  p_last_name text default null,
  p_phone text default null
)
returns public.users
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user  public.users%rowtype;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_is_credential boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;

  -- WHOSE NUMBER IS A CREDENTIAL. A vendor signs in with theirs, so a settings
  -- form must not be able to move it — that would be an account takeover with
  -- a text input. A customer's number is a profile fact and is theirs to
  -- change. An administrator has no number at all and is not given one here.
  select exists (
    select 1 from public.vendors v where v.owner_user_id = auth.uid()
  ) or exists (
    select 1 from public.users u where u.id = auth.uid() and u.is_admin
  ) into v_is_credential;

  if v_phone is not null then
    if v_is_credential then
      raise exception 'your phone number is how you sign in; contact Campus Dash to change it'
        using errcode = 'insufficient_privilege';
    end if;
    if v_phone !~ '^\+[1-9]\d{7,14}$' then
      raise exception 'enter a valid phone number, e.g. 020 123 4567'
        using errcode = 'check_violation';
    end if;
  end if;

  begin
    update public.users
       set first_name = btrim(p_first_name),
           last_name  = nullif(btrim(coalesce(p_last_name, '')), ''),
           -- NULL means "leave it": clearing a number a Partner rings on
           -- arrival is not something a name form should be able to do.
           phone      = coalesce(v_phone, phone)
     where id = auth.uid()
    returning * into v_user;
  exception when unique_violation then
    raise exception 'that phone number is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  return v_user;
end;
$$;

drop function if exists public.update_my_profile(text, text);
drop function if exists public.update_my_profile(text);

-- ---------------------------------------------------------------------------
-- 4. GRANTS
-- ---------------------------------------------------------------------------

revoke execute on function public.complete_customer_onboarding(text, text, text, text, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.partner_apply(text, uuid) from public, anon, authenticated;
revoke execute on function public.update_my_profile(text, text, text) from public, anon, authenticated;

grant execute on function public.complete_customer_onboarding(text, text, text, text, uuid, text)
  to authenticated;
grant execute on function public.partner_apply(text, uuid)           to authenticated;
grant execute on function public.update_my_profile(text, text, text) to authenticated;
