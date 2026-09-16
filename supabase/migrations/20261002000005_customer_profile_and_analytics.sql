-- ---------------------------------------------------------------------------
-- WHO A CUSTOMER IS, AND WHAT AN ADMINISTRATOR CAN LEARN FROM IT
-- ---------------------------------------------------------------------------
-- `customer_profiles.level` was one of '100', '200', '300', '400'. Two things
-- were wrong with it:
--
--   1. IT EXPIRES. A student who signs up in their first year is level 100 for
--      ever unless somebody remembers to change it, so the column is wrong for
--      three of the four years it describes. An EXPECTED GRADUATION YEAR is the
--      same fact stated in a way that stays true.
--   2. IT ASSUMES EVERYONE IS A STUDENT. Staff eat lunch too, and staff can be
--      Partners; there was no way to be either without claiming a level.
--
-- Gender is added for the same reason the rest of this exists — an operator
-- running a pilot needs to know who is actually using it — and is optional,
-- because a person who would rather not say should not be blocked from buying
-- lunch over it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. STUDENT OR STAFF
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'campus_affiliation') then
    create type public.campus_affiliation as enum ('STUDENT', 'STAFF');
  end if;
  if not exists (select 1 from pg_type where typname = 'customer_gender') then
    -- EXACTLY THESE TWO, as specified. An enum rather than free text because
    -- the whole purpose of the column is being counted, and a column somebody
    -- types into cannot be.
    create type public.customer_gender as enum ('MALE', 'FEMALE');
  end if;
end $$;

alter table public.customer_profiles
  add column if not exists affiliation public.campus_affiliation not null default 'STUDENT',
  add column if not exists graduation_year integer,
  add column if not exists gender public.customer_gender;

comment on column public.customer_profiles.affiliation is
  'Student or staff. Staff hold exactly the same CUSTOMER capability and may become Partners — this changes what is ASKED at sign-up, never what is allowed afterwards.';

comment on column public.customer_profiles.graduation_year is
  'The year a student expects to finish. Replaces `level`, which was wrong for three of the four years it described: somebody who signs up as level 100 stays level 100 for ever unless a person remembers to change it. Null for staff, who do not graduate.';

comment on column public.customer_profiles.gender is
  'Optional, and exactly MALE or FEMALE as specified. Nobody is blocked from ordering for declining to say.';

-- ---------------------------------------------------------------------------
-- 2. TRANSLATING THE OLD COLUMN
-- ---------------------------------------------------------------------------
-- A level and a graduation year are the same fact seen from opposite ends, so
-- existing rows are converted rather than asked again. A four-year programme
-- and an academic year that starts in September: a level-100 student in
-- calendar year Y graduates in Y+4 if they started this September, Y+3 if the
-- year has not turned over yet. The September boundary is what makes that
-- calculable rather than guessed.
--
-- It will be wrong for somebody on a different programme length, which is why
-- it is a MIGRATION and not a formula the product relies on: from here the
-- number is asked for directly and this arithmetic is never run again.

update public.customer_profiles p
   set graduation_year = (
     case
       when extract(month from p.onboarded_at) >= 9
         then extract(year from p.onboarded_at) + (4 - (p.level::integer / 100) + 1)
       else extract(year from p.onboarded_at) + (4 - (p.level::integer / 100))
     end
   )::integer
 where graduation_year is null
   and p.level ~ '^[1-4]00$';

-- Anything unparseable gets a sensible near-future default rather than a null
-- that would fail the constraint below.
update public.customer_profiles
   set graduation_year = extract(year from now())::integer + 2
 where graduation_year is null;

alter table public.customer_profiles drop constraint if exists customer_graduation_year_shape;
alter table public.customer_profiles
  add constraint customer_graduation_year_shape
  check (
    -- Staff do not graduate; a student must name a year that is not absurd.
    (affiliation = 'STAFF' and graduation_year is null)
    or (affiliation = 'STUDENT' and graduation_year between 2000 and 2100)
  );

-- `level` is kept, nullable and unconstrained, purely so a historical row still
-- says what it said. Nothing writes it any more.
alter table public.customer_profiles alter column level drop not null;
alter table public.customer_profiles drop constraint if exists customer_level_shape;

comment on column public.customer_profiles.level is
  'HISTORICAL. The 100/200/300/400 year-group this account signed up with, before the column was replaced by graduation_year. Never written any more; kept so an old row still says what it said.';

-- ---------------------------------------------------------------------------
-- 3. SIGN-UP WRITES THE NEW FIELDS
-- ---------------------------------------------------------------------------

-- THE OLD SIGNATURE, dropped by its exact argument list. Postgres overloads on
-- arguments, so a `create or replace` with a different list makes a SECOND
-- function rather than replacing the first — and then every call is ambiguous.
drop function if exists public.complete_customer_onboarding(text, text, text, text, uuid, text);
drop function if exists public.complete_customer_onboarding(text, text, text, text, uuid);

-- EVERY OTHER RULE IS THE ORIGINAL, WORD FOR WORD. This function is the one
-- gate on the CUSTOMER capability, and its validation, its error messages and
-- its unique-violation handling are all load-bearing — several of them exist
-- because of a specific production failure. What changes is the level check,
-- which becomes an affiliation and a graduation year; everything else is left
-- exactly as it was.
create or replace function public.complete_customer_onboarding(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_affiliation public.campus_affiliation default 'STUDENT',
  p_graduation_year integer default null,
  p_gender public.customer_gender default null,
  p_terms_id uuid default null,
  -- LEGACY, AND KEPT FOR THE SAME REASON IT WAS BEFORE: a caller holding an old
  -- value can still pass it, nothing asks for one, and nothing refuses its
  -- absence. The column and its unique index outlive the question.
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

  -- WHERE THE LEVEL CHECK USED TO BE. A student says when they expect to
  -- finish; staff do not graduate and are not asked. The CHECK constraint on
  -- the table says the same thing independently — this is the sentence a
  -- person reads.
  if p_affiliation = 'STUDENT' then
    if p_graduation_year is null then
      raise exception 'tell us the year you expect to graduate'
        using errcode = 'check_violation';
    end if;
    if p_graduation_year < extract(year from now())::integer
       or p_graduation_year > extract(year from now())::integer + 10 then
      raise exception 'that graduation year does not look right'
        using errcode = 'check_violation';
    end if;
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
    insert into public.customer_profiles (
      user_id, affiliation, graduation_year, gender, student_id_number
    )
    values (
      v_user, p_affiliation,
      case when p_affiliation = 'STUDENT' then p_graduation_year end,
      p_gender, v_student
    )
    -- Re-running sign-up updates the declared facts. It never revokes the
    -- capability, and it never moves onboarded_at: when somebody became a
    -- customer is a historical fact, not a field.
    on conflict (user_id) do update
       set affiliation     = excluded.affiliation,
           graduation_year = excluded.graduation_year,
           -- A VALUE ALREADY GIVEN IS KEPT when a re-run omits it. A later
           -- screen that does not ask a question must not erase its answer,
           -- which is why the legacy student ID behaved this way too.
           gender          = coalesce(excluded.gender, public.customer_profiles.gender),
           student_id_number = coalesce(excluded.student_id_number,
                                        public.customer_profiles.student_id_number)
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

-- Editing the same facts afterwards, from the account screen.
--
-- EVERY EXISTING RULE IS PRESERVED, including the one that matters most: a
-- vendor's phone number IS their sign-in credential and a settings form must
-- not be able to move it, because that is an account takeover with a text
-- input. What is added is the affiliation, the graduation year and the gender.
-- It still returns public.users, because that is what the account screen reads.
drop function if exists public.update_my_profile(text, text, text);

create or replace function public.update_my_profile(
  p_first_name text,
  p_last_name text default null,
  p_phone text default null,
  p_affiliation public.campus_affiliation default null,
  p_graduation_year integer default null,
  p_gender public.customer_gender default null
)
returns public.users
language plpgsql
security definer
set search_path to ''
as $_$
declare
  v_user  public.users%rowtype;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_is_credential boolean;
  v_target public.campus_affiliation;
  v_profile public.customer_profiles%rowtype;
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

  -- THE CUSTOMER FACTS, and only for somebody who has them. An administrator
  -- or a vendor-only account holds no customer_profiles row, and editing their
  -- name must not invent one — that would grant the CUSTOMER capability from a
  -- settings form.
  select * into v_profile from public.customer_profiles where user_id = auth.uid();

  if found and (p_affiliation is not null or p_graduation_year is not null
                or p_gender is not null) then
    v_target := coalesce(p_affiliation, v_profile.affiliation);

    if v_target = 'STUDENT'
       and coalesce(p_graduation_year, v_profile.graduation_year) is null then
      raise exception 'tell us the year you expect to graduate'
        using errcode = 'check_violation';
    end if;

    update public.customer_profiles
       set affiliation = v_target,
           graduation_year = case
             when v_target = 'STAFF' then null
             else coalesce(p_graduation_year, graduation_year) end,
           gender = coalesce(p_gender, gender)
     where user_id = auth.uid();
  end if;

  return v_user;
end;
$_$;

-- ---------------------------------------------------------------------------
-- 4. THE VENDOR DOOR IS FOR VENDORS
-- ---------------------------------------------------------------------------
-- /login/vendor sent an SMS to any number typed into it, which spends credit on
-- strangers, creates an auth identity for somebody who has no store, and tells
-- whoever typed it that they are expected. Sign-in is for accounts that exist.
--
-- REGISTRATION IS A DIFFERENT DOOR and is untouched: /vendor/signup verifies a
-- number in order to CREATE a store, which is exactly when a code should go to
-- a number with nothing behind it.

create or replace function public.phone_can_sign_in_as_vendor(p_phone text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  -- Owns a store, in any state. A rejected or pending applicant still has to
  -- get in to read why, so this is "has a store" rather than "has a live one".
  select exists (
    select 1
      from public.vendors v
      join public.users u on u.id = v.owner_user_id
     where u.phone = p_phone
  );
$$;

comment on function public.phone_can_sign_in_as_vendor(text) is
  'Whether this number belongs to an account that owns a store. Called before a vendor sign-in code is sent, so /login/vendor cannot be used to send an SMS to an arbitrary number or to provision an identity for somebody with no store. Returns a boolean and nothing else — no name, no store, no account id.';

-- ---------------------------------------------------------------------------
-- 5. WHO IS ACTUALLY USING THIS
-- ---------------------------------------------------------------------------
-- The old admin_customers() took a search string and returned a flat list. An
-- operator running a pilot needs to ask questions of the population rather than
-- scroll it, and every dimension below is one the product can act on.
--
-- FILTERING HAPPENS IN THE DATABASE, not in the page. A list of every customer
-- fetched and then filtered in JavaScript is a table that gets slower every
-- week and a payload that carries people the operator did not ask about.

drop function if exists public.admin_customers(text, integer);

create or replace function public.admin_customers(
  p_search text default null,
  p_affiliation public.campus_affiliation default null,
  p_graduation_year integer default null,
  p_gender public.customer_gender default null,
  p_joined_since timestamp with time zone default null,
  p_min_orders integer default null,
  p_active boolean default null,
  p_fulfilment public.fulfilment_type default null,
  p_limit integer default 200
)
returns table(
  user_id uuid,
  full_name text,
  phone text,
  email text,
  affiliation public.campus_affiliation,
  graduation_year integer,
  gender public.customer_gender,
  -- HISTORICAL, and still shown: an operator looking at an account created
  -- before the change should see what it actually holds.
  student_id_number text,
  level text,
  is_suspended boolean,
  is_admin boolean,
  partner_status text,
  onboarded_at timestamp with time zone,
  order_count bigint,
  completed_count bigint,
  spent_pesewas bigint,
  pickup_count bigint,
  partner_count bigint,
  last_order_at timestamp with time zone
)
language sql
stable
security definer
set search_path to ''
as $$
  with mine as (
    select c.user_id,
           count(o.id) filter (where o.order_status <> 'DRAFT') as order_count,
           count(o.id) filter (where o.order_status = 'COMPLETED') as completed_count,
           -- WHAT THEY HAVE ACTUALLY PAID, which is only ever a PAID order.
           coalesce(sum(o.total_pesewas) filter (where o.payment_status = 'PAID'), 0) as spent,
           count(o.id) filter (where o.fulfilment_type = 'PICKUP' and o.payment_status = 'PAID')
             as pickups,
           count(o.id) filter (where o.fulfilment_type = 'DELIVERY' and o.payment_status = 'PAID')
             as partners,
           max(o.created_at) as last_order_at
      from public.customer_profiles c
      left join public.orders o on o.customer_id = c.user_id
     group by c.user_id
  )
  select c.user_id,
         u.full_name,
         u.phone,
         u.email,
         c.affiliation,
         c.graduation_year,
         c.gender,
         c.student_id_number,
         c.level,
         u.is_suspended,
         u.is_admin,
         coalesce(p.status::text, 'NOT_APPLIED'),
         c.onboarded_at,
         m.order_count,
         m.completed_count,
         m.spent,
         m.pickups,
         m.partners,
         m.last_order_at
    from public.customer_profiles c
    join public.users u on u.id = c.user_id
    join mine m on m.user_id = c.user_id
    left join public.partner_profiles p on p.user_id = c.user_id
   where public.is_admin()
     and (p_search is null or btrim(p_search) = ''
          or u.full_name ilike '%' || btrim(p_search) || '%'
          or u.email ilike '%' || btrim(p_search) || '%'
          or u.phone ilike '%' || btrim(p_search) || '%'
          or coalesce(c.student_id_number, '') ilike '%' || btrim(p_search) || '%')
     and (p_affiliation is null or c.affiliation = p_affiliation)
     and (p_graduation_year is null or c.graduation_year = p_graduation_year)
     and (p_gender is null or c.gender = p_gender)
     and (p_joined_since is null or c.onboarded_at >= p_joined_since)
     and (p_min_orders is null or m.order_count >= p_min_orders)
     -- ACTIVE means "has ordered in the last 30 days", which is the only
     -- definition an operator can act on during a pilot.
     and (p_active is null
          or (p_active and m.last_order_at >= now() - interval '30 days')
          or (not p_active and (m.last_order_at is null or m.last_order_at < now() - interval '30 days')))
     and (p_fulfilment is null
          or (p_fulfilment = 'PICKUP' and m.pickups > 0)
          or (p_fulfilment = 'DELIVERY' and m.partners > 0))
   order by m.last_order_at desc nulls last, c.onboarded_at desc
   limit least(coalesce(p_limit, 200), 500);
$$;

/**
 * The same population, counted rather than listed.
 *
 * A COUNT IS NOT A SHORTER LIST. An operator asking "how many staff use this"
 * should not be answered by fetching every staff member and calling .length on
 * a page that also truncates at 200 — which is both slow and quietly wrong.
 */
create or replace function public.admin_customer_summary(
  p_affiliation public.campus_affiliation default null,
  p_graduation_year integer default null,
  p_gender public.customer_gender default null,
  p_joined_since timestamp with time zone default null
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  with scoped as (
    select c.user_id, c.affiliation, c.graduation_year, c.gender,
           (select count(*) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID') as paid_orders,
           (select coalesce(sum(o.total_pesewas), 0) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID') as spent,
           (select max(o.created_at) from public.orders o where o.customer_id = c.user_id) as last_order_at,
           (select count(*) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID'
               and o.fulfilment_type = 'DELIVERY') as partner_orders
      from public.customer_profiles c
     where public.is_admin()
       and (p_affiliation is null or c.affiliation = p_affiliation)
       and (p_graduation_year is null or c.graduation_year = p_graduation_year)
       and (p_gender is null or c.gender = p_gender)
       and (p_joined_since is null or c.onboarded_at >= p_joined_since)
  )
  select jsonb_build_object(
    'customers',        (select count(*) from scoped),
    'students',         (select count(*) from scoped where affiliation = 'STUDENT'),
    'staff',            (select count(*) from scoped where affiliation = 'STAFF'),
    'male',             (select count(*) from scoped where gender = 'MALE'),
    'female',           (select count(*) from scoped where gender = 'FEMALE'),
    'gender_unstated',  (select count(*) from scoped where gender is null),
    'active_30d',       (select count(*) from scoped where last_order_at >= now() - interval '30 days'),
    'never_ordered',    (select count(*) from scoped where paid_orders = 0),
    'paid_orders',      (select coalesce(sum(paid_orders), 0) from scoped),
    'spent_pesewas',    (select coalesce(sum(spent), 0) from scoped),
    'partner_orders',   (select coalesce(sum(partner_orders), 0) from scoped),
    'pickup_orders',    (select coalesce(sum(paid_orders - partner_orders), 0) from scoped),
    -- The shape of the cohort, for the one chart worth drawing.
    'by_graduation_year', coalesce((
      select jsonb_agg(jsonb_build_object('year', year, 'customers', n) order by year)
        from (select graduation_year as year, count(*) as n
                from scoped where graduation_year is not null
               group by graduation_year) g
    ), '[]'::jsonb)
  );
$$;

-- The detail screen reports the new fields too.
drop function if exists public.admin_customer_detail(uuid);

create or replace function public.admin_customer_detail(p_user_id uuid)
returns table(
  user_id uuid,
  full_name text,
  first_name text,
  last_name text,
  phone text,
  email text,
  affiliation public.campus_affiliation,
  graduation_year integer,
  gender public.customer_gender,
  student_id_number text,
  level text,
  is_suspended boolean,
  is_admin boolean,
  onboarded_at timestamp with time zone,
  created_at timestamp with time zone,
  partner_status text,
  partner_applied_at timestamp with time zone,
  vendor_names text[],
  order_count bigint,
  completed_count bigint,
  spent_pesewas bigint,
  pickup_count bigint,
  partner_count bigint,
  recent_orders jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select u.id, u.full_name, u.first_name, u.last_name, u.phone, u.email,
         c.affiliation, c.graduation_year, c.gender, c.student_id_number, c.level,
         u.is_suspended, u.is_admin, c.onboarded_at, u.created_at,
         coalesce(p.status::text, 'NOT_APPLIED'), p.applied_at,
         coalesce(array_agg(distinct v.name) filter (where v.name is not null), '{}'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select coalesce(sum(o.total_pesewas), 0) from public.orders o
           where o.customer_id = u.id and o.payment_status = 'PAID'),
         (select count(*) from public.orders o where o.customer_id = u.id
           and o.payment_status = 'PAID' and o.fulfilment_type = 'PICKUP'),
         (select count(*) from public.orders o where o.customer_id = u.id
           and o.payment_status = 'PAID' and o.fulfilment_type = 'DELIVERY'),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'order_id', o.id,
                    'order_number', o.order_number,
                    'vendor_order_no', o.vendor_order_no,
                    'created_at', o.created_at,
                    'order_status', o.order_status,
                    'payment_status', o.payment_status,
                    'total_pesewas', o.total_pesewas) order by o.created_at desc)
             from (select * from public.orders o2
                    where o2.customer_id = u.id and o2.order_status <> 'DRAFT'
                    order by o2.created_at desc limit 10) o
         ), '[]'::jsonb)
    from public.users u
    join public.customer_profiles c on c.user_id = u.id
    left join public.partner_profiles p on p.user_id = u.id
    left join public.vendors v on v.owner_user_id = u.id
   where u.id = p_user_id and public.is_admin()
   group by u.id, u.full_name, u.first_name, u.last_name, u.phone, u.email,
            c.affiliation, c.graduation_year, c.gender, c.student_id_number, c.level,
            u.is_suspended, u.is_admin, c.onboarded_at, u.created_at, p.status, p.applied_at;
$$;

-- ---------------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------------

revoke all on function public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text)
  from public, anon;
grant execute on function public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text)
  to authenticated;

revoke all on function public.update_my_profile(
  text, text, text, public.campus_affiliation, integer, public.customer_gender)
  from public, anon;
grant execute on function public.update_my_profile(
  text, text, text, public.campus_affiliation, integer, public.customer_gender)
  to authenticated;

-- ANON-CALLABLE ON PURPOSE. It is asked before a sign-in code is sent, which is
-- by definition before anybody is signed in. It returns a bare boolean about a
-- number the caller already typed, which is strictly less than the sign-in
-- screen's own error message tells them either way.
revoke all on function public.phone_can_sign_in_as_vendor(text) from public;
grant execute on function public.phone_can_sign_in_as_vendor(text) to anon, authenticated;

revoke all on function public.admin_customers(
  text, public.campus_affiliation, integer, public.customer_gender,
  timestamp with time zone, integer, boolean, public.fulfilment_type, integer)
  from public, anon;
grant execute on function public.admin_customers(
  text, public.campus_affiliation, integer, public.customer_gender,
  timestamp with time zone, integer, boolean, public.fulfilment_type, integer)
  to authenticated;

revoke all on function public.admin_customer_summary(
  public.campus_affiliation, integer, public.customer_gender, timestamp with time zone)
  from public, anon;
grant execute on function public.admin_customer_summary(
  public.campus_affiliation, integer, public.customer_gender, timestamp with time zone)
  to authenticated;

revoke all on function public.admin_customer_detail(uuid) from public, anon;
grant execute on function public.admin_customer_detail(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. THE ACCOUNT SCREEN CARRIES THE NEW FACTS
-- ---------------------------------------------------------------------------
-- my_capabilities() is what every screen reads on every request. It gains the
-- three new fields and keeps `level` as the historical value it now is, so an
-- account created before the change still reports what it actually holds.

create or replace function public.my_capabilities()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select case
    when auth.uid() is null then jsonb_build_object('authenticated', false)
    else (
      select jsonb_build_object(
        'authenticated',    true,
        'user_id',          u.id,
        'phone',            u.phone,
        'full_name',        u.full_name,
        'first_name',       public.given_name(u.first_name, u.full_name),
        'last_name',        u.last_name,
        'email',            u.email,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,

        'is_customer',      (c.user_id is not null) and not u.is_suspended,
        'can_order',        (c.user_id is not null) and not u.is_suspended,
        'customer_status',  case when c.user_id is not null then 'ONBOARDED'
                                 else 'NOT_ONBOARDED' end,
        'affiliation',      c.affiliation,
        'graduation_year',  c.graduation_year,
        'gender',           c.gender,
        'student_id_number', c.student_id_number,
        -- HISTORICAL. Never written any more; kept so an account created before
        -- graduation_year replaced it still reports what it holds.
        'level',            c.level,

        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),

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

-- AUTHENTICATED ONLY, as it was. A signed-out visitor has no capabilities to
-- report and lib/auth/session.js never asks — widening this to anon would add
-- a reachable function for no caller.
revoke all on function public.my_capabilities() from public, anon;
grant execute on function public.my_capabilities() to authenticated;
