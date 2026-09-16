-- ---------------------------------------------------------------------------
-- A SCAN IS A STORE ORDER, NOT AN ERRAND THAT BYPASSES THE STORE.
-- ---------------------------------------------------------------------------
-- The previous model treated a meal scan as something Campus Dash sold on its
-- own: an errand with no items, no queue number and no store involvement, whose
-- redemption was a Partner's unverified report. That was wrong about the one
-- fact everything else follows from — THE STORE IS THE REDEMPTION POINT. A
-- restaurant that is going to hand food to somebody has to know the order
-- exists, know what was asked for, and be the party that checks the scan is
-- good before anything leaves the counter.
--
-- So a scan order becomes an ordinary order on the store's board that happens
-- to be paid for differently:
--
--   * it carries REAL menu items and quantities, chosen from the eligible ones;
--   * it takes a DAILY QUEUE NUMBER like every other order (001, 002, 003) —
--     the CD- reference stays underneath as the internal key, exactly as it
--     does for a food order;
--   * it is PICKUP or CAMPUS DASH PARTNER, chosen at the checkout;
--   * the VENDOR verifies and redeems the scan, then presses Ready, then reads
--     out the same four digits every other order uses.
--
-- WHAT DOES NOT CHANGE, and deliberately:
--
--   * Campus Dash still sells no food on a scan order. `subtotal_pesewas`
--     stays 0, `create_order_allocations()` still writes NO vendor allocation,
--     and the store is still paid through the university's scan system rather
--     than by us. The menu items are there so the counter knows what to hand
--     over, not so anybody is billed for them.
--   * The customer's destination, note and phone number are still never shown
--     to a store. A scan order is MORE exposed to the vendor than it was, and
--     this migration is careful that the extra exposure is the scan and the
--     items and nothing else.
--   * The handoff invariant. The store holds the code; whoever takes the food
--     types it in.
--
-- Supersedes the vendor-invisibility rules in 20260919000001_scan_delivery.sql.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. ELIGIBILITY IS PER ITEM, NOT ONLY PER STORE
-- ---------------------------------------------------------------------------
-- A store may honour scans for its rice and not for its imported drinks. The
-- store-level switch stays and is checked FIRST — an item cannot be eligible at
-- a restaurant that does not take scans at all — so the two compose as
-- "the store opted in, and then chose which items".

alter table public.menu_items
  add column if not exists scan_eligible boolean not null default false;

comment on column public.menu_items.scan_eligible is
  'Whether this item may be paid for with a campus meal scan. Meaningless unless vendors.can_accept_scans is also true: the store opts in, then chooses which items. Default false, because being wrong about this sends somebody to a counter expecting to be served without paying.';

-- The storefront needs it to render the scan filter, and price_scan_order()
-- needs it to refuse an ineligible item.
create index if not exists menu_items_scan_eligible_idx
  on public.menu_items (vendor_id)
  where scan_eligible and is_available;

-- ---------------------------------------------------------------------------
-- 1b. A SCAN ORDER MAY BE COLLECTED
-- ---------------------------------------------------------------------------
-- `orders_scan_is_delivery` encoded the old model's central assumption: Campus
-- Dash sold the errand, so an errand nobody ran was not a product. Now that the
-- store is the redemption point, a student walking to the counter with their
-- own scan is the SIMPLEST version of the thing — no Partner, no Partner fee.
-- The constraint has to go, and nothing replaces it: PICKUP and DELIVERY are
-- both legal on both order types, which is one fewer special case.

alter table public.orders drop constraint if exists orders_scan_is_delivery;

-- ---------------------------------------------------------------------------
-- 2. WHAT A SCAN ORDER COSTS
-- ---------------------------------------------------------------------------
-- Every figure comes from pricing_config. Nothing here hard-codes an amount,
-- which is the point: the pilot retunes at /admin/pilot without a deploy.
--
--                        PICKUP                     CAMPUS DASH PARTNER
--   Food via Campus Dash  GH0.00                     GH0.00
--   Service fee           scan_service_fee_pesewas   service_fee_bps of the
--                                                    scanned food value
--   Pack fee              scan_pack_fee_pesewas      scan_pack_fee_pesewas
--   Partner               —                          delivery_fee_pesewas
--
-- THE TWO SERVICE FEES ARE DIFFERENT ON PURPOSE. A collection is a flat, small
-- charge for putting the order on the store's board. An order somebody carries
-- across campus is the product, and it is priced like the product — the same
-- percentage a food order pays.

drop function if exists public.quote_scan_order(uuid, uuid);
drop function if exists public.price_scan_order(uuid, uuid);

create or replace function public.price_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null
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
  v_pack     bigint;
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

  -- COMPULSORY, AND NOT THE CUSTOMER'S TO REMOVE. Campus Dash buys the
  -- containers a redeemed meal is carried in, on a collection as much as on a
  -- Partner order — somebody walking food back to their block needs a box just
  -- as much as somebody having it brought.
  v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);

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
    -- The product rate, on the value the scan covered. Rounded half-up in whole
    -- pesewas, exactly as price_order() does it.
    v_service  := ((v_scanned * v_cfg.service_fee_bps) + 5000) / 10000;
  else
    -- A collection asks nothing of a Partner, so it is the flat scan fee.
    v_service := v_cfg.scan_service_fee_pesewas;
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

comment on function public.price_scan_order(uuid, jsonb, public.fulfilment_type, uuid) is
  'Prices a meal-scan order. The food is GH0 through Campus Dash — the scan pays the store — so only the service fee, the compulsory pack fee and, for a Partner order, the Partner fee are charged. Every figure is read from pricing_config.';

create or replace function public.quote_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type default 'PICKUP',
  p_destination_location_id uuid default null
)
returns table(
  scanned_value_pesewas bigint,
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  total_pesewas bigint,
  partner_available boolean,
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
         p.lines
    from public.price_scan_order(p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id) p
    cross join public.pricing_config c
   where c.id;
$$;

-- ---------------------------------------------------------------------------
-- 3. SUBMITTING ONE
-- ---------------------------------------------------------------------------
-- Mirrors submit_order_for() far more closely than the old errand did, which is
-- the whole intent: the differences that remain are the ones that are real.

drop function if exists public.submit_scan_order(uuid, uuid, text, text, bigint, text, text);

create or replace function public.submit_scan_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_scan_image_path text,
  p_content_type text,
  p_byte_size bigint,
  p_destination_location_id uuid default null,
  p_details text default null,
  p_destination_note text default null
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

  -- Prices come from the server, always. Nothing the client sent is trusted,
  -- and this is also where per-item scan eligibility is enforced.
  select * into v_price
    from public.price_scan_order(
      p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id);

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
-- 4. PAYMENT NO LONGER SKIPS THE STORE
-- ---------------------------------------------------------------------------
-- The old branch existed because "a scan errand has no kitchen". It has one
-- now: somebody behind a counter has to check the scan and put the food in a
-- box. So the special case goes away entirely and a scan order is confirmed by
-- exactly the same statement a food order is — which is the smallest correct
-- change, and one fewer path that can drift.

create or replace function public.confirm_payment(
  p_payment_id uuid,
  p_provider_transaction_id text,
  p_amount_pesewas bigint
)
returns public.payments
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_payment public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_search  integer;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  -- Replayed confirmation: already succeeded, nothing more to do.
  if v_payment.status = 'SUCCEEDED' then
    return v_payment;
  end if;

  -- The provider must have collected exactly what we asked for. A mismatch is a
  -- reconciliation incident, not something to paper over.
  if p_amount_pesewas is distinct from v_payment.amount_pesewas then
    raise exception 'amount mismatch: provider reported % but payment is %',
      p_amount_pesewas, v_payment.amount_pesewas using errcode = 'check_violation';
  end if;

  update public.payments
     set status = 'SUCCEEDED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         succeeded_at = now()
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  update public.orders
     set payment_status = 'PAID'
   where id = v_payment.order_id and payment_status = 'PENDING'
  returning * into v_order;

  if not found then
    raise exception 'order payment status was not PENDING' using errcode = 'check_violation';
  end if;

  perform public.create_order_allocations(v_payment.order_id);

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_CONFIRMED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'PAID', null,
    jsonb_build_object('payment_id', p_payment_id, 'provider_transaction_id', p_provider_transaction_id));

  select partner_search_seconds into v_search from public.pricing_config where id;

  -- ONE PATH FOR BOTH ORDER TYPES. A paid order reaches the store the moment
  -- it is paid for — there is no accept and no separate "start preparing". For
  -- a scan the store's work is verifying the scan and packing it rather than
  -- cooking, but it is work on a board either way.
  --
  -- DISPATCH OPENS HERE for a Partner order. A Partner found while the order is
  -- being put together is a Partner who is not standing at a counter waiting,
  -- and the offer carries food_is_ready so nobody sets off too early.
  --
  -- Guarded on the current state, so a replayed confirmation cannot restart a
  -- search that has already found somebody.
  update public.orders o
     set order_status   = 'PREPARING',
         preparing_at   = now(),
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case when o.fulfilment_type = 'DELIVERY' then now() end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY'
           then now() + make_interval(secs => v_search) end
   where o.id = v_payment.order_id
     and o.order_status = 'ACCEPTED'
  returning * into v_order;

  if found then
    perform public.log_order_event(v_payment.order_id, 'VENDOR_PREPARING', true, 'SYSTEM',
      'order_status', 'ACCEPTED', 'PREPARING', 'payment confirmed');

    if v_order.fulfilment_type = 'DELIVERY' then
      perform public.log_order_event(v_payment.order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
        'delivery_status', 'NONE', 'SEARCHING');
    end if;
  end if;

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. THE STORE CAN SEE IT
-- ---------------------------------------------------------------------------
-- The `order_type = 'FOOD'` filters come off. What replaces them is narrower
-- and better: a scan order is on the board, and the destination is withheld
-- from the store for a scan and a food delivery alike, because the store is
-- never the party that goes anywhere.

drop function if exists public.vendor_order_board(uuid, integer);

create or replace function public.vendor_order_board(
  p_vendor_id uuid,
  p_closed_limit integer default 20
)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  bucket text,
  order_type public.order_type,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  scan_status public.scan_status,
  item_count bigint,
  vendor_amount_pesewas bigint,
  scan_value_pesewas bigint,
  submitted_at timestamp with time zone,
  age_seconds integer,
  partner_assigned boolean,
  partner_waiting boolean,
  awaiting_collection boolean,
  cancellation_reason text
)
language sql
stable
security definer
set search_path to ''
as $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       and o.order_status <> 'DRAFT'
       -- PAID ONLY. A store is never shown an order somebody has not paid for.
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
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
         r.vendor_order_no,
         r.bucket,
         r.order_type,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         r.scan_status,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         -- THE VENDOR'S AMOUNT FROM CAMPUS DASH. Never the total, never a fee —
         -- and zero on a scan, because we did not sell their food.
         r.subtotal_pesewas,
         -- WHAT THE SCAN IS WORTH AT THEIR OWN PRICES, so a counter can sanity
         -- check what it is handing over. It is not money Campus Dash owes.
         case when r.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = r.id)
              else 0::bigint end,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         r.partner_id is not null,
         (r.delivery_status = 'ASSIGNED' and r.order_status = 'READY'),
         (r.order_status = 'READY' and r.delivery_status = 'NONE'),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;

comment on function public.vendor_order_board(uuid, integer) is
  'The store board: every PAID order, food and meal scan alike. The destination, the customer''s phone number and the customer''s total are deliberately absent — a store never travels anywhere and is never told what Campus Dash charged.';

create or replace function public.vendor_pending_count(p_vendor_id uuid)
returns integer
language sql
stable
security definer
set search_path to ''
as $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.payment_status = 'PAID'
     and o.order_status in ('ACCEPTED', 'PREPARING')
     and public.is_vendor_staff(p_vendor_id);
$$;

-- One order, for the store. Gains the scan facts and LOSES the destination
-- zone: a store has no use for it, on any order type.
drop function if exists public.vendor_order_detail(uuid);

create or replace function public.vendor_order_detail(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_id uuid,
  bucket text,
  order_type public.order_type,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  scan_status public.scan_status,
  scan_details text,
  scan_value_pesewas bigint,
  vendor_amount_pesewas bigint,
  submitted_at timestamp with time zone,
  age_seconds integer,
  accepted_at timestamp with time zone,
  preparing_at timestamp with time zone,
  ready_at timestamp with time zone,
  completed_at timestamp with time zone,
  partner_assigned boolean,
  partner_name text,
  handoff_code_available boolean,
  customer_first_name text,
  cancellation_reason text,
  items jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.vendor_id,
         public.vendor_order_bucket(o.order_status),
         o.order_type,
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.scan_status,
         -- The customer's optional note about the order. It is about the FOOD —
         -- "no pepper", "the far counter" — which is the store's business. The
         -- destination note is a different column and is not selected.
         case when o.order_type = 'SCAN' then s.details end,
         case when o.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = o.id)
              else 0::bigint end,
         -- THE VENDOR'S AMOUNT. The service fee, the Partner fee, the pack fee
         -- and the customer's total are not selected.
         o.subtotal_pesewas,
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         o.partner_id is not null,
         public.given_name(p.first_name, p.full_name),
         -- Whether there is a code to read out right now: somebody is at the
         -- counter, or a collection whose order is made.
         (o.payment_status = 'PAID' and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
         -- First name only, and only when nobody is bringing it — that is, only
         -- when this person is the one who will walk up to the counter.
         case when o.delivery_status = 'NONE'
              then public.given_name(c.first_name, c.full_name) end,
         o.cancellation_reason,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'name', oi.name_snapshot,
                       'quantity', oi.quantity,
                       'unit_price_pesewas', oi.unit_price_pesewas,
                       'line_total_pesewas', oi.line_total_pesewas
                     ) order by oi.created_at
                   )
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb
         )
    from public.orders o
    left join public.users p on p.id = o.partner_id
    left join public.users c on c.id = o.customer_id
    left join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

-- ---------------------------------------------------------------------------
-- 6. THE STORE VERIFIES THE SCAN
-- ---------------------------------------------------------------------------
-- The Partner used to report their own redemption, which recorded an account of
-- something nobody had checked. The restaurant is the only party that can
-- actually judge whether a scan is honoured, so the act moves to them.

-- THE PREDICATE IS A FUNCTION, not a subquery, and that is not a style choice.
-- Since vendors read orders only through RPCs they hold no SELECT grant on
-- public.orders at all, so an `exists (select 1 from public.orders …)` inside a
-- policy evaluates against a table the vendor cannot see and is always false.
-- A SECURITY DEFINER helper asks the question on its own authority instead.
create or replace function public.vendor_may_read_scan(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and o.order_type = 'SCAN'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
       and public.is_vendor_staff(o.vendor_id)
  );
$$;

comment on function public.vendor_may_read_scan(uuid) is
  'Whether the caller staffs the store this scan order belongs to AND the order is still live on its board. The one predicate behind both the order_scans policy and vendor_scan_image_path(), so the row and the image can never disagree about who may look.';

-- The scan image, for the store that is about to honour it — and only while
-- the order is live on their board. The window closes at completion for the
-- same reason the Partner's does: an authorisation that outlives the thing it
-- was granted for is not an authorisation, it is a copy.
create or replace function public.vendor_scan_image_path(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and public.vendor_may_read_scan(p_order_id);
$$;

comment on function public.vendor_scan_image_path(uuid) is
  'The scan image, for the store that is about to redeem it. Live orders only: the right opens when the order is paid and closes when it leaves the board, exactly as the assigned Partner''s does.';

-- The store says the scan is good. This is the moment the university's
-- entitlement is consumed, and it is separate from the handoff on purpose:
-- verifying a scan and giving somebody their lunch are different claims, and
-- collapsing them would lose the one that matters when a scan turns out to be
-- dead.
create or replace function public.vendor_redeem_scan(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- AUTHORISATION failures raise; state failures return. Hard rule 9.
  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  update public.orders o
     set scan_status = 'REDEEMED'
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.payment_status = 'PAID'
     -- UPLOADED or RELEASED: a Partner may or may not have been assigned by
     -- now, and the store does not wait on dispatch to check a scan.
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING');

  if not found then
    perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', false, 'VENDOR',
      'scan_status', v_order.scan_status::text, 'REDEEMED',
      'scan was already settled, or the order is not a paid order being prepared');
    return row(false, 'this scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set redeemed_at = now(), redeemed_by = auth.uid()
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REDEEMED', 'verified at the counter');

  return row(true, null)::public.transition_result;
end;
$$;

-- The store says the scan is not good. NO MONEY MOVES — what the customer paid
-- is a Campus Dash fee and refunding it is a decision nobody has made, exactly
-- as it was before. The order is stopped and an administrator picks it up.
create or replace function public.vendor_refuse_scan(p_order_id uuid, p_reason text)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order  public.orders%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    return row(false, 'say why the scan could not be honoured')::public.transition_result;
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  update public.orders o
     set scan_status = 'REFUSED'
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING');

  if not found then
    return row(false, 'this scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set refused_at = now(), refusal_reason = v_reason
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REFUSED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REFUSED', v_reason);

  return row(true, null)::public.transition_result;
end;
$$;

-- READY, for a scan order, requires the scan to have been dealt with first.
-- Pressing Ready is what mints the four digits somebody will be asked for, and
-- minting them before anybody has looked at the scan would put food on a
-- counter for an entitlement that might not exist.
create or replace function public.vendor_mark_ready(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
  v_type  public.order_type;
  v_scan  public.scan_status;
  v_cfg   public.pricing_config%rowtype;
begin
  select order_status, order_type, scan_status into v_prev, v_type, v_scan
    from public.orders where id = p_order_id;
  select * into v_cfg from public.pricing_config where id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_type = 'SCAN' and v_scan is distinct from 'REDEEMED' then
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'the meal scan has not been verified yet');
    return row(false, 'check the meal scan first, then mark it ready')::public.transition_result;
  end if;

  update public.orders o
     set order_status = 'READY',
         ready_at = now(),
         -- Belt only. Dispatch opened at payment; this catches an order that
         -- somehow reached READY with its search never started.
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() else o.search_started_at end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() + make_interval(secs => v_cfg.partner_search_seconds)
           else o.search_deadline_at end
   where o.id = p_order_id
     and o.order_status = 'PREPARING'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    select order_status into v_prev from public.orders where id = p_order_id;
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'order was not a paid order being prepared');
    return row(false, format('order cannot be marked ready from state %s', v_prev))::public.transition_result;
  end if;

  -- THE COLLECTION CODE IS MINTED HERE, and only for a collection. It is the
  -- store's to read out; the customer types it in. Minting it at the moment the
  -- order is ready means a code never exists for food that is not.
  if v_order.delivery_status = 'NONE' then
    update public.order_secrets
       set pickup_code = public.generate_numeric_code(4),
           pickup_code_version = pickup_code_version + 1,
           pickup_code_set_at = now(),
           pickup_attempts = 0,
           pickup_locked_until = null
     where order_secrets.order_id = p_order_id;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_READY', true, 'VENDOR',
    'order_status', 'PREPARING', 'READY');

  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. THE PARTNER COLLECTS A SCAN ORDER LIKE ANY OTHER
-- ---------------------------------------------------------------------------
-- partner_confirm_pickup() used to RAISE for a scan, because the scan had its
-- own private road to PICKED_UP. It does not any more: the store hands food
-- across a counter and the person taking it types in four digits, and that is
-- the same act whoever paid for the meal.

create or replace function public.partner_confirm_pickup(p_order_id uuid, p_pickup_code text)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_partner  uuid := auth.uid();
  v_assigned uuid;
  v_state    public.delivery_status;
  v_order_state public.order_status;
  v_check    text;
  v_order    public.orders%rowtype;
begin
  select o.partner_id, o.delivery_status, o.order_status
    into v_assigned, v_state, v_order_state
    from public.orders o
   where o.id = p_order_id;

  -- AUTHORISATION failure: raise. Covers the wrong Partner, an order with no
  -- Partner attached, and an order id that does not exist — all three get the
  -- same message, so probing tells the caller nothing. It comes FIRST, so an
  -- unauthorised caller never reaches the attempt counter and cannot lock a
  -- delivery out from under the Partner actually carrying it.
  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'this delivery is not assigned to you' using errcode = 'insufficient_privilege';
  end if;

  -- STATE before CODE. The order is not made yet, so there is nothing to
  -- collect and no attempt to spend finding that out. For a scan order READY
  -- additionally means the store has verified the scan — vendor_mark_ready()
  -- will not move it otherwise.
  if v_order_state is distinct from 'READY' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'order is not ready yet');
    return row(false, 'this is not ready yet. Wait for the store to mark it ready')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask the store to read it out again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code did not match');
    return row(false, 'that pickup code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'PICKED_UP', picked_up_at = now()
   where o.id = p_order_id
     and o.delivery_status = 'ASSIGNED'
     and o.order_status = 'READY'
     and o.partner_id = v_partner
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'delivery was not ASSIGNED');
    return row(false, 'this order is not awaiting pickup')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', true, 'PARTNER',
    'delivery_status', 'ASSIGNED', 'PICKED_UP');
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. WHAT THE CUSTOMER AND THE PARTNER SEE
-- ---------------------------------------------------------------------------

-- The Partner no longer reports a redemption, so the brief drops the instruction
-- to go and do that and carries what they actually need: the store, the items
-- and the customer's optional note.
drop function if exists public.partner_scan_brief(uuid);

create or replace function public.partner_scan_brief(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  restaurant_name text,
  details text,
  scan_status public.scan_status,
  items jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id, o.order_number, o.vendor_order_no, v.name, s.details, o.scan_status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot, 'quantity', oi.quantity) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.order_scans s
    join public.orders o on o.id = s.order_id
    join public.vendors v on v.id = o.vendor_id
   where s.order_id = p_order_id
     and s.released_to = auth.uid()
     and o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;

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
  pack_fee_pesewas bigint,
  scanned_value_pesewas bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id, o.scan_status, s.details, s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason,
         coalesce(o.pack_fee_pesewas, 0),
         (select coalesce(sum(oi.line_total_pesewas), 0)
            from public.order_items oi where oi.order_id = o.id)
    from public.orders o
    join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and (o.customer_id = auth.uid() or public.is_admin());
$$;

-- The eligible menu, for the screen that builds a scan order. Public, like the
-- rest of the catalogue: what a store will honour a scan for is not a secret,
-- and hiding it would only mean somebody finding out at the counter.
create or replace function public.scan_menu(p_vendor_id uuid)
returns table(
  id uuid,
  name text,
  description text,
  price_pesewas bigint,
  is_available boolean
)
language sql
stable
security definer
set search_path to ''
as $$
  select m.id, m.name, m.description, m.price_pesewas, m.is_available
    from public.menu_items m
    join public.vendors v on v.id = m.vendor_id
   where m.vendor_id = p_vendor_id
     and m.scan_eligible
     and v.status = 'ACTIVE'
     and v.can_accept_scans
   order by m.sort_order, m.name;
$$;

-- Restaurants that honour scans AND have at least one eligible item. A store
-- with the switch on and nothing marked eligible is a dead end, and listing it
-- sends somebody to an empty menu.
drop function if exists public.scan_restaurants();

create or replace function public.scan_restaurants()
returns table(
  id uuid,
  name text,
  location_path text,
  is_accepting_orders boolean,
  image_path text,
  eligible_item_count bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  select v.id, v.name, public.location_path(v.location_id), v.is_accepting_orders,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.menu_items m
           where m.vendor_id = v.id and m.scan_eligible and m.is_available)
    from public.vendors v
   where v.status = 'ACTIVE'
     and v.can_accept_scans
     and exists (
       select 1 from public.menu_items m
        where m.vendor_id = v.id and m.scan_eligible and m.is_available
     )
   order by v.is_accepting_orders desc, v.name;
$$;

-- ---------------------------------------------------------------------------
-- 9. THE STORE MAY READ THE SCAN ROW IT IS ABOUT TO HONOUR
-- ---------------------------------------------------------------------------
-- The image itself still only ever leaves through a signed URL minted after
-- vendor_scan_image_path() has re-checked the right. This policy is what lets
-- the board show that a scan is attached and what its state is.

drop policy if exists "order_scans_read_authorised" on public.order_scans;

create policy "order_scans_read_authorised" on public.order_scans
  for select to authenticated
  using (
    customer_id = auth.uid()
    or (released_to is not null and released_to = auth.uid())
    or public.is_admin()
    or public.vendor_may_read_scan(order_scans.order_id)
  );

-- ---------------------------------------------------------------------------
-- 10. THE PACK FEE HAS A PRICE
-- ---------------------------------------------------------------------------
-- GH4, compulsory, and its own line at the checkout. It stays in
-- pricing_config rather than in a function, so the pilot can retune it; what
-- it may not be is invisible or optional, and the customer screens print it
-- whenever it is non-zero.

update public.pricing_config set scan_pack_fee_pesewas = 400 where id;

comment on column public.pricing_config.scan_pack_fee_pesewas is
  'What a meal-scan order is charged for disposable packaging, in pesewas. GH4 in the pilot. SCAN ORDERS ONLY — orders_pack_fee_scan_only enforces that — because a food order arrives in the store''s own packaging and is charged nothing for it. Compulsory on the orders it applies to: the customer is shown the line and cannot remove it.';

-- ---------------------------------------------------------------------------
-- 11. GRANTS
-- ---------------------------------------------------------------------------
-- Supabase grants EXECUTE to PUBLIC by default, so every function above is
-- anon-callable until something takes that away. tests/schema.test.js asserts
-- the whole surface, which is what turns forgetting this into a red test.

revoke all on function
  public.price_scan_order(uuid, jsonb, public.fulfilment_type, uuid) from public, anon, authenticated;

revoke all on function
  public.quote_scan_order(uuid, jsonb, public.fulfilment_type, uuid) from public, anon;
grant execute on function
  public.quote_scan_order(uuid, jsonb, public.fulfilment_type, uuid) to authenticated;

revoke all on function
  public.submit_scan_order(uuid, jsonb, public.fulfilment_type, text, text, bigint, uuid, text, text)
  from public, anon;
grant execute on function
  public.submit_scan_order(uuid, jsonb, public.fulfilment_type, text, text, bigint, uuid, text, text)
  to authenticated;

revoke all on function public.vendor_scan_image_path(uuid) from public, anon;
grant execute on function public.vendor_scan_image_path(uuid) to authenticated;

-- Reachable because the RLS policy on order_scans calls it as the caller.
revoke all on function public.vendor_may_read_scan(uuid) from public, anon;
grant execute on function public.vendor_may_read_scan(uuid) to authenticated;

revoke all on function public.vendor_redeem_scan(uuid) from public, anon;
grant execute on function public.vendor_redeem_scan(uuid) to authenticated;

revoke all on function public.vendor_refuse_scan(uuid, text) from public, anon;
grant execute on function public.vendor_refuse_scan(uuid, text) to authenticated;

revoke all on function public.vendor_order_board(uuid, integer) from public, anon;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated;

revoke all on function public.vendor_order_detail(uuid) from public, anon;
grant execute on function public.vendor_order_detail(uuid) to authenticated;

revoke all on function public.vendor_pending_count(uuid) from public, anon;
grant execute on function public.vendor_pending_count(uuid) to authenticated;

revoke all on function public.vendor_mark_ready(uuid) from public, anon;
grant execute on function public.vendor_mark_ready(uuid) to authenticated;

revoke all on function public.partner_confirm_pickup(uuid, text) from public, anon;
grant execute on function public.partner_confirm_pickup(uuid, text) to authenticated;

revoke all on function public.partner_scan_brief(uuid) from public, anon;
grant execute on function public.partner_scan_brief(uuid) to authenticated;

revoke all on function public.my_scan_order(uuid) from public, anon;
grant execute on function public.my_scan_order(uuid) to authenticated;

-- The catalogue, browsable with no account at all.
revoke all on function public.scan_menu(uuid) from public;
grant execute on function public.scan_menu(uuid) to anon, authenticated;

revoke all on function public.scan_restaurants() from public;
grant execute on function public.scan_restaurants() to anon, authenticated;

-- Service-only, exactly as before.
revoke all on function public.confirm_payment(uuid, text, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 12. THE PARTNER'S OLD REDEMPTION REPORTS
-- ---------------------------------------------------------------------------
-- Dropped rather than left reachable. Redemption is the store's act now, and a
-- second function that could set REDEEMED from the other side of the counter
-- would be exactly the asymmetry hard rule 11 exists to prevent — the Partner
-- would be able to record that an entitlement was honoured without anybody at
-- the store agreeing that it was.

drop function if exists public.partner_report_scan_redeemed(uuid);
drop function if exists public.partner_report_scan_refused(uuid, text);
