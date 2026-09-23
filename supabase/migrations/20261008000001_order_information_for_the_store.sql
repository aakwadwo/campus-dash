-- ============================================================================
-- ORDER INFORMATION IS FOR THE STORE; ADDITIONAL INFORMATION IS FOR THE PARTNER
-- ============================================================================
-- A customer writes two different things at the checkout, for two different
-- people, and they must never be one field:
--
--   ORDER INFORMATION (optional)       "No pepper." "Bigger chicken if available."
--     about the food. The STORE reads it before cooking. It lives in
--     order_notes, a table the store reaches only through vendor_order_detail()
--     and a Partner cannot read at all.
--
--   ADDITIONAL INFORMATION (optional)  "I'm near the stairs. Call when you arrive."
--     about finding the customer. The PARTNER reads it, from assignment,
--     through partner_active_delivery(). It stays orders.destination_note —
--     the backend keeps its names — and it is kept only on a Partner order.
--
-- The STRUCTURED destination is a third thing and is not text at all: a
-- location id from the campus tree, fixed once the order is paid for.
--
-- 20261007000001 briefly made destination_note the one note on every order and
-- showed it to the store. This undoes that: vendor_order_detail() returns
-- order_information and nothing the customer wrote for their Partner.
--
-- ORDER INFORMATION EXISTS BEFORE PAYMENT. It is written by submit_order_for()
-- and submit_scan_order(), in the transaction that creates the order, so there
-- is no second save racing the payment webhook, and confirm_payment() — which
-- is what puts the order in front of the store — always finds it already there.
-- Nothing edits it afterwards: there is no update path, and no client grant.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE TABLE
-- ---------------------------------------------------------------------------
-- Its own table rather than a column on orders, because the assigned Partner
-- can SELECT their order's row and has no business reading "no pepper". One
-- row per order at most; no row means the customer wrote nothing.
--
-- SAFE TO RUN TWICE. A replay of this file against a database that already had
-- it once stopped here and left the functions below in an older form; the
-- table and its policy are the only two statements that could not repeat.

create table if not exists public.order_notes (
  order_id   uuid primary key references public.orders (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  constraint order_notes_body_check check (btrim(body) <> '' and length(body) <= 280)
);

comment on table public.order_notes is
  'ORDER INFORMATION: the customer''s optional note about the food, for the store. Written only with the order, before payment. Read by the customer and admins here, by the store only through vendor_order_detail(). Never by a Partner.';

alter table public.order_notes enable row level security;

-- Supabase's default privileges hand a new table to anon and authenticated.
-- Take them back, then give the one read this table needs.
revoke all on table public.order_notes from anon, authenticated;
grant select on table public.order_notes to authenticated;
grant all on table public.order_notes to service_role;

drop policy if exists order_notes_read_customer_or_admin on public.order_notes;
create policy order_notes_read_customer_or_admin on public.order_notes
  for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.orders o
                where o.id = order_notes.order_id and o.customer_id = auth.uid())
  );


-- ---------------------------------------------------------------------------
-- 2. ADDITIONAL INFORMATION IS THE PARTNER'S
-- ---------------------------------------------------------------------------
comment on column public.orders.destination_note is
  'ADDITIONAL INFORMATION: the customer''s optional note for their Partner ("near the stairs, call when you arrive"). Kept only on a Partner order. Seen by the customer, the assigned Partner and admins. Never by the store. At most 280 characters.';


-- ---------------------------------------------------------------------------
-- 3. SUBMISSION WRITES BOTH, IN ONE TRANSACTION
-- ---------------------------------------------------------------------------
-- A new trailing parameter is a new signature, so the old ones are dropped.
-- Every existing positional caller still lines up: p_order_note is last and
-- defaults to null.

drop function if exists public.submit_order(uuid, jsonb, public.fulfilment_type, uuid, text);
drop function if exists public.submit_order_for(uuid, uuid, jsonb, public.fulfilment_type, uuid, text);

CREATE OR REPLACE FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text", "p_order_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_no       integer;
  v_day      date := (now() at time zone 'UTC')::date;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_total    bigint;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
  v_note     text := nullif(btrim(coalesce(p_order_note, '')), '');
  v_extra    text := nullif(btrim(coalesce(p_destination_note, '')), '');
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_customer(p_customer_id) then
    raise exception 'this account has not completed customer sign-up'
      using errcode = 'insufficient_privilege';
  end if;

  -- A CLOSED store takes no new orders. Orders already in the kitchen are
  -- untouched by closing: this guards submission and nothing else.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  if length(v_note) > 280 then
    raise exception 'keep the order information under 280 characters' using errcode = 'check_violation';
  end if;
  if length(v_extra) > 280 then
    raise exception 'keep the additional information under 280 characters' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    -- THE GLOBAL SWITCH, checked at submission and nowhere else that matters.
    -- Turning Partner delivery off stops NEW delivery orders. It does not
    -- reach an order somebody has already paid for, and must not.
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'partner delivery is unavailable right now; choose pickup'
        using errcode = 'check_violation';
    end if;
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  v_no := public.next_vendor_order_no(p_vendor_id, v_day);

  -- ONE ORDER, ONE VENDOR. Enforced by the column: there is no basket spanning
  -- two kitchens and no way to express one.
  --
  -- ACCEPTED at birth. The state name is inherited and now means "priced and
  -- payable" — there is nobody left to accept anything. accept_deadline_at is
  -- reused as the PAY-BY deadline, so an order nobody pays for is swept rather
  -- than sitting in the customer's list for ever.
  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accepted_at, accept_deadline_at,
    order_day, vendor_order_no
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'ACCEPTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    -- ADDITIONAL INFORMATION is for the Partner, so it is kept only when there
    -- is one. On a collection nobody would ever read it.
    case when p_fulfilment_type = 'DELIVERY' then v_extra end,
    v_zone,
    0, 0, v_delivery, v_earnings, v_delivery,
    'NONE', now(), now(),
    now() + make_interval(secs => v_cfg.payment_pending_timeout_seconds),
    v_day, v_no
  )
  returning id, orders.order_number into v_order_id, v_number;

  -- --- PRICE SNAPSHOT ------------------------------------------------------
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
       -- ON THE ACTIVE MENU. A catalogue item the store has turned OFF is not
       -- being offered at all, and a browser that still shows it is stale.
       and is_active;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. The delivery fee is not
  -- in the base: the service fee is a share of what the food costs.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  -- ORDER INFORMATION, for the store. Written in the same transaction as the
  -- order, so it exists before a payment can even be created and the store
  -- never opens an order whose note is still on its way.
  if v_note is not null then
    insert into public.order_notes (order_id, body) values (v_order_id, v_note);
  end if;

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'ACCEPTED',
    null, jsonb_build_object(
      'total_pesewas', v_total,
      'item_count', jsonb_array_length(p_items),
      'fulfilment_type', p_fulfilment_type::text,
      'vendor_order_no', v_no)
  );

  return query select v_order_id, v_number, v_no, v_total;
end;
$$;


revoke all on function public.submit_order_for(uuid, uuid, jsonb, public.fulfilment_type, uuid, text, text) from public, anon, authenticated;
grant all on function public.submit_order_for(uuid, uuid, jsonb, public.fulfilment_type, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text", "p_order_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(
      auth.uid(), p_vendor_id, p_items,
      p_fulfilment_type, p_destination_location_id, p_destination_note, p_order_note);
end;
$$;


revoke all on function public.submit_order(uuid, jsonb, public.fulfilment_type, uuid, text, text) from public, anon;
grant all on function public.submit_order(uuid, jsonb, public.fulfilment_type, uuid, text, text) to authenticated, service_role;

-- Same signature: p_details has always been the scan order's note for the
-- store, and it now lands where every other order's does.
CREATE OR REPLACE FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_details" "text" DEFAULT NULL::"text", "p_destination_note" "text" DEFAULT NULL::"text", "p_wants_pack" boolean DEFAULT false) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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

  -- ORDER INFORMATION. p_details has always been the Meal Scan order's note
  -- for the store ("no pepper"); it is now the same Order information every
  -- order carries, held in order_notes and bounded the same way.
  if length(v_details) > 280 then
    raise exception 'keep the order information under 280 characters' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_destination_note, ''))) > 280 then
    raise exception 'keep the additional information under 280 characters' using errcode = 'check_violation';
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
    -- ADDITIONAL INFORMATION is for the Partner: kept only when there is one.
    case when p_fulfilment_type = 'DELIVERY' then nullif(btrim(coalesce(p_destination_note, '')), '') end,
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

  insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size)
  values (v_order.id, v_customer, p_scan_image_path, p_content_type, p_byte_size);

  if v_details is not null then
    insert into public.order_notes (order_id, body) values (v_order.id, v_details);
  end if;

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


-- The scan row's own note is superseded; the bound on it stays for old rows.
comment on column public.order_scans.details is
  'Superseded by order_notes. Holds the Order information of Meal Scan orders placed before order_notes existed, and is read as a fallback. Nothing writes it now.';


-- ---------------------------------------------------------------------------
-- 4. WHO READS WHAT
-- ---------------------------------------------------------------------------
-- The store: Order information, never Additional information.

drop function if exists public.vendor_order_detail(uuid);

CREATE OR REPLACE FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_id" "uuid", "bucket" "text", "order_type" "public"."order_type", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "scan_status" "public"."scan_status", "scan_value_pesewas" bigint, "vendor_amount_pesewas" bigint, "vendor_pack_pesewas" bigint, "submitted_at" timestamp with time zone, "age_seconds" integer, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "vendor_completed_at" timestamp with time zone, "handoff_code_available" boolean, "cancellation_reason" "text", "items" "jsonb", "order_information" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.vendor_id,
         public.vendor_order_bucket_for(o.order_status, o.vendor_completed_at),
         o.order_type,
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.scan_status,
         case when o.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = o.id)
              else 0::bigint end,
         o.subtotal_pesewas + coalesce(o.pack_fee_pesewas, 0),
         -- THE STORE'S PACK MONEY, as its own figure, so the order screen can
         -- say what the pack is worth to the store without doing arithmetic.
         coalesce(o.pack_fee_pesewas, 0),
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.vendor_completed_at,
         (o.payment_status = 'PAID' and o.vendor_completed_at is null and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
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
         ),
         -- ORDER INFORMATION, and only that. The customer's note about the food
         -- is the store's business; their Additional information is for the
         -- Partner and is not here, and neither is the destination. A Meal
         -- Scan order placed before order_notes existed kept its note on the
         -- scan row.
         coalesce(n.body, s.details)
    from public.orders o
    left join public.order_scans s on s.order_id = o.id
    left join public.order_notes n on n.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;


comment on function public.vendor_order_detail(uuid) is
  'One paid order, as its store sees it: items, the store''s amount (subtotal + pack), on a scan order the scanned value and the pack, and the customer''s Order information. No destination, no Additional information, no phone number, no customer total. Staff or admin, enforced in the body.';

revoke all on function public.vendor_order_detail(uuid) from public, anon;
grant execute on function public.vendor_order_detail(uuid) to authenticated, service_role;

-- The customer: both, each labelled for who it is for.

drop function if exists public.customer_order_detail(uuid);

CREATE OR REPLACE FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_id" "uuid", "vendor_name" "text", "vendor_location" "text", "stage" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "order_type" "public"."order_type", "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "pack_fee_pesewas" bigint, "total_pesewas" bigint, "destination" "text", "destination_note" "text", "submitted_at" timestamp with time zone, "seconds_to_deadline" integer, "seconds_until_partner_search_expires" integer, "server_now" timestamp with time zone, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "assigned_at" timestamp with time zone, "picked_up_at" timestamp with time zone, "completed_at" timestamp with time zone, "cancellation_reason" "text", "payment_id" "uuid", "payment_txn_status" "public"."payment_txn_status", "partner_name" "text", "partner_phone" "text", "delivery_code" "text", "disputed" boolean, "dispute_reason" "text", "can_rate_partner" boolean, "rated_stars" smallint, "items" "jsonb", "order_information" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- THE STORE'S ID, so a customer whose Meal Scan was not accepted can be
  -- offered the one thing left to do: order the same thing again from the same
  -- store. It is their own order; the id is no more than the page they came
  -- from already knew.
  select o.id, o.order_number, o.vendor_order_no, o.vendor_id, v.name,
         public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status,
                                     o.fulfilment_type, o.order_type, o.scan_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas,
         coalesce(o.pack_fee_pesewas, 0), o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- THE PARTNER SEARCH COUNTDOWN, as a number of seconds from a clock
         -- the customer's device does not own. Paired with server_now below so
         -- a screen can anchor a local countdown against the server's idea of
         -- the time rather than its own — a phone with a wrong clock, a tab
         -- that was backgrounded and a refresh all land in the same place.
         case when o.delivery_status = 'SEARCHING' and o.search_deadline_at is not null
              then greatest(0, extract(epoch from (o.search_deadline_at - now()))::integer) end,
         now(),
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- THE PARTNER'S FIRST NAME, AND IT SURVIVES THE DELIVERY NOW. It used
         -- to be nulled the moment the delivery ended, so the rating prompt
         -- said "your Partner" and the order history named nobody — which made
         -- rating somebody an oddly anonymous act. A first name is what one
         -- person tells another; the PHONE NUMBER is the thing that closes with
         -- the delivery, and it still does on the line below.
         public.given_name(pu.first_name, pu.full_name),
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         -- THE COLLECTION CODE IS NOT HERE. The vendor holds it and reads it
         -- out; the customer types it in. Returning it to the customer would
         -- put holder and performer on the same side of the counter.
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         o.order_status = 'COMPLETED'
           and o.delivery_status = 'DELIVERED'
           and o.partner_id is not null
           and rt.order_id is null,
         rt.stars,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb),
         -- The customer's own Order information, as the store reads it.
         coalesce(n.body, sc.details)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
    left join public.partner_ratings rt on rt.order_id = o.id
    left join public.order_notes n on n.order_id = o.id
    left join public.order_scans sc on sc.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;


revoke all on function public.customer_order_detail(uuid) from public, anon;
grant execute on function public.customer_order_detail(uuid) to authenticated, service_role;

-- The scan views read the note from wherever it was written.
CREATE OR REPLACE FUNCTION "public"."my_scan_order"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "scan_status" "public"."scan_status", "details" "text", "uploaded_at" timestamp with time zone, "released_at" timestamp with time zone, "redeemed_at" timestamp with time zone, "refused_at" timestamp with time zone, "refusal_reason" "text", "pack_fee_pesewas" bigint, "scanned_value_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.scan_status, coalesce(n.body, s.details), s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason,
         coalesce(o.pack_fee_pesewas, 0),
         (select coalesce(sum(oi.line_total_pesewas), 0)
            from public.order_items oi where oi.order_id = o.id)
    from public.orders o
    join public.order_scans s on s.order_id = o.id
    left join public.order_notes n on n.order_id = o.id
   where o.id = p_order_id
     and (o.customer_id = auth.uid() or public.is_admin());
$$;

CREATE OR REPLACE FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "customer_name" "text", "restaurant_name" "text", "destination" "text", "details" "text", "scan_status" "public"."scan_status", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "partner_name" "text", "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "partner_earnings_pesewas" bigint, "total_pesewas" bigint, "has_scan_image" boolean, "uploaded_at" timestamp with time zone, "released_at" timestamp with time zone, "redeemed_at" timestamp with time zone, "refused_at" timestamp with time zone, "refusal_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    o.id, o.order_number,
    c.full_name, v.name, public.location_path(o.destination_location_id),
    coalesce(n.body, s.details),
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
  left join public.order_notes n on n.order_id = o.id
  where o.id = p_order_id
    and o.order_type = 'SCAN'
    and public.is_admin();
$$;
