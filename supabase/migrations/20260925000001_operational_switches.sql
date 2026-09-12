-- ============================================================================
-- OPERATIONAL SWITCHES
-- ============================================================================
-- Three things an administrator needs to be able to change during a pilot
-- without a deploy, and one thing a vendor needs to stop doing by hand.
--
--   1. PARTNER DELIVERY, ON OR OFF. When nobody is available to carry
--      anything, delivery should disappear from the checkout — not be offered,
--      taken, paid for and then stranded. The switch governs NEW orders only.
--      An order already paid for is somebody's dinner and a Partner's GH₵5;
--      flipping a setting must not reach either.
--
--   2. THE DISPOSABLE PACK FEE, on scan errands only. Campus Dash buys the
--      containers a scan meal is carried in; a normal food order arrives in the
--      vendor's own packaging and is charged nothing for it. It is a separate
--      column on the order rather than folded into the service fee, because a
--      customer who is charged for something is entitled to see what.
--
--   3. REOPENING A STORE CLEARS ITS SOLD-OUT MARKS. "We ran out of jollof" is
--      a fact about today's service, not a standing property of the dish.
--      Asking a vendor to walk back through the menu every morning is how a
--      menu ends up permanently half sold out.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE SWITCHES THEMSELVES
-- ---------------------------------------------------------------------------

alter table public.pricing_config
  add column if not exists partner_delivery_enabled boolean not null default true,
  add column if not exists scan_pack_fee_pesewas bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pricing_config_scan_pack_fee_check'
  ) then
    alter table public.pricing_config
      add constraint pricing_config_scan_pack_fee_check check (scan_pack_fee_pesewas >= 0);
  end if;
end;
$$;

comment on column public.pricing_config.partner_delivery_enabled IS
  'Whether Partner delivery may be CHOSEN. False hides it at the checkout and refuses it at submission; collection is unaffected. It reaches no order that already exists — an order paid for as a delivery stays a delivery.';

comment on column public.pricing_config.scan_pack_fee_pesewas IS
  'What a scan errand is charged for disposable packaging, in pesewas. SCAN ORDERS ONLY: a normal food order arrives in the store''s own packaging and is charged nothing. Zero is a legitimate setting and means the packs are absorbed.';

-- ---------------------------------------------------------------------------
-- 2. THE PACK FEE ON THE ORDER
-- ---------------------------------------------------------------------------
-- A column of its own, so the customer's receipt can name it and so the total
-- constraint still adds up from parts that each mean something.

alter table public.orders
  add column if not exists pack_fee_pesewas bigint not null default 0;

comment on column public.orders.pack_fee_pesewas IS
  'The disposable pack fee charged on this order, snapshotted at submission. Always 0 on a FOOD order — the check constraint says so — because Campus Dash only buys packaging for a scan errand.';

alter table public.orders drop constraint if exists orders_total_is_sum;

alter table public.orders
  add constraint orders_total_is_sum
  check (total_pesewas = subtotal_pesewas + service_fee_pesewas + delivery_fee_pesewas + pack_fee_pesewas);

alter table public.orders drop constraint if exists orders_pack_fee_check;
alter table public.orders
  add constraint orders_pack_fee_check check (pack_fee_pesewas >= 0);

alter table public.orders drop constraint if exists orders_pack_fee_scan_only;
alter table public.orders
  add constraint orders_pack_fee_scan_only
  check (order_type = 'SCAN' or pack_fee_pesewas = 0);

-- ---------------------------------------------------------------------------
-- 3. SCAN PRICING, WITH THE PACK
-- ---------------------------------------------------------------------------

drop function if exists public.price_scan_order(uuid, uuid);

create or replace function public.price_scan_order(
  p_vendor_id uuid,
  p_destination_location_id uuid
)
returns table(
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  partner_earnings_pesewas bigint,
  total_pesewas bigint,
  destination_zone_id uuid
)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_service  bigint;
  v_delivery bigint;
  v_pack     bigint;
  v_earnings bigint;
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id
       and status = 'ACTIVE'
       and is_accepting_orders
       and can_accept_scans
  ) then
    raise exception 'this restaurant is not accepting scan deliveries'
      using errcode = 'check_violation';
  end if;

  if p_destination_location_id is null then
    raise exception 'scan deliveries require a destination' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.locations
     where id = p_destination_location_id and is_deliverable and is_active
  ) then
    raise exception 'destination is not a valid delivery location'
      using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- The refusal that keeps an unpriced product off the shelf: null is
  -- "undecided", and guessing a number here would be inventing revenue policy
  -- in a pricing function.
  if v_cfg.scan_service_fee_pesewas is null then
    raise exception
      'scan deliveries are not configured yet: an administrator must set the scan service fee'
      using errcode = 'check_violation';
  end if;

  -- A SCAN ERRAND IS ALWAYS A DELIVERY, so the Partner switch applies to it
  -- exactly as it does to a food delivery: with nobody to carry it, there is
  -- no errand to sell.
  if not coalesce(v_cfg.partner_delivery_enabled, true) then
    raise exception 'scan deliveries are unavailable right now'
      using errcode = 'check_violation';
  end if;

  v_service  := v_cfg.scan_service_fee_pesewas;
  v_delivery := v_cfg.delivery_fee_pesewas;
  v_pack     := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  -- Same carve as a food delivery. The Partner is paid for the errand, and the
  -- errand is identical work.
  v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;

  return query select
    0::bigint,
    v_service,
    v_delivery,
    v_pack,
    v_earnings,
    v_service + v_delivery + v_pack,
    public.location_zone(p_destination_location_id);
end;
$$;

drop function if exists public.quote_scan_order(uuid, uuid);

create or replace function public.quote_scan_order(
  p_vendor_id uuid,
  p_destination_location_id uuid
)
returns table(
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  total_pesewas bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select p.subtotal_pesewas, p.service_fee_pesewas, p.delivery_fee_pesewas,
         p.pack_fee_pesewas, p.total_pesewas
    from public.price_scan_order(p_vendor_id, p_destination_location_id) p;
$$;

create or replace function public.submit_scan_order(
  p_vendor_id uuid,
  p_destination_location_id uuid,
  p_scan_image_path text,
  p_content_type text,
  p_byte_size bigint,
  p_details text,
  p_destination_note text default null
)
returns table(order_id uuid, order_number text, total_pesewas bigint)
language plpgsql
security definer
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
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, pack_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    submitted_at, accepted_at
  )
  values (
    v_customer, p_vendor_id, 'SCAN', 'DELIVERY',
    -- ACCEPTED with no vendor involved. NONE, not SEARCHING — dispatch opens
    -- on payment, so a Partner never sees an unpaid errand.
    'ACCEPTED', 'UNPAID', 'NONE', 'UPLOADED',
    p_destination_location_id, nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    0, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas, v_price.pack_fee_pesewas,
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
    jsonb_build_object('vendor_id', p_vendor_id, 'scan_status', 'UPLOADED',
                       'pack_fee_pesewas', v_price.pack_fee_pesewas)
  );

  return query select v_order.id, v_order.order_number, v_order.total_pesewas;
end;
$$;

-- The customer's own view of their errand, now naming the pack fee.
drop function if exists public.my_scan_order(uuid);

create or replace function public.my_scan_order(p_order_id uuid)
returns table(
  order_id uuid,
  scan_status public.scan_status,
  details text,
  uploaded_at timestamp with time zone,
  released_at timestamp with time zone,
  redeemed_at timestamp with time zone,
  refused_at timestamp with time zone,
  refusal_reason text,
  pack_fee_pesewas bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select s.order_id, o.scan_status, s.details, s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason,
         coalesce(o.pack_fee_pesewas, 0)
    from public.order_scans s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and (s.customer_id = auth.uid() or public.is_admin());
$$;

-- ---------------------------------------------------------------------------
-- 4. OPENING THE STORE CLEARS THE SOLD-OUT MARKS
-- ---------------------------------------------------------------------------

create or replace function public.vendor_set_accepting_orders(
  p_vendor_id uuid,
  p_accepting boolean
)
returns public.vendors
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.vendors%rowtype;
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;

  update public.vendors set is_accepting_orders = p_accepting
   where id = p_vendor_id and status = 'ACTIVE'
  returning * into v_vendor;

  if not found then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;

  -- CLOSED → OPEN clears every sold-out mark. Running out of something is a
  -- fact about a service, not a property of the dish, and a vendor who has to
  -- untick fourteen items before they can sell anything will stop bothering.
  -- Guarded on the transition, so pressing Open twice does not reset a mark
  -- somebody set deliberately a minute ago while already open.
  if p_accepting and not coalesce(v_before.is_accepting_orders, false) then
    update public.menu_items
       set is_available = true
     where vendor_id = p_vendor_id
       and not is_available;
  end if;

  return v_vendor;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE ADMIN CONTROL
-- ---------------------------------------------------------------------------

create or replace function public.admin_update_config(
  p_reason text,
  p_service_fee_bps integer default null,
  p_delivery_fee_pesewas bigint default null,
  p_partner_share_of_delivery_bps integer default null,
  p_vendor_response_seconds integer default null,
  p_partner_search_seconds integer default null,
  p_customer_absent_wait_seconds integer default null,
  p_payment_pending_timeout_seconds integer default null,
  p_min_payout_pesewas bigint default null,
  p_notification_retry_limit integer default null,
  p_vendor_poll_seconds integer default null,
  p_partner_poll_seconds integer default null,
  p_customer_poll_seconds integer default null,
  p_scan_service_fee_pesewas bigint default null,
  p_max_active_deliveries_per_partner smallint default null,
  p_partner_min_payout_pesewas bigint default null,
  p_partner_delivery_enabled boolean default null,
  p_scan_pack_fee_pesewas bigint default null
)
returns public.pricing_config
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Checked HERE as well as by the column constraint, so an operator who types
  -- 40 reads a sentence about Partners rather than a constraint name.
  if p_max_active_deliveries_per_partner is not null
     and (p_max_active_deliveries_per_partner < 1 or p_max_active_deliveries_per_partner > 10) then
    raise exception 'a Partner may carry between 1 and 10 deliveries at once'
      using errcode = 'check_violation';
  end if;

  if p_partner_min_payout_pesewas is not null and p_partner_min_payout_pesewas < 0 then
    raise exception 'the Partner payout threshold cannot be negative'
      using errcode = 'check_violation';
  end if;

  if p_scan_pack_fee_pesewas is not null and p_scan_pack_fee_pesewas < 0 then
    raise exception 'the pack fee cannot be negative' using errcode = 'check_violation';
  end if;

  select * into v_before from public.pricing_config where id;

  -- NULL MEANS "LEAVE ALONE". An operator changing one fee must not silently
  -- reset a timeout they never looked at.
  update public.pricing_config
     set service_fee_bps                   = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas              = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps     = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds           = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds            = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds      = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds   = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas                = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit          = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds               = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds              = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds             = coalesce(p_customer_poll_seconds, customer_poll_seconds),
         scan_service_fee_pesewas          = coalesce(p_scan_service_fee_pesewas, scan_service_fee_pesewas),
         max_active_deliveries_per_partner = coalesce(p_max_active_deliveries_per_partner, max_active_deliveries_per_partner),
         partner_min_payout_pesewas        = coalesce(p_partner_min_payout_pesewas, partner_min_payout_pesewas),
         partner_delivery_enabled          = coalesce(p_partner_delivery_enabled, partner_delivery_enabled),
         scan_pack_fee_pesewas             = coalesce(p_scan_pack_fee_pesewas, scan_pack_fee_pesewas),
         updated_at = now()
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------------

revoke execute on function public.price_scan_order(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.quote_scan_order(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.my_scan_order(uuid) from public, anon, authenticated;
revoke execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer, bigint,
  integer, integer, integer, integer, bigint, smallint, bigint, boolean, bigint
) from public, anon, authenticated;

grant execute on function public.quote_scan_order(uuid, uuid) to authenticated;
grant execute on function public.my_scan_order(uuid)          to authenticated;
grant execute on function public.submit_scan_order(uuid, uuid, text, text, bigint, text, text)
  to authenticated;
grant execute on function public.vendor_set_accepting_orders(uuid, boolean) to authenticated;
grant execute on function public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer, bigint,
  integer, integer, integer, integer, bigint, smallint, bigint, boolean, bigint
) to authenticated;

-- The previous signature would otherwise linger as a second, callable overload
-- with no idea the two new switches exist.
drop function if exists public.admin_update_config(
  text, integer, bigint, integer, integer, integer, integer, integer, bigint,
  integer, integer, integer, integer, bigint, smallint, bigint
);
