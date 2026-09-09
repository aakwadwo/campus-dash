-- ============================================================================
-- Identity foundation — an auth identity that is not a phone number
-- ============================================================================
-- IDENTITY IS NOT CAPABILITY has always been the rule here. What was still
-- wrong was one level down: the schema assumed every IDENTITY was a verified
-- phone number, because that was the only sign-in that existed when it was
-- written. `users.phone` was NOT NULL, so an administrator could not exist
-- without one — and an administrator's phone is a support contact, not a
-- credential. Operational access must not depend on an SMS arriving, least of
-- all when messaging is the thing that has broken.
--
-- Three sign-ins, three proofs, one identity table:
--
--   ADMIN     email + password. No phone, ever.
--   CUSTOMER  a verified @acity.edu.gh address. The phone is a PROFILE field —
--             the number a Partner rings on arrival — not the credential.
--   VENDOR    phone OTP. The number IS the credential (see the next migration).
--
-- What this migration does:
--   1. users.phone becomes nullable, and an email-confirmed auth user gets a
--      profile the same way a phone-confirmed one always has.
--   2. customer_profiles.class_year becomes `level` and is constrained to the
--      four Academic City levels, because a free-text year was never read by
--      anything and could not be filtered on.
--   3. The student ID PHOTOGRAPH stops being a Customer requirement and moves
--      to the Partner application, where the review that needs it actually
--      happens. Signing up to order lunch should not require uploading an ID.
--   4. Customer onboarding requires the school domain, exactly.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A phone number is no longer what makes an identity
-- ---------------------------------------------------------------------------
alter table public.users alter column phone drop not null;

comment on column public.users.phone is
  'Contact number in E.164. For a VENDOR this is also the sign-in credential; '
  'for a CUSTOMER it is the number a Partner rings on arrival; for an ADMIN it '
  'is NULL, because administrators sign in with a password and must not depend '
  'on SMS to reach the console. Unique when present — one number never backs '
  'two identities.';

comment on column public.users.email is
  'For a CUSTOMER this is the verified @acity.edu.gh address that IS the '
  'sign-in credential. For an ADMIN it is the password login. For a VENDOR it '
  'is usually NULL — vendors sign in by phone and are never asked for an email.';

-- An email-only account (an administrator, or a customer signing up with a
-- school address) needs the same profile row a phone account gets. Without
-- this, my_capabilities() reads a confirmed session as signed out.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone text;
begin
  -- Only CONFIRMED contact details get a profile. GoTrue inserts the auth.users
  -- row when a code is first requested, before anything is proven — creating a
  -- profile then would let anyone claim a phone number or address they do not
  -- own simply by asking for a code.
  if new.phone_confirmed_at is null and new.email_confirmed_at is null then
    return new;
  end if;

  -- GoTrue stores phone numbers without the leading '+'. Our E.164 check
  -- requires it.
  v_phone := nullif(new.phone, '');
  if v_phone is not null and left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, email, full_name)
  values (
    new.id,
    case when new.phone_confirmed_at is not null then v_phone end,
    case when new.email_confirmed_at is not null then lower(nullif(new.email, '')) end,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.handle_new_auth_user_for(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  auth.users%rowtype;
  v_phone text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found then
    return;
  end if;
  if v_user.phone_confirmed_at is null and v_user.email_confirmed_at is null then
    return;
  end if;

  v_phone := nullif(v_user.phone, '');
  if v_phone is not null and left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, email, full_name)
  values (
    p_user_id,
    case when v_user.phone_confirmed_at is not null then v_phone end,
    case when v_user.email_confirmed_at is not null then lower(nullif(v_user.email, '')) end,
    nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;
end;
$$;

-- The confirmation trigger now watches BOTH proofs. A customer who verifies an
-- email code and a vendor who verifies an SMS code arrive by different doors
-- into the same room.
create or replace function public.handle_auth_user_phone_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.phone_confirmed_at is not null and old.phone_confirmed_at is null)
     or (new.email_confirmed_at is not null and old.email_confirmed_at is null) then
    perform public.handle_new_auth_user_for(new.id);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Level, not class year
-- ---------------------------------------------------------------------------
-- The old column held free text ("Class of 2028"). Nothing could filter on it,
-- and the sign-up form now offers exactly four choices. Existing rows are
-- mapped where a level can be read out of them and defaulted to 100 otherwise;
-- this is development data, and production is clean for the pilot.
alter table public.customer_profiles rename column class_year to level;
alter table public.customer_profiles drop constraint if exists customer_class_year_shape;

update public.customer_profiles
   set level = case
     when level ~ '^\s*(100|200|300|400)\s*$' then btrim(level)
     else '100'
   end;

alter table public.customer_profiles
  add constraint customer_level_shape check (level in ('100', '200', '300', '400'));

comment on column public.customer_profiles.level is
  'Academic City level: 100, 200, 300 or 400. A fixed set, so it can be '
  'filtered and reported on — the free-text class year it replaced could not.';

-- ---------------------------------------------------------------------------
-- 3. The student ID photograph is a PARTNER document
-- ---------------------------------------------------------------------------
-- It was a Customer requirement because Customer onboarding was, at the time,
-- the only place a document could be collected. But no review consumes it for
-- an ordinary customer: nobody looks at it, and it is never compared against
-- anything. The review that DOES need it is the Partner one, where an admin
-- holds the ID next to a live face. So it moves there, and ordering lunch stops
-- requiring an upload.
alter table public.partner_profiles add column if not exists student_id_image_path text;

comment on column public.partner_profiles.student_id_image_path is
  'PARTNER verification document — the student ID photograph an administrator '
  'compares against face_image_path. Purged with the face photograph after the '
  'review retention window.';

-- Anything already on file moves with the person, so an approved Partner does
-- not have to re-upload an ID that was already reviewed.
update public.partner_profiles p
   set student_id_image_path = c.student_id_image_path
  from public.customer_profiles c
 where c.user_id = p.user_id
   and p.student_id_image_path is null
   and nullif(btrim(coalesce(c.student_id_image_path, '')), '') is not null;

alter table public.customer_profiles drop constraint if exists customer_id_image_shape;
alter table public.customer_profiles drop column if exists student_id_image_path;

-- Both Partner documents are on the same retention clock again, so the purge
-- queue lists both. It lists nothing belonging to a Customer, which was the
-- point of the migration that removed the column from it.
drop function if exists public.admin_partner_documents_due_for_purge();
create function public.admin_partner_documents_due_for_purge()
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
  select p.user_id, p.student_id_image_path, p.face_image_path,
         p.status, p.documents_purge_after
    from public.partner_profiles p
   where public.is_admin()
     and p.documents_purge_after is not null
     and p.documents_purge_after <= now()
     and (p.student_id_image_path is not null or p.face_image_path is not null)
   order by p.documents_purge_after asc;
$$;

grant execute on function public.admin_partner_documents_due_for_purge() to authenticated;

create or replace function public.admin_clear_partner_documents(p_user_id uuid, p_reason text)
returns public.partner_profiles
language plpgsql
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
     set student_id_image_path = null,
         face_image_path       = null,
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
-- 4. Customer onboarding — a school address, a level, a phone
-- ---------------------------------------------------------------------------
-- The email is NOT taken from the caller. It is read from auth.users, where
-- GoTrue put it after the verification code was checked, so "verified" means
-- verified rather than typed. A caller-supplied address would let anyone claim
-- any student's address by asking nicely.
drop function if exists public.complete_customer_onboarding(text, text, text, text, text, uuid);

create function public.complete_customer_onboarding(
  p_full_name         text,
  p_student_id_number text,
  p_level             text,
  p_phone             text,
  p_terms_id          uuid
)
returns public.customer_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := auth.uid();
  v_email   text;
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
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

  if nullif(btrim(coalesce(p_full_name, '')), '') is null then
    raise exception 'your full name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_student_id_number, '')), '') is null then
    raise exception 'a student ID number is required' using errcode = 'check_violation';
  end if;
  if btrim(coalesce(p_level, '')) not in ('100', '200', '300', '400') then
    raise exception 'choose your level: 100, 200, 300 or 400' using errcode = 'check_violation';
  end if;

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

  update public.users
     set full_name = btrim(p_full_name),
         email     = v_email,
         phone     = v_phone
   where id = v_user;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  insert into public.customer_profiles (user_id, student_id_number, level)
  values (v_user, btrim(p_student_id_number), btrim(p_level))
  on conflict (user_id) do update
     set student_id_number = excluded.student_id_number,
         level             = excluded.level
  returning * into v_profile;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (v_user, v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version)
    do update set accepted_at = public.terms_acceptances.accepted_at;

  return v_profile;
end;
$$;

revoke all on function public.complete_customer_onboarding(text, text, text, text, uuid) from public;
grant execute on function public.complete_customer_onboarding(text, text, text, text, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The Partner application carries both documents
-- ---------------------------------------------------------------------------
drop function if exists public.partner_apply(text);

create function public.partner_apply(
  p_student_id_image_path text,
  p_face_image_path       text
)
returns public.partner_profiles
language plpgsql
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
  -- here turns a constraint violation into a sentence a person can act on.
  if not exists (select 1 from public.customer_profiles where user_id = v_user) then
    raise exception 'finish signing up as a customer before applying to be a Partner'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null then
    raise exception 'a photograph of your student ID is required'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_face_image_path, '')), '') is null then
    raise exception 'a live face photograph is required' using errcode = 'check_violation';
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
    user_id, status, student_id_image_path, face_image_path, is_available, applied_at
  )
  values (
    v_user, 'PENDING_REVIEW', btrim(p_student_id_image_path), btrim(p_face_image_path),
    false, now()
  )
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         student_id_image_path = excluded.student_id_image_path,
         face_image_path       = excluded.face_image_path,
         is_available          = false,
         applied_at            = now(),
         reviewed_at           = null,
         reviewed_by           = null,
         review_notes          = null,
         documents_purge_after = null
  returning * into v_profile;

  return v_profile;
end;
$$;

revoke all on function public.partner_apply(text, text) from public;
grant execute on function public.partner_apply(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Read models follow the columns
-- ---------------------------------------------------------------------------
-- Everything below is a mechanical rename (class_year → level) plus the two
-- places that reported "has a student ID photograph" from the Customer row and
-- must now read it from the Partner one. No logic changes.

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

        -- CUSTOMER: a completed sign-up, not merely an account.
        'is_customer',      (c.user_id is not null) and not u.is_suspended,
        'can_order',        (c.user_id is not null) and not u.is_suspended,
        'customer_status',  case when c.user_id is not null then 'ONBOARDED'
                                 else 'NOT_ONBOARDED' end,
        'student_id_number', c.student_id_number,
        'level',            c.level,

        -- PARTNER: the same identity, one capability further on.
        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),

        -- VENDOR: a business this identity owns. Never a customer grant.
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

drop function if exists public.my_customer_profile();
create function public.my_customer_profile()
returns table (student_id_number text, level text, onboarded_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select c.student_id_number, c.level, c.onboarded_at
    from public.customer_profiles c
   where c.user_id = auth.uid();
$$;
grant execute on function public.my_customer_profile() to authenticated;

drop function if exists public.admin_customers(text, integer);
create function public.admin_customers(p_search text default null, p_limit integer default 100)
returns table (
  user_id uuid, full_name text, phone text, email text,
  student_id_number text, level text, is_suspended boolean, is_admin boolean,
  partner_status text, order_count bigint, last_order_at timestamptz,
  onboarded_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.level,
         u.is_suspended, u.is_admin,
         coalesce(p.status::text, 'NOT_APPLIED'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select max(o.created_at) from public.orders o where o.customer_id = u.id),
         c.onboarded_at
    from public.customer_profiles c
    join public.users u on u.id = c.user_id
    left join public.partner_profiles p on p.user_id = u.id
   where public.is_admin()
     and (p_search is null or btrim(p_search) = ''
          or u.full_name ilike '%' || btrim(p_search) || '%'
          or coalesce(u.phone,'') ilike '%' || btrim(p_search) || '%'
          or coalesce(u.email,'') ilike '%' || btrim(p_search) || '%'
          or c.student_id_number ilike '%' || btrim(p_search) || '%')
   order by c.onboarded_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;
grant execute on function public.admin_customers(text, integer) to authenticated;

drop function if exists public.admin_customer_detail(uuid);
create function public.admin_customer_detail(p_user_id uuid)
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
                     from public.vendor_users vu
                     join public.vendors v on v.id = vu.vendor_id
                    where vu.user_id = u.id), '{}'),
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
grant execute on function public.admin_customer_detail(uuid) to authenticated;

drop function if exists public.admin_list_partner_applications(public.partner_application_status);
create function public.admin_list_partner_applications(
  p_status public.partner_application_status default null
)
returns table (
  user_id uuid, full_name text, phone text, student_id_number text, level text,
  email text, status public.partner_application_status,
  student_id_image_path text, face_image_path text, is_available boolean,
  applied_at timestamptz, reviewed_at timestamptz, reviewed_by_name text,
  review_notes text, documents_purge_after timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.user_id, u.full_name, u.phone,
         c.student_id_number, c.level, u.email, p.status,
         p.student_id_image_path, p.face_image_path, p.is_available,
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
grant execute on function public.admin_list_partner_applications(public.partner_application_status)
  to authenticated;

drop function if exists public.admin_partners(text);
create function public.admin_partners(p_status text default null)
returns table (
  user_id uuid, full_name text, phone text, level text,
  status public.partner_application_status, is_available boolean,
  is_suspended boolean, applied_at timestamptz, reviewed_at timestamptz,
  deliveries bigint, owed_pesewas bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, c.level, p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at,
         (select count(*) from public.orders o where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE'))
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.customer_profiles c on c.user_id = u.id
   where public.is_admin()
     and (p_status is null or p.status::text = p_status)
   order by
     case p.status when 'PENDING_REVIEW' then 0 when 'APPROVED' then 1 else 2 end,
     p.applied_at desc nulls last;
$$;
grant execute on function public.admin_partners(text) to authenticated;

drop function if exists public.admin_partner_detail(uuid);
create function public.admin_partner_detail(p_user_id uuid)
returns table (
  user_id uuid, full_name text, phone text, email text,
  student_id_number text, level text,
  status public.partner_application_status, is_available boolean,
  is_suspended boolean, applied_at timestamptz, reviewed_at timestamptz,
  reviewed_by_name text, review_notes text,
  has_face_image boolean, has_student_id boolean,
  deliveries_completed bigint, deliveries_failed bigint,
  earned_pesewas bigint, owed_pesewas bigint, paid_pesewas bigint,
  active_order_id uuid, active_order_number text, recent_deliveries jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.level,
         p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.face_image_path is not null,
         p.student_id_image_path is not null,
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('FAILED_CUSTOMER_ABSENT','FAILED_NO_PARTNER')),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status <> 'CANCELLED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE')),
         (select coalesce(sum(po.amount_pesewas),0)::bigint from public.payouts po
           where po.payee_type = 'PARTNER' and po.payee_id = u.id and po.status = 'PAID'),
         (select o.id from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP')
           order by o.assigned_at limit 1),
         (select o.order_number from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP')
           order by o.assigned_at limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'delivery_status', o.delivery_status,
                     'earnings_pesewas', o.partner_earnings_pesewas,
                     'delivered_at', o.delivered_at, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2 where o2.partner_id = u.id
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.partner_profiles p on p.user_id = u.id
    left join public.customer_profiles c on c.user_id = u.id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin() and u.id = p_user_id;
$$;
grant execute on function public.admin_partner_detail(uuid) to authenticated;

-- The applicant's own view. `has_documents` now means BOTH documents, because
-- an application with only one of them is not a reviewable application.
create or replace function public.my_partner_application()
returns table (
  status public.partner_application_status, applied_at timestamptz,
  reviewed_at timestamptz, review_notes text, is_available boolean,
  has_documents boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.status, p.applied_at, p.reviewed_at, p.review_notes, p.is_available,
         nullif(btrim(coalesce(p.face_image_path, '')), '') is not null
           and nullif(btrim(coalesce(p.student_id_image_path, '')), '') is not null
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;
