-- ============================================================================
-- Settlement eligibility, and the recipient lists notifications need
-- ============================================================================
-- No change to how money moves. Settlement is still manual, still initiated by
-- an administrator, still PROCESSING → PAID or FAILED on the provider's own
-- event, still retried only by hand. What was missing was the screen's half of
-- it: an operator could see what was owed, but not whether it was YET DUE.
--
-- Vendors settle daily and Partners weekly, and that cadence lived only in
-- JavaScript (lib/settlement/periodFor). So "GH₵240 owed" told an operator
-- nothing about whether today was the day. This adds one read model that
-- answers the actual question.
--
-- Also here: the recipient lists. Notifications are sent by the application,
-- from the service role, and it needs to ask the database who to tell — which
-- eligible Partners are online for a new offer, which account owns a vendor
-- that was just approved, who a payout belongs to. Each is a service-only
-- function, because each returns a phone number to somebody who is not the
-- person it belongs to.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. What is owed, and whether it is due
-- ---------------------------------------------------------------------------
create or replace function public.admin_settlement_overview()
returns table (
  payee_type      public.payee_type,
  payee_id        uuid,
  payee_name      text,
  payee_contact   text,
  order_count     bigint,
  owed_pesewas    bigint,
  oldest_at       timestamptz,
  cadence         text,
  eligible_from   timestamptz,
  is_due          boolean,
  below_minimum   boolean,
  last_paid_at    timestamptz,
  failed_payouts  bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with cfg as (select * from public.pricing_config where id),
  owed as (
    select a.payee_type, a.payee_id,
           count(*) as order_count,
           sum(a.amount_pesewas)::bigint as owed_pesewas,
           min(o.created_at) as oldest_at
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.payee_type in ('VENDOR', 'PARTNER')
       and a.status = 'ELIGIBLE'
       and a.settlement_run_id is null
     group by a.payee_type, a.payee_id
  )
  select w.payee_type,
         w.payee_id,
         case w.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = w.payee_id)
           else                (select u.full_name from public.users u where u.id = w.payee_id)
         end,
         case w.payee_type
           when 'VENDOR'  then (select coalesce(o.phone, v.phone) from public.vendors v
                                  left join public.users o on o.id = v.owner_user_id
                                 where v.id = w.payee_id)
           else                (select u.phone from public.users u where u.id = w.payee_id)
         end,
         w.order_count,
         w.owed_pesewas,
         w.oldest_at,
         -- The cadence, said out loud rather than implied by a helper in a
         -- different language.
         case w.payee_type when 'VENDOR' then 'DAILY' else 'WEEKLY' end,
         -- When this money first becomes settleable: the end of the day it was
         -- earned for a vendor, the end of that week for a Partner.
         case w.payee_type
           when 'VENDOR' then date_trunc('day', w.oldest_at) + interval '1 day'
           else               date_trunc('week', w.oldest_at) + interval '1 week'
         end,
         now() >= case w.payee_type
           when 'VENDOR' then date_trunc('day', w.oldest_at) + interval '1 day'
           else               date_trunc('week', w.oldest_at) + interval '1 week'
         end,
         -- Below the threshold a transfer costs more in fees than it moves, so
         -- a run would claim it and immediately hand it back. Saying so here
         -- stops an operator wondering why the button did nothing.
         w.owed_pesewas < greatest((select coalesce(min_payout_pesewas, 0) from cfg), 1),
         (select max(p.paid_at) from public.payouts p
           where p.payee_type = w.payee_type and p.payee_id = w.payee_id and p.status = 'PAID'),
         (select count(*) from public.payouts p
           where p.payee_type = w.payee_type and p.payee_id = w.payee_id and p.status = 'FAILED')
    from owed w
   where public.is_admin()
   order by w.payee_type, w.owed_pesewas desc;
$$;
grant execute on function public.admin_settlement_overview() to authenticated;

-- Every payout ever, not only the ones in the run currently on screen. "Show me
-- what we have actually paid this vendor" was three clicks and a run id away.
create or replace function public.admin_payout_history(
  p_payee_type public.payee_type default null,
  p_status     text default null,
  p_limit      integer default 100
)
returns table (
  payout_id uuid, settlement_run_id uuid, payee_type public.payee_type,
  payee_id uuid, payee_name text, amount_pesewas bigint,
  status public.payout_status, provider text, provider_transfer_id text,
  failure_reason text, transfer_attempt integer,
  period_start timestamptz, period_end timestamptz,
  created_at timestamptz, paid_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.settlement_run_id, p.payee_type, p.payee_id,
         case p.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           else 'Campus Dash'
         end,
         p.amount_pesewas, p.status, p.provider, p.provider_transfer_id,
         p.failure_reason, p.transfer_attempt,
         r.period_start, r.period_end,
         p.created_at, p.paid_at
    from public.payouts p
    left join public.settlement_runs r on r.id = p.settlement_run_id
   where public.is_admin()
     and (p_payee_type is null or p.payee_type = p_payee_type)
     and (p_status is null or btrim(p_status) = '' or p.status::text = p_status)
   order by p.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;
grant execute on function public.admin_payout_history(public.payee_type, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Who to tell
-- ---------------------------------------------------------------------------
-- SERVICE ROLE ONLY, all three. Each returns a phone number to a caller who is
-- not the person it belongs to, which is the definition of something a client
-- must not be able to ask for. There is no grant to anon or authenticated, and
-- assert_service_or_admin() re-checks in the body — reachability and
-- authorisation are separate answers.

-- The broadcast list for a new delivery offer. Eligibility is re-derived from
-- exactly the rules get_delivery_offers() uses, so nobody is texted about work
-- they would then be refused.
create or replace function public.partners_to_notify_of_offer(p_order_id uuid)
returns table (user_id uuid, phone text, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_service_or_admin();

  return query
    select u.id, u.phone, u.full_name
      from public.partner_profiles pp
      join public.users u on u.id = pp.user_id
      join public.orders o on o.id = p_order_id
      join public.vendors v on v.id = o.vendor_id
     where pp.status = 'APPROVED'
       and pp.is_available
       and not u.is_suspended
       and u.phone is not null
       and o.delivery_status = 'SEARCHING'
       and o.order_status = 'READY'
       and o.payment_status = 'PAID'
       -- The same two conflicts of interest, and the same capacity limit.
       and o.customer_id <> u.id
       and v.owner_user_id is distinct from u.id
       and (
         select count(*) from public.orders a
          where a.partner_id = u.id
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < 2;
end;
$$;
revoke all on function public.partners_to_notify_of_offer(uuid) from public, anon, authenticated;

-- The account behind a store, for the approval and payout messages. A vendor
-- with no owner returns nothing rather than the store's own contact number:
-- a catalogue entry has nobody to congratulate.
create or replace function public.vendor_owner_contact(p_vendor_id uuid)
returns table (user_id uuid, phone text, full_name text, store_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_service_or_admin();

  return query
    select u.id, u.phone, u.full_name, v.name
      from public.vendors v
      join public.users u on u.id = v.owner_user_id
     where v.id = p_vendor_id and u.phone is not null;
end;
$$;
revoke all on function public.vendor_owner_contact(uuid) from public, anon, authenticated;

-- Where a payout notification goes. Resolves both payee types in one place, so
-- the notification code does not branch on which kind of person it is paying.
create or replace function public.payout_recipient_contact(p_payout_id uuid)
returns table (payee_type public.payee_type, phone text, display_name text, amount_pesewas bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.assert_service_or_admin();

  return query
    select p.payee_type,
           case p.payee_type
             when 'VENDOR'  then (select coalesce(ow.phone, v.phone) from public.vendors v
                                    left join public.users ow on ow.id = v.owner_user_id
                                   where v.id = p.payee_id)
             when 'PARTNER' then (select u.phone from public.users u where u.id = p.payee_id)
           end,
           case p.payee_type
             when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
             when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           end,
           p.amount_pesewas
      from public.payouts p
     where p.id = p_payout_id and p.payee_type in ('VENDOR', 'PARTNER');
end;
$$;
revoke all on function public.payout_recipient_contact(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. The vendor board says when a Partner is waiting
-- ---------------------------------------------------------------------------
-- The vendor now holds the pickup code, so "somebody is at the counter and I
-- need to read them a number" has to be visible from the board, not only from
-- inside one order.
drop function if exists public.vendor_order_board(uuid, integer);
create function public.vendor_order_board(p_vendor_id uuid, p_closed_limit integer default 20)
returns table (
  order_id uuid, order_number text, bucket text,
  order_status public.order_status, payment_status public.payment_status,
  delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
  item_count bigint, total_pesewas bigint, submitted_at timestamptz,
  accept_deadline_at timestamptz, seconds_to_deadline integer, age_seconds integer,
  destination_zone text, partner_assigned boolean, partner_waiting boolean,
  awaiting_collection boolean, cancellation_reason text
)
language sql
stable
security definer
set search_path = ''
as $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       and o.order_status <> 'DRAFT'
       -- A scan order asks nothing of the restaurant through Campus Dash.
       and o.order_type = 'FOOD'
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket(v.order_status) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket(v.order_status)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.bucket,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         r.total_pesewas,
         r.submitted_at,
         r.accept_deadline_at,
         case when r.accept_deadline_at is not null
              then extract(epoch from (r.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
         r.partner_id is not null,
         (r.delivery_status = 'ASSIGNED'),
         (r.fulfilment_type = 'PICKUP' and r.order_status = 'READY' and r.payment_status = 'PAID'),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'PREPARING' then 1 when 'READY' then 2 else 3 end,
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Sign-up says what went wrong, in words
-- ---------------------------------------------------------------------------
-- Restores three exception handlers the rewrite in 20260922000001 dropped. A
-- raw `duplicate key value violates unique constraint
-- "customer_profiles_student_id_unique"` is not a sentence anybody can act on —
-- it is a constraint name shown to a student who typed a digit wrong. The
-- CONSTRAINTS are the enforcement either way; these turn each one into an
-- instruction.
create or replace function public.complete_customer_onboarding(
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

  begin
    update public.users
       set full_name = btrim(p_full_name),
           email     = v_email,
           phone     = v_phone
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
$$;
