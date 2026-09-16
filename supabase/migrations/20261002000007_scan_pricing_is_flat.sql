-- ---------------------------------------------------------------------------
-- A MEAL SCAN COSTS A FLAT FEE, AND THE PACK IS A CHOICE ON A COLLECTION
-- ---------------------------------------------------------------------------
-- Two corrections to scan pricing, and the first one is the important one.
--
-- 1. THE SERVICE FEE IS FLAT, ALWAYS.
--
--    A Partner-carried scan order was charging `service_fee_bps` — the same
--    6.95% a food order pays — computed on the value of the items the scan
--    covered. That was wrong, and wrong in a way worth spelling out: the
--    "scanned value" is the STORE'S menu price for food Campus Dash did not
--    sell, settled between the student and the university. Taking a percentage
--    of it charges a commission on somebody else's transaction, and it makes
--    the fee move with a number the customer is not paying.
--
--    It is GH2.00 per scan order, whatever is in it and however it is
--    collected. The errand is the same work whether the meal is worth GH10 or
--    GH40, and `scan_service_fee_pesewas` has held that figure all along.
--
--    A FOOD ORDER IS UNTOUCHED. price_order() still charges service_fee_bps of
--    a real subtotal, because there a real subtotal exists and Campus Dash
--    genuinely sold it. The two pricing systems do not meet.
--
-- 2. THE PACK IS OPTIONAL ON A COLLECTION, AND COMPULSORY WITH A PARTNER.
--
--    Somebody walking to a counter can bring their own container, and charging
--    them GH4 for one they refused is charging for nothing. Somebody having
--    an order carried across campus cannot: a Partner needs something to carry,
--    so the pack comes with the choice rather than beside it.
--
--    `p_wants_pack` is therefore a REQUEST, not an instruction. A Partner order
--    ignores it and charges the pack regardless — the screen never offers the
--    choice, and a request that skipped the screen is refused here rather than
--    honoured.
--
--   Scan + collection, no pack     GH2.00
--   Scan + collection, with pack   GH6.00
--   Scan + Campus Dash Partner     GH11.00   (2 + 4 pack + 5 Partner)
-- ---------------------------------------------------------------------------

drop function if exists public.quote_scan_order(uuid, jsonb, public.fulfilment_type, uuid);
drop function if exists public.price_scan_order(uuid, jsonb, public.fulfilment_type, uuid);

create or replace function public.price_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_wants_pack boolean default false
)
returns table(
  scanned_value_pesewas bigint,
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  partner_earnings_pesewas bigint,
  total_pesewas bigint,
  destination_zone_id uuid,
  lines jsonb
)
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_scanned  bigint := 0;
  v_service  bigint;
  v_delivery bigint := 0;
  v_pack     bigint := 0;
  v_earnings bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id
       and status = 'ACTIVE'
       and is_accepting_orders
       and can_accept_scans
  ) then
    raise exception 'this store is not accepting meal scans right now'
      using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'choose at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- The refusal that keeps an unpriced product off the shelf: null is
  -- "undecided", and guessing here would be inventing revenue policy in a
  -- pricing function.
  if v_cfg.scan_service_fee_pesewas is null then
    raise exception
      'meal scans are not configured yet: an administrator must set the scan service fee'
      using errcode = 'check_violation';
  end if;

  -- SCAN ELIGIBILITY IS CHECKED HERE, per item, against the live menu. A screen
  -- that only offered eligible items is a convenience; this is the enforcement.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available
       and scan_eligible;

    if not found then
      raise exception 'that item cannot be paid for with a meal scan'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_menu.price_pesewas,
      'quantity',           v_qty,
      'line_total_pesewas', v_menu.price_pesewas * v_qty
    );

    v_scanned := v_scanned + (v_menu.price_pesewas * v_qty);
  end loop;

  -- FLAT, ALWAYS, AND NEVER A SHARE OF THE SCANNED VALUE. The scanned value is
  -- the store's price for food Campus Dash did not sell; a percentage of it
  -- would be a commission on somebody else's transaction.
  v_service := v_cfg.scan_service_fee_pesewas;

  if p_fulfilment_type = 'DELIVERY' then
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'no Partners are available right now'
        using errcode = 'check_violation';
    end if;

    if p_destination_location_id is null then
      raise exception 'choose where the Partner should bring it'
        using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'that is not a place a Partner can bring an order to'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Same carve as a food order. The Partner is paid for the errand, and the
    -- errand is identical work whether the food was bought or scanned.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;

    -- THE PACK COMES WITH THE PARTNER, and p_wants_pack is not consulted. A
    -- Partner cannot carry a meal without something to carry it in, so the
    -- screen never offers the choice — and a request that reached here without
    -- passing the screen is overridden rather than honoured.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  elsif coalesce(p_wants_pack, false) then
    -- A COLLECTION MAY BRING ITS OWN CONTAINER. Charging GH4 for a pack
    -- somebody refused is charging for nothing.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  end if;

  return query select
    v_scanned,
    -- WHAT CAMPUS DASH SOLD, which is no food at all. This is the number the
    -- ledger divides on, and it must stay zero or a store would appear to be
    -- owed money for a meal the university already paid for.
    0::bigint,
    v_service,
    v_delivery,
    v_pack,
    v_earnings,
    v_service + v_delivery + v_pack,
    case when p_fulfilment_type = 'DELIVERY'
         then public.location_zone(p_destination_location_id) end,
    v_lines;
end;
$$;

comment on function public.price_scan_order(uuid, jsonb, public.fulfilment_type, uuid, boolean) is
  'Prices a meal-scan order. The food is GH0 through Campus Dash — the scan pays the store — and the service fee is FLAT (scan_service_fee_pesewas), never a share of the scanned value: that value is the store''s price for food we did not sell. The pack is the customer''s choice on a collection and compulsory with a Partner, who cannot carry a meal without one.';

create or replace function public.quote_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type default 'PICKUP',
  p_destination_location_id uuid default null,
  p_wants_pack boolean default false
)
returns table(
  scanned_value_pesewas bigint,
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  total_pesewas bigint,
  partner_available boolean,
  pack_is_compulsory boolean,
  lines jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select p.scanned_value_pesewas, p.subtotal_pesewas, p.service_fee_pesewas,
         p.delivery_fee_pesewas, p.pack_fee_pesewas, p.total_pesewas,
         coalesce(c.partner_delivery_enabled, true),
         -- SO THE SCREEN DOES NOT HAVE TO KNOW THE RULE. A checkout that
         -- decided for itself when to hide the pack toggle would be a second
         -- copy of this policy, and the two would drift.
         (p_fulfilment_type = 'DELIVERY'),
         p.lines
    from public.price_scan_order(
           p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id, p_wants_pack) p
    cross join public.pricing_config c
   where c.id;
$$;

-- ---------------------------------------------------------------------------
-- SUBMISSION CARRIES THE CHOICE
-- ---------------------------------------------------------------------------

drop function if exists public.submit_scan_order(
  uuid, jsonb, public.fulfilment_type, text, text, bigint, uuid, text, text);

create or replace function public.submit_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_scan_image_path text,
  p_content_type text,
  p_byte_size bigint,
  p_destination_location_id uuid default null,
  p_details text default null,
  p_destination_note text default null,
  p_wants_pack boolean default false
)
returns table(order_id uuid, order_number text, vendor_order_no integer, total_pesewas bigint)
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
  v_day      date := (now() at time zone 'UTC')::date;
  v_no       integer;
  v_line     jsonb;
  v_cfg      public.pricing_config%rowtype;
begin
  if v_customer is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- ORDERING IS A CAPABILITY. Browsing needs no account; this needs completed
  -- student onboarding, exactly like a food order.
  if not public.is_customer(v_customer) then
    raise exception 'complete your student details before ordering'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_scan_image_path, '')), '') is null then
    raise exception 'attach your meal scan' using errcode = 'check_violation';
  end if;

  -- THE DETAILS FIELD IS OPTIONAL NOW, and that is a consequence of the items
  -- being real. It used to be the only way anybody knew what to hand over, so
  -- it had to be compulsory; the order itself says that now, and what is left
  -- is genuinely optional context — "no pepper", "the back counter".
  if v_details is not null and length(v_details) > 1000 then
    raise exception 'keep the details under 1000 characters' using errcode = 'check_violation';
  end if;

  -- THE PATH MUST BE THE CALLER'S OWN. Uploads land under <user_id>/scans/…,
  -- so anything else is either a mistake or an attempt to attach a scan the
  -- caller does not own. Checked here as well as at upload, because this
  -- function is the one that grants a later right to read it.
  v_prefix := v_customer::text || '/scans/';
  if left(p_scan_image_path, length(v_prefix)) <> v_prefix then
    raise exception 'that scan does not belong to this account'
      using errcode = 'insufficient_privilege';
  end if;

  -- Prices come from the server, always. Nothing the client sent is trusted:
  -- the pack choice is a REQUEST that price_scan_order() may override, and
  -- every figure below is read back off its answer rather than off the request.
  select * into v_price
    from public.price_scan_order(
      p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id, p_wants_pack);

  select * into v_cfg from public.pricing_config where id;

  -- A QUEUE NUMBER, like every other order. The store calls this out; nobody is
  -- ever asked to read a CD- reference down a counter.
  v_no := public.next_vendor_order_no(p_vendor_id, v_day);

  insert into public.orders (
    customer_id, vendor_id, order_type, fulfilment_type,
    order_status, payment_status, delivery_status, scan_status,
    vendor_order_no, order_day,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, pack_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    submitted_at, accepted_at, accept_deadline_at
  )
  values (
    v_customer, p_vendor_id, 'SCAN', p_fulfilment_type,
    -- ACCEPTED means "priced and payable", exactly as it does for food. No
    -- store sees it until the money lands.
    'ACCEPTED', 'UNPAID', 'NONE', 'UPLOADED',
    v_no, v_day,
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    0, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas, v_price.pack_fee_pesewas,
    v_price.partner_earnings_pesewas, v_price.total_pesewas,
    -- accept_deadline_at is the PAY-BY deadline, exactly as it is on a food
    -- order, so a scan nobody pays for is swept by expire_stale_orders()
    -- rather than sitting in somebody's list for ever holding a queue number.
    now(), now(), now() + make_interval(secs => v_cfg.payment_pending_timeout_seconds)
  )
  returning * into v_order;

  -- THE ITEMS. Priced at the menu price so the counter can see what was asked
  -- for and what it is normally worth; the customer is charged none of it,
  -- which is why orders.subtotal_pesewas above is zero and not this sum.
  for v_line in select * from jsonb_array_elements(v_price.lines) loop
    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    ) values (
      v_order.id,
      (v_line ->> 'menu_item_id')::uuid,
      v_line ->> 'name',
      (v_line ->> 'unit_price_pesewas')::bigint,
      (v_line ->> 'quantity')::integer,
      (v_line ->> 'line_total_pesewas')::bigint
    );
  end loop;

  insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size, details)
  values (v_order.id, v_customer, p_scan_image_path, p_content_type, p_byte_size, v_details);

  -- Same secrets row a food order gets: vendor_mark_ready() mints the collection
  -- code into it, and partner_accept_delivery() fills in the delivery code.
  insert into public.order_secrets (order_id) values (v_order.id);

  perform public.log_order_event(
    v_order.id, 'SCAN_ORDER_SUBMITTED', true, 'CUSTOMER',
    'order_status', null, 'ACCEPTED', null,
    jsonb_build_object('vendor_id', p_vendor_id,
                       'scan_status', 'UPLOADED',
                       'fulfilment_type', p_fulfilment_type::text,
                       'scanned_value_pesewas', v_price.scanned_value_pesewas,
                       'pack_fee_pesewas', v_price.pack_fee_pesewas,
                       'vendor_order_no', v_no)
  );

  return query select v_order.id, v_order.order_number, v_order.vendor_order_no, v_order.total_pesewas;
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------

revoke all on function
  public.price_scan_order(uuid, jsonb, public.fulfilment_type, uuid, boolean)
  from public, anon, authenticated;

revoke all on function
  public.quote_scan_order(uuid, jsonb, public.fulfilment_type, uuid, boolean)
  from public, anon;
grant execute on function
  public.quote_scan_order(uuid, jsonb, public.fulfilment_type, uuid, boolean)
  to authenticated;

revoke all on function
  public.submit_scan_order(
    uuid, jsonb, public.fulfilment_type, text, text, bigint, uuid, text, text, boolean)
  from public, anon;
grant execute on function
  public.submit_scan_order(
    uuid, jsonb, public.fulfilment_type, text, text, bigint, uuid, text, text, boolean)
  to authenticated;
