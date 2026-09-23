-- ============================================================================
-- CAMPUS PLACES, ADDITIONAL INFORMATION, AND WHEN A STORE'S MONEY ARRIVES
-- ============================================================================
-- Three changes that share one idea: say what is true, as precisely as the
-- person saying it chose to be, and no more precisely than that.
--
-- 1. THE CAMPUS AS STUDENTS DESCRIBE IT. The locations tree was always able to
--    make ANY node a destination — a block, a floor, a room. What it held was an
--    illustrative tree. This writes the real one, and relabels a destination
--    the way a person reads it: "Hostel A Entrance", "Hostel A · C Floor",
--    "Hostel A · C Floor · C17". A floor is a complete answer. A room is
--    optional. Nothing is invented to fill a level somebody did not choose.
--
--    The destination is fixed once the order is paid for, as it always was:
--    customer_choose_fulfilment() only moves an UNPAID order. Somebody who
--    walks elsewhere afterwards rings their Partner, whose phone number they
--    already have from assignment — no location is ever rewritten after the
--    fact, and no GPS is involved anywhere.
--
-- 2. ADDITIONAL INFORMATION, ON EVERY ORDER. orders.destination_note already
--    existed and already reached the customer's order and the Partner's job.
--    It was kept only for a delivery. It is now the ONE optional free-text
--    field every order carries — collection or Partner, food or Meal Scan —
--    and the store sees it on the order detail, because "no pepper" and "extra
--    napkins" are the store's business. It is bounded, and the structured
--    destination is still never shown to a store.
--
-- 3. WHEN A STORE'S MONEY ARRIVES. A store with a Paystack subaccount is paid
--    by Paystack, not by Campus Dash: the food subtotal is split off at the
--    charge, and Paystack settles it to the store's mobile money on its own
--    schedule — for Ghana cedis, the next working day. The ledger marks those
--    allocations SETTLED at the charge, which is true from Campus Dash's side
--    and says nothing about when the money reaches the phone. This adds a READ
--    of that money by the day it was paid, so the store's screen can say what
--    is still on its way and which morning to expect it. It writes nothing:
--    no settlement row, no payout, nothing that could be duplicated.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1a. A DESTINATION READS THE WAY PEOPLE SAY IT
-- ---------------------------------------------------------------------------
-- The campus root is dropped — everything is on campus. A landmark (a field or
-- a common area sitting directly in a block or a group) is its own name, which
-- is how "Hostel A Entrance" and "Football Field" read without a heading in
-- front of them. Everything else is its path, joined with a middle dot.
--
-- One function, so the checkout, the order, the Partner's job, the admin
-- console and the store's own location all say the same words.

create or replace function public.location_path(p_location_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  with recursive up as (
    select l.id, l.parent_id, l.kind, l.name, 0 as depth
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.kind, l.name, up.depth + 1
      from public.locations l
      join up on l.id = up.parent_id
  )
  select case
           when (select kind from up where depth = 0) in ('FIELD', 'COMMON_AREA')
            and coalesce((select kind from up where depth = 1), 'CAMPUS') in ('BLOCK', 'CAMPUS')
             then (select name from up where depth = 0)
           else (select string_agg(name, ' · ' order by depth desc) from up where kind <> 'CAMPUS')
         end;
$$;

comment on function public.location_path(uuid) is
  'A destination as a person reads it: "Hostel A Entrance", "Hostel A · C Floor · C17", "Football Field". The campus is implied; a landmark is its own name. Used everywhere a place is shown.';


-- ---------------------------------------------------------------------------
-- 1b. THE TREE, FOR A PICKER THAT DRILLS DOWN
-- ---------------------------------------------------------------------------
-- deliverable_locations() answers "which places can I choose" as a flat list,
-- which is the wrong shape for two hundred and fifty rooms. This returns the
-- active tree — navigational nodes included, flagged — so the checkout can
-- show recognisable places first and reveal floors and rooms only on request.
-- Anon-callable for the same reason deliverable_locations() is: somebody
-- browsing before signing up can see whether Campus Dash reaches them.

create or replace function public.destination_places()
returns table(
  location_id uuid,
  parent_id uuid,
  kind public.location_kind,
  name text,
  label text,
  is_deliverable boolean,
  sort_order integer
)
language sql
stable
security definer
set search_path to ''
as $$
  select l.id, l.parent_id, l.kind, l.name, public.location_path(l.id), l.is_deliverable, l.sort_order
    from public.locations l
   where l.is_active
   order by l.sort_order, l.name;
$$;

comment on function public.destination_places() is
  'The active campus tree for the destination picker: every node with its parent, whether it can itself be chosen, and the label an order will carry. Navigational nodes are included so the picker can drill down; the client never decides what is deliverable — submission re-checks.';

revoke all on function public.destination_places() from public;
grant execute on function public.destination_places() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 1c. THE REAL CAMPUS
-- ---------------------------------------------------------------------------
-- THE TREE ITSELF, written so that running it twice changes nothing.
--
-- A node that already exists under the same parent with the same name is
-- REUSED, never duplicated — a hosted project whose administrator already
-- typed in "Hostel A" keeps that row and every order pointing at it. A node
-- that does not exist is created with an id derived from its parent and its
-- name, so two environments built from empty agree on every id.
--
-- Anything active that is NOT in this list is switched off, not deleted. An
-- order that named it keeps its foreign key and its readable label; it simply
-- stops being offered to the next customer. Campus Dash does not invent places.
create or replace function pg_temp.campus_place(
  p_parent uuid, p_kind public.location_kind, p_name text, p_deliverable boolean, p_sort integer
) returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select id into v_id
    from public.locations
   where parent_id is not distinct from p_parent and lower(name) = lower(p_name);

  if v_id is null then
    insert into public.locations (id, parent_id, kind, name, is_deliverable, sort_order)
    values (md5('campus-dash:location:' || coalesce(p_parent::text, '') || '/' || lower(p_name))::uuid,
            p_parent, p_kind, p_name, p_deliverable, p_sort)
    returning id into v_id;
  else
    update public.locations
       set is_deliverable = p_deliverable, is_active = true, sort_order = p_sort
     where id = v_id;
  end if;

  insert into pg_temp.campus_places (id) values (v_id) on conflict do nothing;
  return v_id;
end;
$fn$;

create temporary table if not exists campus_places (id uuid primary key);

do $tree$
declare
  v_root   uuid;
  v_block  uuid;
  v_floor  uuid;
  v_group  uuid;
  v_hostel text;
  v_letter text;
  v_i      integer;
  v_h      integer := 0;
  v_f      integer;
begin
  -- The campus root: the existing one if an administrator already made it.
  select id into v_root
    from public.locations
   where kind = 'CAMPUS' and parent_id is null
   order by (lower(name) = 'academic city') desc, is_active desc, sort_order, created_at
   limit 1;
  if v_root is null then
    v_root := pg_temp.campus_place(null, 'CAMPUS', 'Academic City', false, 0);
  else
    insert into pg_temp.campus_places (id) values (v_root) on conflict do nothing;
  end if;

  -- ACADEMIC BLOCK. A floor stands on its own; a room is optional precision.
  v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Academic Block', false, 10);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Ground Floor', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A1', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A2', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A3', true, 3);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Make Lab', true, 4);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'First Floor', true, 2);
  for v_i in 1..6 loop
    perform pg_temp.campus_place(v_floor, 'ROOM', 'L' || v_i, true, v_i);
  end loop;
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Computer Lab 1', true, 7);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Computer Lab 2', true, 8);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Library', true, 9);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Second Floor', true, 3);
  for v_i in 7..12 loop
    perform pg_temp.campus_place(v_floor, 'ROOM', 'L' || v_i, true, v_i - 6);
  end loop;
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Media Lab', true, 7);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Math Center', true, 8);

  -- ADMINISTRATIVE BLOCK.
  v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Administrative Block', false, 20);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Ground Floor', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'SCA', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Finance', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Old Cafeteria', true, 3);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'First Floor', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'IT Office', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Marketing & Admissions Office', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Reception/Lounge', true, 3);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Second Floor', true, 3);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Registry Office', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Faculty Office', true, 2);

  -- HOSTELS. The entrance is where somebody who just says "Hostel A" is met;
  -- a floor stands on its own; a room is optional.
  foreach v_hostel in array array['A', 'B'] loop
    v_h := v_h + 1;
    v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Hostel ' || v_hostel, false, 30 + v_h);
    perform pg_temp.campus_place(v_block, 'COMMON_AREA', 'Hostel ' || v_hostel || ' Entrance', true, 0);
    v_f := 0;
    foreach v_letter in array array['A', 'B', 'C', 'D'] loop
      v_f := v_f + 1;
      v_floor := pg_temp.campus_place(v_block, 'FLOOR', v_letter || ' Floor', true, v_f);
      for v_i in 1..32 loop
        perform pg_temp.campus_place(v_floor, 'ROOM', v_letter || v_i, true, v_i);
      end loop;
    end loop;
  end loop;

  -- LANDMARKS, grouped the way people describe them. The group is how the
  -- picker files them; the place is what everybody reads.
  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Sports & recreation', false, 40);
  perform pg_temp.campus_place(v_group, 'FIELD', 'Football Field', true, 1);
  perform pg_temp.campus_place(v_group, 'FIELD', 'Basketball Court', true, 2);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Slabs', true, 3);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Rec Center Top', true, 4);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Rec Center Down', true, 5);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Old Cafeteria', true, 6);

  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Facilities', false, 50);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Wafflemania', true, 1);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Engineering Workshop', true, 2);

  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Parking', false, 60);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Academic Block Car Park', true, 1);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Hostel Car Park', true, 2);

  -- Everything else under this campus stops being offered.
  update public.locations l
     set is_active = false
   where l.is_active
     and l.id not in (select id from pg_temp.campus_places)
     and l.id in (
       with recursive below as (
         select id from public.locations where parent_id = v_root
         union all
         select c.id from public.locations c join below b on c.parent_id = b.id
       )
       select id from below
     );
end;
$tree$;

drop function pg_temp.campus_place(uuid, public.location_kind, text, boolean, integer);
drop table pg_temp.campus_places;


-- ---------------------------------------------------------------------------
-- 2a. ADDITIONAL INFORMATION IS BOUNDED
-- ---------------------------------------------------------------------------
-- 280 characters: room for "I'm near the stairs, call when you arrive, extra
-- napkins please", and not a place to paste an essay. NOT VALID, so a row
-- written before the bound existed is left exactly as it was; every new write
-- is held to it.

alter table public.orders drop constraint if exists orders_destination_note_length;
alter table public.orders
  add constraint orders_destination_note_length
  check (destination_note is null or length(destination_note) <= 280) not valid;

comment on column public.orders.destination_note is
  'ADDITIONAL INFORMATION: the one optional free-text field on an order, in the customer''s words. Kept on every order, whatever the fulfilment or payment. Seen by the customer, the store (vendor_order_detail) and the assigned Partner. At most 280 characters.';


-- ---------------------------------------------------------------------------
-- 2b. KEPT ON A COLLECTION TOO
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
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
    -- ADDITIONAL INFORMATION, on every order. It used to be kept only for a
    -- delivery, as a note about finding somebody; it is now the one free-text
    -- field an order carries, and a collection has as much use for it.
    nullif(btrim(coalesce(p_destination_note, '')), ''),
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


-- ---------------------------------------------------------------------------
-- 2c. CHANGING THE FULFILMENT KEEPS WHAT THE CUSTOMER WROTE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order    public.orders%rowtype;
  v_cfg      public.pricing_config%rowtype;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  if not found or v_order.customer_id <> auth.uid() then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      return row(false, 'Partner delivery is unavailable right now. Choose collection.')::public.transition_result;
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

  update public.orders o
     set fulfilment_type          = p_fulfilment_type,
         destination_location_id  = case when p_fulfilment_type = 'DELIVERY'
                                         then p_destination_location_id end,
         -- Changing how the food arrives does not erase what the customer
         -- wrote at the checkout. A new note replaces it; no note keeps it.
         destination_note         = coalesce(nullif(btrim(coalesce(p_destination_note, '')), ''),
                                             o.destination_note),
         destination_zone_id      = v_zone,
         delivery_fee_pesewas     = v_delivery,
         partner_earnings_pesewas = v_earnings,
         total_pesewas            = o.subtotal_pesewas + o.service_fee_pesewas + v_delivery
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status = 'ACCEPTED'
     and o.payment_status in ('UNPAID', 'FAILED')
     and o.order_type = 'FOOD'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', false, 'CUSTOMER',
      null, null, p_fulfilment_type::text,
      'order was not an unpaid food order');
    return row(false, 'this order is past the point of changing')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', true, 'CUSTOMER',
    null, null, p_fulfilment_type::text, null,
    jsonb_build_object(
      'delivery_fee_pesewas', v_delivery,
      'total_pesewas', v_order.total_pesewas));

  return row(true, null)::public.transition_result;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2d. THE STORE SEES IT, ON THE ORDER DETAIL
-- ---------------------------------------------------------------------------
-- A new column on the end, so it is a new return type and the function is
-- dropped and recreated. scan_details stays: it is what a Meal Scan order
-- carried before this field existed, and old orders still hold it.

drop function if exists public.vendor_order_detail(uuid);

CREATE OR REPLACE FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_id" "uuid", "bucket" "text", "order_type" "public"."order_type", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "scan_status" "public"."scan_status", "scan_details" "text", "scan_value_pesewas" bigint, "vendor_amount_pesewas" bigint, "vendor_pack_pesewas" bigint, "submitted_at" timestamp with time zone, "age_seconds" integer, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "vendor_completed_at" timestamp with time zone, "handoff_code_available" boolean, "cancellation_reason" "text", "items" "jsonb", "additional_information" "text")
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
         -- The customer's optional note about the FOOD, which is the store's
         -- business. The destination note is a different column and is not here.
         case when o.order_type = 'SCAN' then s.details end,
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
         -- ADDITIONAL INFORMATION. The customer's own words from the checkout —
         -- "no pepper", "extra napkins", "leave it with reception". The store
         -- is who acts on most of it. The STRUCTURED destination is still not
         -- here: that is the Partner's business and the customer's.
         o.destination_note
    from public.orders o
    left join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;


comment on function public.vendor_order_detail(uuid) is
  'One paid order, as its store sees it: items, the store''s amount (subtotal + pack), on a scan order the scanned value and the pack, and the customer''s additional information. No structured destination, no phone number, no customer total. Staff or admin, enforced in the body.';

revoke all on function public.vendor_order_detail(uuid) from public, anon;
grant execute on function public.vendor_order_detail(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. THE STORE'S SPLIT MONEY, BY THE DAY IT WAS PAID
-- ---------------------------------------------------------------------------
-- One row per (Ghana calendar day the customer paid, channel): split money for
-- the last p_days days, and ledger-owed money however old. The screen turns each day into the working day Paystack settles
-- it and adds up what has not arrived yet.
--
-- SPLIT rows are counted whatever their ledger status, because SETTLED on a
-- split row means "Paystack took it at the charge", not "it is on your phone".
-- TRANSFER rows (a store with no subaccount) are counted only while the ledger
-- still owes them: those move when a settlement run pays them, not on
-- Paystack's schedule, and the screen says so rather than guessing a day.
--
-- Africa/Accra is UTC+0 all year, but it is named rather than assumed: the day
-- a payment belongs to is a Ghana day.

create or replace function public.vendor_payout_days(p_vendor_id uuid, p_days integer default 14)
returns table(paid_day date, settlement_channel text, amount_pesewas bigint)
language sql
stable
security definer
set search_path to ''
as $$
  select (p.succeeded_at at time zone 'Africa/Accra')::date,
         coalesce(a.settlement_channel, 'TRANSFER'),
         sum(a.amount_pesewas)::bigint
    from public.allocations a
    join public.payments p
      on p.order_id = a.order_id
     and p.status = 'SUCCEEDED'
   where a.payee_type = 'VENDOR'
     and a.payee_id = p_vendor_id
     and a.status <> 'CANCELLED'
     and (
       (a.settlement_channel = 'SPLIT'
        and p.succeeded_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 60)))
       -- Owed money is owed however old it is, so it has no window.
       or (a.settlement_channel is distinct from 'SPLIT' and a.status <> 'SETTLED')
     )
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   group by 1, 2
   order by 1, 2;
$$;

comment on function public.vendor_payout_days(uuid, integer) is
  'The store''s own money by the Ghana day it was paid, and how it travels: SPLIT (Paystack settles it to the store''s mobile money, next working day) or TRANSFER (owed by the ledger until a settlement run pays it). Read-only: it writes no settlement record. Staff or admin, enforced in the body.';

revoke all on function public.vendor_payout_days(uuid, integer) from public, anon;
grant execute on function public.vendor_payout_days(uuid, integer) to authenticated;
