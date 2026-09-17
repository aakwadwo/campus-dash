-- ============================================================================
-- Four graduation years, two genders, and an administrator who can add or
-- remove an account from the console.
-- ============================================================================
--
-- THREE THINGS, AND THEY ARE RELATED ONLY BY THE SCREEN THEY SERVE.
--
--   1. Sign-up asks for one of FOUR graduation years and one of TWO genders.
--      Both were already narrowed in the form; this is the half that decides.
--   2. An administrator can create a vendor that has an ACCOUNT, not only a
--      catalogue entry — reusing the existing approval model rather than
--      inventing a second way for a store to go live.
--   3. An administrator can delete a vendor or a customer, with every related
--      row handled in dependency order and a refusal wherever deleting would
--      destroy money or history.
--
-- WHAT IS NOT WEAKENED. No client role gains a table write. Every function
-- below re-checks is_admin() in its own body, writes its admin_actions row in
-- the same transaction, and pins an empty search_path.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. SIGN-UP: FOUR YEARS, TWO GENDERS
-- ---------------------------------------------------------------------------
-- The graduation year used to be "this year through this year plus six",
-- computed so it never needed editing in September. That was right when the
-- question was "roughly when do you finish"; it is wrong now that the pilot
-- wants to know which of four cohorts somebody is in, because five of the seven
-- offered years belong to nobody on campus.
--
-- FOUR LITERAL YEARS, AND THEY ARE WRITTEN HERE ON PURPOSE. They are not in
-- pricing_config: that table holds numbers an operator retunes mid-pilot
-- without a deploy, and the list of cohorts the intake is defined by is not one
-- of those. When the intake moves, this function and lib/auth/customer-signup.js
-- move together, and the test that pins them to each other says so.
--
-- THE TABLE CHECK IS DELIBERATELY NOT NARROWED. customer_graduation_year_shape
-- still allows 2000-2100, because an account created before today holds a year
-- outside this list and a constraint that refused it would make that row
-- unwritable — including by a trigger that only wanted to touch a name.
--
-- GENDER IS NOW REQUIRED. It was optional, with a "prefer not to say" option
-- that stored a null; the only reason to hold the column is to count it, and a
-- column a third of the rows decline is a column that cannot be counted. The
-- enum was already exactly MALE and FEMALE, so nothing about what may be stored
-- changes — only whether the question may be skipped.
--
-- EXISTING ROWS KEEP THEIR NULL. Nothing backfills a gender nobody stated, and
-- the column stays nullable so a row written before today is still a valid row.

drop function if exists public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text);

create or replace function public.complete_customer_onboarding(
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_affiliation public.campus_affiliation default 'STUDENT',
  p_graduation_year integer default null,
  p_gender public.customer_gender default null,
  p_terms_id uuid default null,
  -- LEGACY, kept for the reason it has always been kept: a caller holding an
  -- old value can still pass it, nothing asks for one, and nothing refuses its
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

  -- A student says which of the four cohorts they are in; staff do not
  -- graduate and are not asked. The offered list and this check are the same
  -- list, so a year the form cannot offer is a year this refuses.
  if p_affiliation = 'STUDENT' then
    if p_graduation_year is null then
      raise exception 'tell us the year you expect to graduate'
        using errcode = 'check_violation';
    end if;
    if p_graduation_year not in (2027, 2028, 2029, 2030) then
      raise exception 'choose one of the graduation years offered'
        using errcode = 'check_violation';
    end if;
  end if;

  -- MALE OR FEMALE, and one of them is answered. See the note at the top.
  if p_gender is null then
    raise exception 'tell us whether you are male or female'
      using errcode = 'check_violation';
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
    -- TWO DIFFERENT CONSTRAINTS, TWO DIFFERENT MISTAKES, and the distinction is
    -- kept HERE, in the log, where it is the thing that makes a support call
    -- answerable. What the person is shown is decided in lib/errors.js, and it
    -- deliberately no longer says which detail collided or that another account
    -- holds it — that would answer "is this number registered?" for anybody who
    -- typed one. The uniqueness rule itself is untouched.
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

-- DROPPING A FUNCTION DROPS ITS GRANTS, and Postgres hands EXECUTE to PUBLIC
-- when the replacement is created — which is how an anon role ends up able to
-- call the one gate on the CUSTOMER capability. The drop above is unavoidable
-- (the argument list is unchanged here, but the habit is what matters), so the
-- grants are re-stated immediately after it. tests/schema.test.js asserts the
-- whole client-callable surface and catches this within a run.
revoke all on function public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text)
  from public, anon;
grant execute on function public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text)
  to authenticated, service_role;

comment on function public.complete_customer_onboarding(
  text, text, text, public.campus_affiliation, integer, public.customer_gender, uuid, text) is
  'The one gate on the CUSTOMER capability. Reads the verified address from auth.users, anchors the school domain, accepts one of the four offered graduation years for a student, requires male or female, and records the terms acceptance in the same transaction.';

-- The same two rules where the same facts are edited afterwards. Everything
-- else in this function is unchanged, including the one that matters most: a
-- vendor's phone number IS their sign-in credential and a settings form must
-- not be able to move it.
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

  -- A YEAR THAT IS BEING CHANGED IS CHECKED AGAINST THE OFFERED LIST. Null
  -- still means "leave it", so an account carrying an older year keeps it until
  -- somebody actually answers the question again.
  if p_graduation_year is not null and p_graduation_year not in (2027, 2028, 2029, 2030) then
    raise exception 'choose one of the graduation years offered'
      using errcode = 'check_violation';
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
-- 2. A VENDOR THAT HAS AN ACCOUNT, CREATED BY AN ADMINISTRATOR
-- ---------------------------------------------------------------------------
-- admin_create_vendor() creates a CATALOGUE ENTRY: a restaurant listed so a
-- prepaid meal can be fetched from it, with no owner and nobody able to sign
-- in. That stays exactly as it is. This is the other case, and the pilot hits
-- it constantly: a store recruited in person, whose owner will sign in with the
-- number in the recruiter's hand.
--
-- IT REUSES THE APPROVAL MODEL RATHER THAN SKIPPING IT. The store is created
-- PENDING_APPROVAL with submitted_at set, exactly as if the owner had filled in
-- /vendor/signup — so it lands in the same review queue, is approved by the
-- same admin_review_vendor(), and the owner gets the same SMS. An administrator
-- creating a store does not also get to be the record of its approval.
--
-- IT DOES NOT CREATE THE IDENTITY. auth.users belongs to GoTrue; the caller
-- provisions the account through the admin API and hands the id here. That
-- keeps the one rule this schema has about identity: auth.users.id is the
-- identity, and everything else is a row built on top of it.
create or replace function public.admin_create_vendor_account(
  p_owner_user_id          uuid,
  p_store_name             text,
  p_reason                 text,
  p_applicant_name         text    default null,
  p_category_id            uuid    default null,
  p_description            text    default null,
  p_owner_is_student       boolean default null,
  p_location_id            uuid    default null,
  p_location_note          text    default null,
  p_walk_minutes_to_campus integer default null
)
returns public.vendors
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_owner  public.users%rowtype;
  v_vendor public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_store_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_owner from public.users where id = p_owner_user_id;
  if not found then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;
  if coalesce(v_owner.phone, '') = '' then
    raise exception 'the owner account has no phone number to sign in with'
      using errcode = 'check_violation';
  end if;

  -- ONE ACCOUNT, ONE STORE. vendors_owner_unique says the same thing; this is
  -- the sentence an operator reads instead of a constraint name.
  if exists (select 1 from public.vendors v where v.owner_user_id = p_owner_user_id) then
    raise exception 'that account already owns a store' using errcode = 'unique_violation';
  end if;

  -- An administrator is not a shopkeeper. Operational access must not depend on
  -- an SMS, and an admin row is the one the audit trail keys off.
  if v_owner.is_admin then
    raise exception 'an administrator account cannot own a store'
      using errcode = 'check_violation';
  end if;

  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    owner_user_id, category_id, description, applicant_name, owner_is_student,
    location_id, location_note, walk_minutes_to_campus, submitted_at
  )
  values (
    btrim(p_store_name), v_owner.phone, 'PENDING_APPROVAL', false,
    p_owner_user_id,
    coalesce(p_category_id, '40000000-0000-4000-8000-000000000001'),
    nullif(btrim(coalesce(p_description, '')), ''),
    coalesce(nullif(btrim(coalesce(p_applicant_name, '')), ''), v_owner.full_name),
    p_owner_is_student,
    p_location_id, nullif(btrim(coalesce(p_location_note, '')), ''),
    p_walk_minutes_to_campus, now()
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_ACCOUNT_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor),
    jsonb_build_object('owner_user_id', p_owner_user_id)
  );

  return v_vendor;
end;
$$;

comment on function public.admin_create_vendor_account(
  uuid, text, text, text, uuid, text, boolean, uuid, text, integer) is
  'Creates a store that has an OWNER, for a vendor recruited in person. The identity is provisioned by the caller through the auth admin API and passed in; this attaches it to a new PENDING_APPROVAL store so the existing review queue, approval and welcome SMS all apply unchanged. Administrator only, re-checked in the body, audited.';


-- ---------------------------------------------------------------------------
-- 3. DELETING A STORE
-- ---------------------------------------------------------------------------
-- WHAT THIS WILL NOT DO, AND WHY IT REFUSES RATHER THAN CASCADES.
--
-- An order is the record of money that moved. A store with orders against it
-- cannot be deleted here at any price: the allocations, the payments and the
-- payouts that reference those orders are what reconciles Campus Dash's bank
-- account, and a console button that quietly removed them would be a hole in
-- the books with an audit row saying who made it. Suspension is the answer for
-- a store that has traded — it removes them from the marketplace and keeps the
-- history — and a genuine pilot reset goes through scripts/purge-test-accounts,
-- which runs as the database owner and is not reachable from a browser.
--
-- WHAT IT DOES DELETE. A store with no orders owns nothing but its own
-- description: its menu, its photographs, its daily queue counter and its
-- payout destination. Those go in dependency order, and the storage objects
-- behind the photographs are RETURNED rather than deleted, because
-- storage.objects refuses a SQL delete by design and removing the row would
-- orphan the file. The caller removes them through the Storage API afterwards.
--
-- THE OWNER'S IDENTITY GOES ONLY IF IT IS NOW NOTHING. An account that is also
-- a customer, or has ordered, or carries anything else, keeps existing — the
-- store was one capability and this removes one capability. An account whose
-- only reason to exist was the store is deleted with it, because leaving a
-- signed-in identity that owns nothing is exactly the orphan this is trying to
-- avoid.
create or replace function public.admin_delete_vendor(
  p_vendor_id uuid,
  p_reason    text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_vendor  public.vendors%rowtype;
  v_owner   public.users%rowtype;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_orders  integer;
  v_paths   jsonb;
  v_counts  jsonb := '{}'::jsonb;
  v_n       integer;
  v_owner_deleted boolean := false;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_vendor from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  select count(*) into v_orders from public.orders where vendor_id = p_vendor_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order(s) belong to this store, and deleting them would delete the money records that reconcile them. Suspend the store instead.',
      v_orders using errcode = 'foreign_key_violation';
  end if;

  -- Belt as well as braces: a settlement row for a store with no orders should
  -- not exist, and if one does it is the thing to look at before deleting.
  if exists (select 1 from public.allocations a where a.payee_id = p_vendor_id)
     or exists (select 1 from public.payouts p where p.payee_id = p_vendor_id) then
    raise exception
      'cannot delete: this store has settlement records. Suspend it instead.'
      using errcode = 'foreign_key_violation';
  end if;

  -- The object paths, read before the rows that name them are gone.
  select coalesce(jsonb_agg(i.storage_path) filter (where i.storage_path is not null), '[]'::jsonb)
    into v_paths
    from public.vendor_images i
   where i.vendor_id = p_vendor_id;

  select count(*) into v_n from public.menu_items where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('menu_items', v_n);
  select count(*) into v_n from public.vendor_images where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendor_images', v_n);
  select count(*) into v_n from public.vendor_order_counters where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendor_order_counters', v_n);

  -- Where the money would have gone. No payout exists, so nothing is orphaned.
  delete from public.payout_destinations d where d.payee_id = p_vendor_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payout_destinations', v_n);

  -- Menu items, photographs and the daily queue counter cascade from here.
  delete from public.vendors v where v.id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendors', 1);

  if v_vendor.owner_user_id is not null then
    select * into v_owner from public.users where id = v_vendor.owner_user_id;

    -- Everything that would make this identity more than the store it just
    -- lost. Any one of them and the account stays exactly as it is.
    if found
       and not v_owner.is_admin
       and v_owner.id <> auth.uid()
       and not exists (select 1 from public.customer_profiles c where c.user_id = v_owner.id)
       and not exists (select 1 from public.partner_profiles p where p.user_id = v_owner.id)
       and not exists (select 1 from public.vendors v2 where v2.owner_user_id = v_owner.id)
       and not exists (select 1 from public.orders o
                        where o.customer_id = v_owner.id or o.partner_id = v_owner.id)
       and not exists (select 1 from public.admin_actions a where a.admin_user_id = v_owner.id)
    then
      perform public.admin_purge_test_history(array[v_owner.id], '{}'::uuid[], v_reason);

      delete from public.terms_acceptances t where t.user_id = v_owner.id;
      -- public.users cascades from auth.users, and so do the account's
      -- sessions, identities and factors.
      delete from auth.users u where u.id = v_owner.id;
      v_owner_deleted := true;
    end if;
  end if;

  v_counts := v_counts || jsonb_build_object('owner_account_deleted', v_owner_deleted);

  perform public.log_admin_action(
    'VENDOR_DELETE', 'vendor', p_vendor_id, v_reason, to_jsonb(v_vendor), null,
    jsonb_build_object('counts', v_counts, 'storage_paths', v_paths)
  );

  return jsonb_build_object(
    'name', v_vendor.name,
    'counts', v_counts,
    'storage_paths', jsonb_build_object('vendor-images', v_paths)
  );
end;
$$;

comment on function public.admin_delete_vendor(uuid, text) is
  'Deletes a store that has never traded, with its menu, photographs, queue counter and payout destination, and the owner identity if the store was the only thing it held. Refuses a store with orders or settlement records — suspend those instead. Administrator only, re-checked in the body, audited. Returns the storage object paths the caller must remove through the Storage API.';


-- ---------------------------------------------------------------------------
-- 4. DELETING A CUSTOMER ACCOUNT
-- ---------------------------------------------------------------------------
-- The same rule and the same reason: an account that has ordered is an account
-- whose orders carry money records, and those do not go through a console
-- button. What this removes is an account that never got started — a sign-up
-- from the wrong address, a duplicate, a test — with every capability row built
-- on it, in the order the foreign keys require.
--
-- PARTNER BEFORE CUSTOMER. partner_requires_customer is ON DELETE RESTRICT, and
-- cascading from public.users gives no ordering between the two, so they are
-- deleted explicitly rather than left to the cascade to get right.
--
-- IT REFUSES AN ADMINISTRATOR AND IT REFUSES THE CALLER. admin_actions is the
-- audit trail and keys off the administrator row; losing one would lose the
-- trail's meaning.
create or replace function public.admin_delete_customer(
  p_user_id uuid,
  p_reason  text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_user   public.users%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_orders integer;
  v_paths  jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n      integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_user from public.users where id = p_user_id;
  if not found then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'an administrator cannot delete their own account'
      using errcode = 'check_violation';
  end if;

  if v_user.is_admin
     or exists (select 1 from public.admin_actions a where a.admin_user_id = p_user_id) then
    raise exception 'an administrator account cannot be deleted here'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.vendors v where v.owner_user_id = p_user_id) then
    raise exception 'this account owns a store. Delete the store first.'
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_orders
    from public.orders o
   where o.customer_id = p_user_id or o.partner_id = p_user_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order(s) involve this account, and deleting them would delete the money records that reconcile them. Suspend the account instead.',
      v_orders using errcode = 'foreign_key_violation';
  end if;

  if exists (select 1 from public.allocations a where a.payee_id = p_user_id)
     or exists (select 1 from public.payouts p where p.payee_id = p_user_id) then
    raise exception
      'cannot delete: this account has settlement records. Suspend it instead.'
      using errcode = 'foreign_key_violation';
  end if;

  -- A rating is somebody else's statement about a delivery. With no orders
  -- there can be none, and if there is one it is not this call's to erase.
  if exists (
    select 1 from public.partner_ratings r
     where r.partner_id = p_user_id or r.customer_id = p_user_id
  ) then
    raise exception 'cannot delete: this account has delivery ratings against it.'
      using errcode = 'foreign_key_violation';
  end if;

  -- The object paths, read before the rows that name them are gone. Both
  -- Partner document columns: a current application has only a student ID, but
  -- an older one also has a face photograph, and the one that is missed stays
  -- in storage for ever once the row naming it is deleted.
  select jsonb_build_object(
    'partner-documents',
      coalesce((select jsonb_agg(x.path)
                  from public.partner_profiles pp,
                       lateral (values (pp.student_id_image_path), (pp.face_image_path)) as x(path)
                 where pp.user_id = p_user_id and x.path is not null), '[]'::jsonb),
    'scan-documents',
      coalesce((select jsonb_agg(s.image_path) from public.order_scans s
                 where s.customer_id = p_user_id and s.image_path is not null), '[]'::jsonb)
  ) into v_paths;

  -- The append-only rows, through the existing audited mechanism. It opens and
  -- closes its own transaction-local door; nothing here touches it.
  v_n := public.admin_purge_test_history(array[p_user_id], '{}'::uuid[], v_reason);
  v_counts := v_counts || jsonb_build_object('notification_events', v_n);

  delete from public.order_scans s where s.customer_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('order_scans', v_n);

  delete from public.idempotency_keys k where k.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n);

  delete from public.customer_rewards r where r.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_rewards', v_n);

  delete from public.terms_acceptances t where t.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('terms_acceptances', v_n);

  -- PARTNER BEFORE CUSTOMER. The foreign key between them is RESTRICT.
  delete from public.partner_profiles p where p.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_profiles', v_n);

  delete from public.customer_profiles c where c.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_profiles', v_n);

  -- The identity. public.users cascades from auth.users, and so do the
  -- account's sessions, identities and factors.
  delete from auth.users u where u.id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth_users', v_n);

  perform public.log_admin_action(
    'CUSTOMER_DELETE', 'user', p_user_id, v_reason, to_jsonb(v_user), null,
    jsonb_build_object('counts', v_counts, 'storage_paths', v_paths)
  );

  return jsonb_build_object(
    'name', coalesce(v_user.full_name, v_user.phone, v_user.email),
    'counts', v_counts,
    'storage_paths', v_paths
  );
end;
$$;

comment on function public.admin_delete_customer(uuid, text) is
  'Deletes an account that has never ordered, with every capability row built on it, in the order the foreign keys require. Refuses an administrator, the caller, a store owner, an account with orders, settlement records or delivery ratings. Administrator only, re-checked in the body, audited. Returns the storage object paths the caller must remove through the Storage API.';


-- ---------------------------------------------------------------------------
-- 5. WHO MAY CALL THEM
-- ---------------------------------------------------------------------------
-- Reachable by any signed-in account and AUTHORISED by none of them: each body
-- re-checks is_admin(), so a customer who calls one directly is raised at, not
-- answered. That is the same contract every other admin_* function holds, and
-- tests/schema.test.js asserts the whole surface against an allowlist.

revoke all on function public.admin_create_vendor_account(
  uuid, text, text, text, uuid, text, boolean, uuid, text, integer) from public, anon;
grant execute on function public.admin_create_vendor_account(
  uuid, text, text, text, uuid, text, boolean, uuid, text, integer) to authenticated, service_role;

revoke all on function public.admin_delete_vendor(uuid, text) from public, anon;
grant execute on function public.admin_delete_vendor(uuid, text) to authenticated, service_role;

revoke all on function public.admin_delete_customer(uuid, text) from public, anon;
grant execute on function public.admin_delete_customer(uuid, text) to authenticated, service_role;
