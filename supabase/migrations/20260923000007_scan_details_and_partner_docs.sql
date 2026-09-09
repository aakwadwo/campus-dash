-- ============================================================================
-- SCAN DETAILS, AND THE PARTNER'S DOCUMENTS
-- ============================================================================
-- Two changes that happen to be about the same thing: what somebody has to
-- provide before Campus Dash will act for them.
--
-- 1. A SCAN ERRAND NOW CARRIES INSTRUCTIONS. The old screen had an optional
--    "anything else?" that was really a note about the destination. What a
--    Partner standing at a counter actually needs is what the customer wants —
--    which meal, which counter, what to do if it is finished. That is now a
--    required field of its own, and it is the first thing the Partner is shown.
--
-- 2. A PARTNER NO LONGER SUPPLIES A FACE PHOTOGRAPH. They already hold the
--    CUSTOMER capability, which means a verified @acity.edu.gh address has
--    already proved who they are. A second photograph proved nothing the school
--    address had not, and it is the most sensitive thing Campus Dash was
--    holding. Onboarding is now: the student ID, the Partner terms, and an
--    administrator's approval.
--
--    THE COLUMN STAYS. Existing applications have one on file and an audit has
--    to be able to see what a past decision was made on. It is simply never
--    written again, and the retention purge already deletes it on schedule.

alter table public.order_scans
  add column if not exists details text;

alter table public.order_scans drop constraint if exists order_scans_details_length;
alter table public.order_scans
  add constraint order_scans_details_length
  check (details is null or (btrim(details) <> '' and length(details) <= 1000));

comment on column public.order_scans.details is
  'What the customer wants done with this scan, in their own words. Required on every new errand; NULL only on errands created before the field existed.';

drop function if exists public.submit_scan_order(uuid, uuid, text, text, bigint, text);

create or replace function public.submit_scan_order(
  p_vendor_id uuid,
  p_destination_location_id uuid,
  p_scan_image_path text,
  p_content_type text,
  p_byte_size bigint,
  p_details text,
  p_destination_note text default null
) returns table(order_id uuid, order_number text, total_pesewas bigint)
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_customer uuid := auth.uid();
  v_price    record;
  v_order    public.orders%rowtype;
  v_prefix   text;
  v_details  text := nullif(btrim(coalesce(p_details, '')), '');
begin
  if v_customer is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- ORDERING IS A CAPABILITY. Browsing needs no account; this needs a completed
  -- student onboarding, exactly like a food order.
  if not public.is_customer(v_customer) then
    raise exception 'complete your student details before ordering'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_scan_image_path, '')), '') is null then
    raise exception 'a scan is required' using errcode = 'check_violation';
  end if;

  -- REQUIRED, and checked here rather than only in the form. A Partner who
  -- reaches a counter with a scan and no instructions has to ring the customer
  -- and ask, which is the call this field exists to prevent.
  if v_details is null then
    raise exception 'tell us what you want, so the Partner knows what to ask for'
      using errcode = 'check_violation';
  end if;
  if length(v_details) > 1000 then
    raise exception 'keep the details under 1000 characters' using errcode = 'check_violation';
  end if;

  -- THE PATH MUST BE THE CALLER'S OWN. Uploads land under <user_id>/scans/…,
  -- so anything else is either a mistake or an attempt to attach a scan the
  -- caller does not own. Checked here as well as at upload, because this
  -- function is the one that grants the Partner a later right to read it.
  v_prefix := v_customer::text || '/scans/';
  if left(p_scan_image_path, length(v_prefix)) <> v_prefix then
    raise exception 'that scan does not belong to this account'
      using errcode = 'insufficient_privilege';
  end if;

  -- Prices come from the server, always. Nothing the client sent is trusted.
  select * into v_price
    from public.price_scan_order(p_vendor_id, p_destination_location_id);

  insert into public.orders (
    customer_id, vendor_id, order_type, fulfilment_type,
    order_status, payment_status, delivery_status, scan_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    submitted_at, accepted_at
  )
  values (
    v_customer, p_vendor_id, 'SCAN', 'DELIVERY',
    -- ACCEPTED with no vendor involved: see above. NONE, not SEARCHING —
    -- dispatch opens on payment, so a Partner never sees an unpaid errand.
    'ACCEPTED', 'UNPAID', 'NONE', 'UPLOADED',
    p_destination_location_id, nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    0, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas,
    v_price.partner_earnings_pesewas, v_price.total_pesewas,
    now(), now()
  )
  returning * into v_order;

  insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size, details)
  values (v_order.id, v_customer, p_scan_image_path, p_content_type, p_byte_size, v_details);

  -- Same secrets row a food order gets. partner_accept_delivery() fills in both
  -- codes on assignment, and without this row that UPDATE would match nothing
  -- and the customer would never have a delivery code to hand over.
  insert into public.order_secrets (order_id) values (v_order.id);

  perform public.log_order_event(
    v_order.id, 'SCAN_ORDER_SUBMITTED', true, 'CUSTOMER',
    'order_status', null, 'ACCEPTED', null,
    jsonb_build_object('vendor_id', p_vendor_id, 'scan_status', 'UPLOADED')
  );

  return query select v_order.id, v_order.order_number, v_order.total_pesewas;
end;
$$;

alter function public.submit_scan_order(uuid, uuid, text, text, bigint, text, text) owner to postgres;
revoke all on function public.submit_scan_order(uuid, uuid, text, text, bigint, text, text) from public;
grant execute on function public.submit_scan_order(uuid, uuid, text, text, bigint, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Who may read the instructions
-- ---------------------------------------------------------------------------
-- EXACTLY the people who may already read the scan image: the customer, the
-- Partner the errand was released to, and an administrator. That is the
-- order_scans RLS policy, unchanged — the details ride on the same row and the
-- same rule, so there is no second authorisation to keep in step.

drop function if exists public.my_scan_order(uuid);

create or replace function public.my_scan_order(p_order_id uuid)
  returns table(
    order_id uuid, scan_status public.scan_status, details text,
    uploaded_at timestamptz, released_at timestamptz,
    redeemed_at timestamptz, refused_at timestamptz, refusal_reason text
  )
  language sql stable security definer
  set search_path to ''
as $$
  select s.order_id, o.scan_status, s.details, s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason
    from public.order_scans s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and (s.customer_id = auth.uid() or public.is_admin());
$$;

alter function public.my_scan_order(uuid) owner to postgres;
revoke all on function public.my_scan_order(uuid) from public;
grant execute on function public.my_scan_order(uuid) to authenticated;

-- The Partner's screen. Gated on the SAME release the image is gated on, so
-- there is one moment at which an errand becomes readable and one at which it
-- stops.
create or replace function public.partner_scan_brief(p_order_id uuid)
  returns table(
    order_id uuid, order_number text, restaurant_name text,
    details text, scan_status public.scan_status
  )
  language sql stable security definer
  set search_path to ''
as $$
  select o.id, o.order_number, v.name, s.details, o.scan_status
    from public.order_scans s
    join public.orders o on o.id = s.order_id
    join public.vendors v on v.id = o.vendor_id
   where s.order_id = p_order_id
     and s.released_to = auth.uid()
     and o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;

alter function public.partner_scan_brief(uuid) owner to postgres;
comment on function public.partner_scan_brief(uuid) is
  'What the assigned Partner is told about a scan errand. Gated on the same release as the image itself — assignment opens it, and the end of the delivery closes it.';
revoke all on function public.partner_scan_brief(uuid) from public;
grant execute on function public.partner_scan_brief(uuid) to authenticated;

drop function if exists public.admin_scan_order(uuid);

create or replace function public.admin_scan_order(p_order_id uuid)
  returns table(
    order_id uuid, order_number text, customer_name text, restaurant_name text,
    destination text, details text,
    scan_status public.scan_status, order_status public.order_status,
    payment_status public.payment_status, delivery_status public.delivery_status,
    partner_name text,
    service_fee_pesewas bigint, delivery_fee_pesewas bigint,
    partner_earnings_pesewas bigint, total_pesewas bigint,
    has_scan_image boolean, uploaded_at timestamptz, released_at timestamptz,
    redeemed_at timestamptz, refused_at timestamptz, refusal_reason text
  )
  language sql stable security definer
  set search_path to ''
as $$
  select
    o.id, o.order_number,
    c.full_name, v.name, public.location_path(o.destination_location_id),
    s.details,
    o.scan_status, o.order_status, o.payment_status, o.delivery_status,
    p.full_name,
    o.service_fee_pesewas, o.delivery_fee_pesewas, o.partner_earnings_pesewas, o.total_pesewas,
    (s.image_path is not null),
    s.uploaded_at, s.released_at, s.redeemed_at, s.refused_at, s.refusal_reason
  from public.orders o
  join public.users c on c.id = o.customer_id
  join public.vendors v on v.id = o.vendor_id
  left join public.users p on p.id = o.partner_id
  left join public.order_scans s on s.order_id = o.id
  where o.id = p_order_id
    and o.order_type = 'SCAN'
    and public.is_admin();
$$;

alter function public.admin_scan_order(uuid) owner to postgres;
revoke all on function public.admin_scan_order(uuid) from public;
grant execute on function public.admin_scan_order(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Partner onboarding: the student ID, and nothing else
-- ---------------------------------------------------------------------------

drop function if exists public.partner_apply(text, text);

create or replace function public.partner_apply(p_student_id_image_path text)
  returns public.partner_profiles
  language plpgsql security definer
  set search_path to ''
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

  return v_profile;
end;
$$;

alter function public.partner_apply(text) owner to postgres;
revoke all on function public.partner_apply(text) from public;
grant execute on function public.partner_apply(text) to authenticated;

-- "Have we got what we asked for?" — and what we ask for is now one document,
-- so requiring two would tell every new applicant their application is
-- incomplete forever.
create or replace function public.my_partner_application()
  returns table(
    status public.partner_application_status,
    applied_at timestamptz, reviewed_at timestamptz, review_notes text,
    is_available boolean, has_documents boolean
  )
  language sql stable security definer
  set search_path to ''
as $$
  select p.status, p.applied_at, p.reviewed_at, p.review_notes, p.is_available,
         nullif(btrim(coalesce(p.student_id_image_path, '')), '') is not null
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;

alter function public.my_partner_application() owner to postgres;
revoke all on function public.my_partner_application() from public;
grant execute on function public.my_partner_application() to authenticated;
