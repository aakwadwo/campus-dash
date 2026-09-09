-- ============================================================================
-- FIRST NAME / LAST NAME
-- ============================================================================
-- A person has a first name and a last name. Campus Dash needs the first one on
-- its own — "Kwame has accepted your order" reads like a person, "Kwame Mensah
-- has accepted your order" reads like a database — and it needs the pair for
-- anything that identifies somebody properly.
--
-- full_name STAYS. Roughly forty read models, three SMS templates and every
-- admin screen select it, and rewriting all of them to concatenate two columns
-- would be a large diff that changes no behaviour. Instead full_name becomes
-- DERIVED: a trigger keeps it equal to "first last" whenever the parts are set,
-- so it is still the one column to read for a display name and it can no longer
-- drift from the parts.
--
-- Existing rows are split on the first space. That is the only split that is
-- ever right without asking, and it is why the parts are editable afterwards.

alter table public.users
  add column if not exists first_name text,
  add column if not exists last_name  text;

comment on column public.users.first_name is
  'Given name. What a Partner is called to a customer and a customer to a Partner — never a surname, never a phone number.';
comment on column public.users.last_name is
  'Family name. Shown to administrators and on the account screen; never to the other side of a delivery.';
comment on column public.users.full_name is
  'DERIVED from first_name and last_name by users_sync_full_name(). Still the one column every read model selects for a display name; no longer a separate fact that can drift from the parts.';

-- Split what is already there. btrim first, so a stray double space does not
-- become an empty first name.
update public.users
   set first_name = nullif(split_part(btrim(full_name), ' ', 1), ''),
       last_name  = nullif(btrim(substr(btrim(full_name), length(split_part(btrim(full_name), ' ', 1)) + 1)), '')
 where full_name is not null
   and first_name is null
   and last_name is null;

create or replace function public.users_sync_full_name() returns trigger
  language plpgsql
  set search_path to ''
as $$
begin
  new.first_name := nullif(btrim(coalesce(new.first_name, '')), '');
  new.last_name  := nullif(btrim(coalesce(new.last_name,  '')), '');

  -- The parts win when either is present. When neither is, full_name is left
  -- exactly as the caller set it: an account created before this migration and
  -- never edited keeps the name it has.
  if new.first_name is not null or new.last_name is not null then
    new.full_name := nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), '');
  else
    new.full_name := nullif(btrim(coalesce(new.full_name, '')), '');
  end if;

  return new;
end;
$$;

alter function public.users_sync_full_name() owner to postgres;
revoke all on function public.users_sync_full_name() from public;

drop trigger if exists users_sync_full_name on public.users;
create trigger users_sync_full_name
  before insert or update of first_name, last_name, full_name on public.users
  for each row execute function public.users_sync_full_name();

-- ---------------------------------------------------------------------------
-- The one place a first name is derived
-- ---------------------------------------------------------------------------
-- Read models want "the first name, and something sensible when there is not
-- one". Written once so every screen agrees, and IMMUTABLE so it can sit in a
-- view or an index expression later without a second thought.

create or replace function public.given_name(p_first text, p_full text)
  returns text
  language sql immutable
as $$
  select coalesce(
    nullif(btrim(coalesce(p_first, '')), ''),
    nullif(split_part(btrim(coalesce(p_full, '')), ' ', 1), '')
  );
$$;

alter function public.given_name(text, text) owner to postgres;
comment on function public.given_name(text, text) is
  'The first name to show, falling back to the first word of a legacy full_name. One definition, so every screen calls the same person the same thing.';
revoke all on function public.given_name(text, text) from public;
grant execute on function public.given_name(text, text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Writers
-- ---------------------------------------------------------------------------

drop function if exists public.update_my_profile(text);

create or replace function public.update_my_profile(p_first_name text, p_last_name text)
  returns public.users
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_user public.users%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;

  update public.users
     set first_name = btrim(p_first_name),
         last_name  = nullif(btrim(coalesce(p_last_name, '')), '')
   where id = auth.uid()
  returning * into v_user;

  return v_user;
end;
$$;

alter function public.update_my_profile(text, text) owner to postgres;
revoke all on function public.update_my_profile(text, text) from public;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- Customer onboarding takes the pair too. Same signature change, same reason.
drop function if exists public.complete_customer_onboarding(text, text, text, text, uuid);

create or replace function public.complete_customer_onboarding(
  p_first_name        text,
  p_last_name         text,
  p_student_id_number text,
  p_level             text,
  p_phone             text,
  p_terms_id          uuid
) returns public.customer_profiles
  language plpgsql security definer
  set search_path to ''
as $_$
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

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_last_name, '')), '') is null then
    raise exception 'your last name is required' using errcode = 'check_violation';
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
    values (v_user, btrim(p_student_id_number), btrim(p_level))
    -- Re-running sign-up updates the declared facts. It never revokes the
    -- capability, and it never moves onboarded_at: when somebody became a
    -- customer is a historical fact, not a field.
    on conflict (user_id) do update
       set student_id_number = excluded.student_id_number,
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

alter function public.complete_customer_onboarding(text, text, text, text, text, uuid) owner to postgres;
revoke all on function public.complete_customer_onboarding(text, text, text, text, text, uuid) from public;
grant execute on function public.complete_customer_onboarding(text, text, text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------

-- Capabilities carry the parts as well as the whole. Every screen that greets
-- somebody by name now has a first name to greet them with.
create or replace function public.my_capabilities() returns jsonb
  language sql stable security definer
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
        'student_id_number', c.student_id_number,
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

alter function public.my_capabilities() owner to postgres;

-- WHAT THE CUSTOMER IS TOLD ABOUT THE PARTNER: a first name. "Kwame is on the
-- way" is what the product should say; a surname adds nothing to finding the
-- person at your door and is somebody's private data. The phone number rule is
-- untouched — assignment to completion, and never afterwards.
create or replace function public.customer_order_detail(p_order_id uuid)
  returns table(
    order_id uuid, order_number text, vendor_name text, vendor_location text,
    stage text, order_status public.order_status, payment_status public.payment_status,
    delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
    order_type public.order_type,
    subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint,
    total_pesewas bigint, destination text, destination_note text,
    submitted_at timestamptz, seconds_to_deadline integer,
    accepted_at timestamptz, preparing_at timestamptz, ready_at timestamptz,
    assigned_at timestamptz, picked_up_at timestamptz, completed_at timestamptz,
    cancellation_reason text, payment_id uuid, payment_txn_status public.payment_txn_status,
    partner_name text, partner_phone text, delivery_code text, pickup_code text,
    disputed boolean, dispute_reason text, items jsonb
  )
  language sql stable security definer
  set search_path to ''
as $$
  select o.id, o.order_number, v.name, public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas, o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- THE PARTNER'S FIRST NAME, and only while they are carrying it.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP')
              then public.given_name(pu.first_name, pu.full_name) end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         case when o.fulfilment_type = 'PICKUP' and o.payment_status = 'PAID'
                   and o.order_status in ('PREPARING', 'READY')
              then s.pickup_code end,
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;

alter function public.customer_order_detail(uuid) owner to postgres;

-- The Partner's side of the same rule. A first name is what you call out when
-- you reach the door; it is added rather than replacing customer_name, which
-- admin reassignment screens and the delivery header already read.
drop function if exists public.partner_active_delivery();

create or replace function public.partner_active_delivery()
  returns table(
    order_id uuid, order_number text, partner_slot smallint,
    delivery_status public.delivery_status,
    vendor_name text, vendor_location text, vendor_phone text,
    destination_zone text, destination text, destination_note text,
    customer_name text, customer_first_name text, customer_phone text,
    earnings_pesewas bigint, item_count bigint,
    assigned_at timestamptz, picked_up_at timestamptz,
    customer_absent_reported_at timestamptz, seconds_until_absent_allowed integer,
    order_type public.order_type, scan_status public.scan_status
  )
  language sql stable security definer
  set search_path to ''
as $$
  select o.id,
         o.order_number,
         o.partner_slot,
         o.delivery_status,
         v.name,
         public.location_path(v.location_id),
         -- The vendor's phone is operational, not private: the Partner may need
         -- to say they are running late.
         v.phone,
         coalesce(z.name, 'Campus'),
         -- THE EXACT DESTINATION AND THE CUSTOMER'S NUMBER, from assignment.
         -- A Partner who cannot find a room needs to ring before they are
         -- holding food that is going cold, not after.
         public.location_path(o.destination_location_id),
         o.destination_note,
         c.full_name,
         public.given_name(c.first_name, c.full_name),
         c.phone,
         o.partner_earnings_pesewas,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.assigned_at,
         o.picked_up_at,
         o.customer_absent_reported_at,
         case when o.customer_absent_reported_at is not null
              then greatest(
                0,
                extract(epoch from (
                  o.customer_absent_reported_at
                    + make_interval(secs => (select customer_absent_wait_seconds
                                               from public.pricing_config where id))
                  - now()))::integer
              ) end,
         o.order_type,
         o.scan_status
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    join public.users c on c.id = o.customer_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     -- The window, in the one place it is actually enforced for this screen.
     -- DELIVERED is absent on purpose: a finished delivery stops showing a
     -- phone number, and partner_delivery_history never carried one.
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
   order by o.partner_slot, o.assigned_at;
$$;

alter function public.partner_active_delivery() owner to postgres;
revoke all on function public.partner_active_delivery() from public;
grant execute on function public.partner_active_delivery() to authenticated;
