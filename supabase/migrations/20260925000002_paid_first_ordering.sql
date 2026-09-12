-- ============================================================================
-- PAID-FIRST ORDERING
-- ============================================================================
-- The vendor no longer answers a doorbell. They receive orders that have
-- already been paid for, and the only thing they press is "Ready for pickup".
--
-- What this changes, and why each piece had to move:
--
--   1. SUBMISSION CARRIES THE FULFILMENT. Pickup or delivery is chosen at the
--      checkout, before paying, because there is no longer an acceptance step
--      to put it after. The order is created ACCEPTED — which from here means
--      "priced, real and payable", not "a vendor said yes" — with UNPAID money
--      and NONE delivery.
--
--   2. THE ORDER NUMBER IS A DAILY QUEUE NUMBER, per vendor. A kitchen calls
--      out "seven", not "CD-01043". The global sequence survives as the
--      internal reference every payment, allocation and payout already keys
--      off; it is simply no longer the number anybody is shown.
--
--   3. DISPATCH OPENS AT PAYMENT, not at READY. A Partner should be found
--      while the food cooks, not after — so the offer pool now accepts a
--      PREPARING order and tells the Partner whether the food is ready yet.
--
--   4. THE COLLECTION HANDOFF REVERSED. The VENDOR now holds the four-digit
--      code and reads it out; the CUSTOMER types it into their own app. The
--      rule it obeys is unchanged and is the only rule that matters here: the
--      person who holds the secret is never the person who performs the act.
--      What changes is which side of the counter each of those is on, and the
--      product reason is that the collecting customer is the one with a screen
--      in their hand and a queue behind them.
--
--      Consequently get_my_pickup_code() (customer reads their own code) and
--      vendor_complete_pickup_order() (vendor types it) are both taken off the
--      client surface. Leaving either reachable would put holder and performer
--      on the same side and the code would prove nothing.
--
--   5. NOTHING IS DROPPED THAT HISTORY DEPENDS ON. vendor_accept_order,
--      vendor_reject_order, vendor_mark_preparing and vendor_complete_pickup_order
--      still exist — orders placed before this migration reference them in
--      order_events, and admin tooling may yet need them — but EXECUTE is
--      revoked from `authenticated`, so no browser can reach them again.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. DAILY, PER-VENDOR ORDER NUMBERS
-- ---------------------------------------------------------------------------
-- A counter row per vendor per day. The number is allocated by an upsert whose
-- ON CONFLICT DO UPDATE takes a row lock, so two orders placed in the same
-- millisecond serialise on that row and cannot be handed the same number. A
-- unique index on the order says the same thing a second time, which is the
-- half that would survive somebody writing a different allocator later.
--
-- Ghana is UTC+0 all year, so "calendar day" needs no timezone argument — but
-- it is written explicitly rather than left to the server's setting.

create table if not exists public.vendor_order_counters (
  vendor_id  uuid not null references public.vendors(id) on delete cascade,
  order_day  date not null,
  last_no    integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (vendor_id, order_day),
  constraint vendor_order_counters_last_no_check check (last_no >= 0)
);

comment on table public.vendor_order_counters IS
  'One row per store per day, holding the last queue number issued. Server-only: there are no client grants, and the number is allocated inside submit_order_for().';

alter table public.vendor_order_counters enable row level security;

-- No policy and no grant. Nothing outside a SECURITY DEFINER function reads it.
revoke all on table public.vendor_order_counters from anon, authenticated;

alter table public.orders
  add column if not exists order_day date,
  add column if not exists vendor_order_no integer;

comment on column public.orders.vendor_order_no IS
  'The store''s queue number for that day: 1, 2, 3 … shown as 001. Unique per (vendor, day). NULL on a SCAN errand, which the store never sees, and on orders placed before daily numbering existed.';

comment on column public.orders.order_day IS
  'The calendar day the queue number belongs to. Kept as a column rather than derived from created_at so the number and the day it is unique within can never disagree.';

create unique index if not exists orders_vendor_day_no_unique
  on public.orders (vendor_id, order_day, vendor_order_no)
  where vendor_order_no is not null;

create or replace function public.next_vendor_order_no(p_vendor_id uuid, p_day date)
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_no integer;
begin
  insert into public.vendor_order_counters as c (vendor_id, order_day, last_no)
  values (p_vendor_id, p_day, 1)
  on conflict (vendor_id, order_day) do update
     set last_no = c.last_no + 1,
         updated_at = now()
  returning c.last_no into v_no;

  return v_no;
end;
$$;

comment on function public.next_vendor_order_no(uuid, date) IS
  'The next queue number for this store today. Atomic: the upsert''s DO UPDATE locks the counter row, so simultaneous orders queue behind one another rather than sharing a number.';

-- ---------------------------------------------------------------------------
-- 2. SUBMISSION, WITH THE FULFILMENT ON IT
-- ---------------------------------------------------------------------------

drop function if exists public.submit_order(uuid, jsonb);
drop function if exists public.submit_order_for(uuid, uuid, jsonb);

create or replace function public.submit_order_for(
  p_customer_id uuid,
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note text default null
)
returns table(order_id uuid, order_number text, vendor_order_no integer, total_pesewas bigint)
language plpgsql
security definer
set search_path to ''
as $$
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
    case when p_fulfilment_type = 'DELIVERY'
         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
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
       and is_available;

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

create or replace function public.submit_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note text default null
)
returns table(order_id uuid, order_number text, vendor_order_no integer, total_pesewas bigint)
language plpgsql
security definer
set search_path to ''
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(
      auth.uid(), p_vendor_id, p_items,
      p_fulfilment_type, p_destination_location_id, p_destination_note);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. THE CHECKOUT QUOTE
-- ---------------------------------------------------------------------------
-- The screen shows the FINAL price before anybody taps Pay, so the quote has to
-- know the fulfilment. It also reports whether delivery is on offer at all, so
-- the checkout can disable it rather than letting somebody choose an option
-- submission would refuse.

drop function if exists public.quote_order(uuid, jsonb);

create or replace function public.quote_order(
  p_vendor_id uuid,
  p_items jsonb,
  p_fulfilment_type public.fulfilment_type default null
)
returns table(
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  total_pesewas bigint,
  delivery_available boolean,
  lines jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select p.subtotal_pesewas,
         p.service_fee_pesewas,
         case when p_fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         p.total_pesewas
           + case when p_fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         coalesce(c.partner_delivery_enabled, true),
         p.lines
    from public.price_order(p_vendor_id, p_items) p
    cross join public.pricing_config c
   where c.id;
$$;

-- What each fulfilment would cost an order that already exists, for the screen
-- that lets somebody change their mind before paying.
drop function if exists public.fulfilment_options(uuid);

create or replace function public.fulfilment_options(p_order_id uuid)
returns table(
  fulfilment_type public.fulfilment_type,
  delivery_fee_pesewas bigint,
  total_pesewas bigint,
  is_available boolean
)
language sql
stable
security definer
set search_path to ''
as $$
  select f.fulfilment_type,
         case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         o.subtotal_pesewas + o.service_fee_pesewas
           + case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         -- Pickup is always on offer. Delivery depends on whether there are
         -- Partners to be had, which is an administrator's switch.
         case when f.fulfilment_type = 'DELIVERY'
              then coalesce(c.partner_delivery_enabled, true) else true end
    from public.orders o
    cross join public.pricing_config c
    cross join (values ('PICKUP'::public.fulfilment_type), ('DELIVERY'::public.fulfilment_type))
                 as f(fulfilment_type)
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and c.id
   order by f.fulfilment_type;
$$;

-- Changing the choice between submission and payment. Same guard as
-- submission: delivery is refused while Partner delivery is switched off.
create or replace function public.customer_choose_fulfilment(
  p_order_id uuid,
  p_fulfilment_type public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note text default null
)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
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
         destination_note         = case when p_fulfilment_type = 'DELIVERY'
                                         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
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
-- 4. PAYMENT IS WHAT REACHES THE KITCHEN AND OPENS DISPATCH
-- ---------------------------------------------------------------------------

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

  if v_order.order_type = 'SCAN' then
    -- A scan errand has no kitchen. Paying for it IS what opens dispatch.
    update public.orders o
       set order_status      = 'READY',
           ready_at          = now(),
           delivery_status   = 'SEARCHING',
           search_started_at = now(),
           search_deadline_at = now() + make_interval(secs => v_search)
     where o.id = v_payment.order_id
       and o.order_status = 'ACCEPTED'
       and o.delivery_status = 'NONE';

    if found then
      perform public.log_order_event(v_payment.order_id, 'SCAN_DISPATCH_OPENED', true, 'SYSTEM',
        'delivery_status', 'NONE', 'SEARCHING');
    end if;
  else
    -- A FOOD order reaches the kitchen the moment it is paid for. There is no
    -- accept and no separate "start preparing" tap: the store's whole job is to
    -- make it and press Ready.
    --
    -- DISPATCH OPENS HERE TOO, for a delivery. A Partner found while the food
    -- cooks is a Partner who is not standing at a counter waiting — and the
    -- offer carries food_is_ready so nobody sets off too early.
    --
    -- Both guarded on the current state, so a replayed confirmation cannot
    -- restart a search that has already found somebody.
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
  end if;

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. READY, AND THE COLLECTION CODE
-- ---------------------------------------------------------------------------
-- READY no longer opens dispatch — payment did that — so this function's job
-- narrows to two things: tell everyone the food is made, and, for a collection,
-- mint the code the vendor is about to read out.

create or replace function public.vendor_mark_ready(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
  v_cfg   public.pricing_config%rowtype;
begin
  select order_status into v_prev from public.orders where id = p_order_id;
  select * into v_cfg from public.pricing_config where id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders o
     set order_status = 'READY',
         ready_at = now(),
         -- Belt only. Dispatch opened at payment; this catches a delivery order
         -- that somehow reached READY with its search never started.
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
  -- vendor's to read out; the customer types it in. Minting it at the moment
  -- the food is ready means a code never exists for food that is not.
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

-- The code the vendor reads out, whoever is collecting.
--
-- Replaces vendor_pickup_code(), which only returned one while a PARTNER was
-- assigned. The same function now serves both handoffs, because from the
-- counter they are the same act: somebody is standing there, and the code is
-- how the vendor knows the food is theirs to take.
create or replace function public.vendor_handoff_code(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_code text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  select s.pickup_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and o.payment_status = 'PAID'
     and (
       -- A Partner is at the counter for this order.
       o.delivery_status = 'ASSIGNED'
       -- Or the customer is, and the food is made. DELIVERY_STATUS, not
       -- fulfilment_type: a delivery nobody took, which the customer then chose
       -- to collect themselves, is a collection in every way that matters here.
       -- customer_collect_instead() sets delivery_status back to NONE and mints
       -- a code, and keying on the fulfilment they originally chose would leave
       -- that code unreadable and the order uncompletable.
       or (o.order_status = 'READY' and o.delivery_status = 'NONE')
     );

  if v_code is null then
    raise exception 'no handoff code on this order right now'
      using errcode = 'no_data_found';
  end if;
  return v_code;
end;
$$;

comment on function public.vendor_handoff_code(uuid) IS
  'The four digits the store reads out at the counter — to a Partner collecting a delivery, or to a customer collecting their own order. The store never types it: whoever is taking the food does that in their own app.';

-- The customer types in what the vendor read them, and that completes the
-- collection. The mirror of partner_confirm_pickup, and for the same reason:
-- the person walking away with the food is the one who has to prove they were
-- actually handed it.
create or replace function public.customer_complete_pickup(
  p_order_id uuid,
  p_pickup_code text
)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_order  public.orders%rowtype;
  v_owner  uuid;
  v_state  public.order_status;
  v_check  text;
begin
  select o.customer_id, o.order_status into v_owner, v_state
    from public.orders o where o.id = p_order_id;

  -- AUTHORISATION failure: raise. A missing order and somebody else's order
  -- get the same message, so probing tells the caller nothing. It comes first,
  -- so a stranger can never burn an attempt on a code that is not theirs.
  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  -- STATE before CODE, so a second tap after a successful collection does not
  -- spend an attempt on a code that has already done its job.
  if v_state is distinct from 'READY' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', v_state::text, 'COMPLETED', 'order was not ready for collection');
    return row(false, 'this order is not ready for collection')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', 'READY', 'COMPLETED', 'collection code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask the vendor to read it out again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', 'READY', 'COMPLETED', 'collection code did not match');
    return row(false, 'that code does not match. Check it with the vendor')::public.transition_result;
  end if;

  update public.orders o
     set order_status = 'COMPLETED', completed_at = now()
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status = 'READY'
     -- NOBODY IS BRINGING IT. That covers a collection chosen at the checkout
     -- and a delivery nobody took that the customer decided to fetch — see
     -- customer_collect_instead(), which returns delivery_status to NONE.
     and o.delivery_status = 'NONE'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', null, 'COMPLETED', 'order was not a READY, PAID collection');
    return row(false, 'this order is not ready for collection')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', true, 'CUSTOMER',
    'order_status', 'READY', 'COMPLETED');
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. DISPATCH, FROM THE MOMENT THE ORDER IS PAID
-- ---------------------------------------------------------------------------
-- Three functions shared one eligibility rule and two of them hard-coded the
-- capacity limit at 2 while pricing_config said otherwise. They now read the
-- configured number, and all three accept an order that is still cooking.

drop function if exists public.get_delivery_offers();

create or replace function public.get_delivery_offers()
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  vendor_location text,
  destination_zone text,
  walk_minutes integer,
  earnings_pesewas bigint,
  item_count bigint,
  ready_at timestamp with time zone,
  food_is_ready boolean,
  order_type public.order_type
)
language sql
stable
security definer
set search_path to ''
as $$
  select
    o.id, o.order_number, o.vendor_order_no, v.name, public.location_path(v.location_id),
    -- ZONE, not the room. Every available Partner sees this list, and a student's
    -- room number is not something to broadcast to a pool of people who have not
    -- been given the job yet. The exact destination arrives with the assignment.
    coalesce(z.name, 'Campus'),
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    -- WHETHER THERE IS ANYTHING TO COLLECT YET. Offers now go out while the
    -- food is still cooking, so this is the difference between "go now" and
    -- "it is yours, wait for the kitchen".
    (o.order_status = 'READY'),
    o.order_type
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  cross join public.pricing_config c
  where c.id
    and o.delivery_status = 'SEARCHING'
    and o.order_status in ('PREPARING', 'READY')
    and o.payment_status = 'PAID'
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- A Partner already at capacity is shown nothing, rather than shown offers
    -- that would be refused on acceptance. How many that is, is an
    -- administrator's setting — not a number in this file.
    and (
      select count(*) from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    ) < c.max_active_deliveries_per_partner
    and o.customer_id <> auth.uid()
    and v.owner_user_id is distinct from auth.uid()
  order by o.ready_at asc nulls last, o.created_at asc;
$$;

create or replace function public.partner_accept_delivery(p_order_id uuid)
returns table(success boolean, reason text, order_number text, vendor_name text)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_slot    smallint;
  v_max     smallint;
  v_full    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
      join public.vendors v on v.id = o.vendor_id
     where o.id = p_order_id and v.owner_user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a store you own'
      using errcode = 'insufficient_privilege';
  end if;

  select max_active_deliveries_per_partner into v_max from public.pricing_config where id;
  v_max := coalesce(v_max, 2);

  v_full := case
    when v_max = 1 then 'You already have an active delivery. Finish it first.'
    else 'You already have ' || v_max || ' active deliveries. Finish one first.'
  end;

  select s into v_slot
    from generate_series(1, v_max) s
   where not exists (
     select 1 from public.orders a
      where a.partner_id = v_partner
        and a.partner_slot = s
        and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
   )
   order by s
   limit 1;

  if v_slot is null then
    return query select false, v_full, null::text, null::text;
    return;
  end if;

  begin
    update public.orders o
       set partner_id = v_partner,
           partner_slot = v_slot,
           delivery_status = 'ASSIGNED',
           assigned_at = now()
     where o.id = p_order_id
       and o.delivery_status = 'SEARCHING'
       -- PREPARING as well as READY. The offer pool opens at payment now, so
       -- the winner is often decided while the food is still on the stove.
       and o.order_status in ('PREPARING', 'READY')
       and o.payment_status = 'PAID'
       and o.partner_id is null
       and exists (
         select 1 from public.partner_profiles p
          where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
       )
       and (
         select count(*) from public.orders a
          where a.partner_id = v_partner
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < v_max
       and o.customer_id <> v_partner
       and not exists (
         select 1 from public.vendors v
          where v.id = o.vendor_id and v.owner_user_id = v_partner
       )
    returning * into v_order;
  exception
    when unique_violation then
      perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
        'delivery_status', null, 'ASSIGNED', 'partner delivery slot already taken');
      return query select false, v_full, null::text, null::text;
      return;
  end;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text;
    return;
  end if;

  -- Fresh codes, and a fresh attempt counter with them. A Partner who inherits
  -- an order somebody else fumbled starts at zero failures, and the previous
  -- Partner's lockout does not follow the order around.
  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         pickup_attempts = 0,
         pickup_locked_until = null,
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now()),
         delivery_attempts = 0,
         delivery_locked_until = null
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED', null,
    jsonb_build_object('partner_slot', v_slot));

  return query
    select true, null::text, v_order.order_number, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;

create or replace function public.partners_to_notify_of_offer(p_order_id uuid)
returns table(user_id uuid, phone text, full_name text)
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform public.assert_service_or_admin();

  return query
    select u.id, u.phone, u.full_name
      from public.partner_profiles pp
      join public.users u on u.id = pp.user_id
      join public.orders o on o.id = p_order_id
      join public.vendors v on v.id = o.vendor_id
      cross join public.pricing_config c
     where c.id
       and pp.status = 'APPROVED'
       and pp.is_available
       and not u.is_suspended
       and u.phone is not null
       and o.delivery_status = 'SEARCHING'
       and o.order_status in ('PREPARING', 'READY')
       and o.payment_status = 'PAID'
       -- The same two conflicts of interest, and the configured capacity limit.
       and o.customer_id <> u.id
       and v.owner_user_id is distinct from u.id
       and (
         select count(*) from public.orders a
          where a.partner_id = u.id
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < c.max_active_deliveries_per_partner;
end;
$$;

-- The Partner may be assigned while the food cooks, but they cannot COLLECT
-- what has not been made. The order_status guard is new and is what stops a
-- keen Partner confirming a pickup at an empty counter.
create or replace function public.partner_confirm_pickup(
  p_order_id uuid,
  p_pickup_code text
)
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
  v_type     public.order_type;
  v_check    text;
  v_order    public.orders%rowtype;
begin
  select o.partner_id, o.delivery_status, o.order_status, o.order_type
    into v_assigned, v_state, v_order_state, v_type
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

  -- A scan delivery has no food to hand over. Its equivalent moment is the
  -- redemption report, which is a different function and a different fact.
  if v_type = 'SCAN' then
    raise exception 'a scan delivery is collected by reporting the redemption'
      using errcode = 'check_violation';
  end if;

  -- STATE before CODE. The food is not made yet, so there is nothing to
  -- collect and no attempt to spend finding that out.
  if v_order_state is distinct from 'READY' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'food is not ready yet');
    return row(false, 'the food is not ready yet. Wait for the store to mark it ready')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask the vendor to read it out again')::public.transition_result;
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

-- The Partner's active-job screen, now carrying the queue number the store
-- will actually call out and whether there is anything at the counter yet.
drop function if exists public.partner_active_delivery();

create or replace function public.partner_active_delivery()
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  partner_slot smallint,
  delivery_status public.delivery_status,
  food_is_ready boolean,
  vendor_name text,
  vendor_location text,
  vendor_phone text,
  destination_zone text,
  destination text,
  destination_note text,
  customer_name text,
  customer_first_name text,
  customer_phone text,
  earnings_pesewas bigint,
  item_count bigint,
  assigned_at timestamp with time zone,
  picked_up_at timestamp with time zone,
  customer_absent_reported_at timestamp with time zone,
  seconds_until_absent_allowed integer,
  order_type public.order_type,
  scan_status public.scan_status
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.partner_slot,
         o.delivery_status,
         (o.order_status = 'READY'),
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

-- ---------------------------------------------------------------------------
-- 7. THE READ MODELS
-- ---------------------------------------------------------------------------

-- No SUBMITTED, no CHOOSE_FULFILMENT. An order is paid for or it is not.
create or replace function public.customer_order_stage(
  p_order_status public.order_status,
  p_payment_status public.payment_status,
  p_delivery_status public.delivery_status default 'NONE',
  p_fulfilment_type public.fulfilment_type default null
)
returns text
language sql
immutable
as $$
  select case
    -- Kept so an order placed before paid-first ordering still reads sensibly
    -- in somebody's history. Nothing new ever reaches it.
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'

    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'

    when p_order_status = 'PREPARING' and p_delivery_status = 'ASSIGNED' then 'PREPARING_PARTNER_ASSIGNED'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

    when p_order_status = 'READY' and p_delivery_status = 'SEARCHING'         then 'SEARCHING_PARTNER'
    when p_order_status = 'READY' and p_delivery_status = 'ASSIGNED'          then 'PARTNER_ASSIGNED'
    when p_order_status = 'READY' and p_delivery_status = 'PICKED_UP'         then 'ON_THE_WAY'
    when p_order_status = 'READY' and p_delivery_status = 'FAILED_NO_PARTNER' then 'NO_PARTNER'
    when p_order_status = 'READY'                                            then 'READY'

    when p_delivery_status = 'FAILED_CUSTOMER_ABSENT'                 then 'CUSTOMER_ABSENT'
    when p_order_status = 'COMPLETED'                                 then 'COMPLETED'
    when p_order_status = 'REJECTED'                                  then 'REJECTED'
    when p_order_status = 'EXPIRED'                                   then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;

drop function if exists public.customer_order_list(integer);

create or replace function public.customer_order_list(p_limit integer default 30)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  order_type public.order_type,
  stage text,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  item_count bigint,
  total_pesewas bigint,
  submitted_at timestamp with time zone,
  completed_at timestamp with time zone,
  seconds_to_deadline integer,
  partner_first_name text,
  cancellation_reason text
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id, o.order_number, o.vendor_order_no, v.name, o.order_type,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at, o.completed_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- FIRST NAME, and only while they are carrying it. The history row
         -- for a finished delivery names nobody.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP')
              then public.given_name(pu.first_name, pu.full_name) end,
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

drop function if exists public.customer_order_detail(uuid);

create or replace function public.customer_order_detail(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  vendor_location text,
  stage text,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  order_type public.order_type,
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  pack_fee_pesewas bigint,
  total_pesewas bigint,
  destination text,
  destination_note text,
  submitted_at timestamp with time zone,
  seconds_to_deadline integer,
  accepted_at timestamp with time zone,
  preparing_at timestamp with time zone,
  ready_at timestamp with time zone,
  assigned_at timestamp with time zone,
  picked_up_at timestamp with time zone,
  completed_at timestamp with time zone,
  cancellation_reason text,
  payment_id uuid,
  payment_txn_status public.payment_txn_status,
  partner_name text,
  partner_phone text,
  delivery_code text,
  disputed boolean,
  dispute_reason text,
  can_rate_partner boolean,
  rated_stars smallint,
  items jsonb
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id, o.order_number, o.vendor_order_no, v.name, public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas,
         coalesce(o.pack_fee_pesewas, 0), o.total_pesewas,
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
         -- THE PARTNER'S FIRST NAME, and only while they are carrying it. Once
         -- the rating prompt is up the name is gone: the prompt says "your
         -- Partner", because who it was is no longer the customer's business.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP')
              then public.given_name(pu.first_name, pu.full_name) end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         -- THE COLLECTION CODE IS NOT HERE ANY MORE. The vendor holds it and
         -- reads it out; the customer types it in. Returning it to the customer
         -- would put holder and performer on the same side of the counter.
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
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
    left join public.partner_ratings rt on rt.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;

-- How many orders this account has placed, and how many are live. The account
-- screen leads with this, so it is one query rather than a count of a list.
create or replace function public.my_order_summary()
returns table(total_orders bigint, completed_orders bigint, active_orders bigint)
language sql
stable
security definer
set search_path to ''
as $$
  select count(*) filter (where o.order_status <> 'DRAFT'),
         count(*) filter (where o.order_status = 'COMPLETED'),
         count(*) filter (
           where o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
         )
    from public.orders o
   where o.customer_id = auth.uid();
$$;

comment on function public.my_order_summary() IS
  'Counts for the customer account screen. Derived from the orders themselves, so it can never disagree with the list underneath it.';

-- The vendor board. THREE GROUPS, because there are now three things an order
-- can be to a store: make it, hand it over, done.
create or replace function public.vendor_order_bucket(p_order_status public.order_status)
returns text
language sql
immutable
as $$
  select case
    -- ACCEPTED only ever appears here for a moment: confirm_payment moves a
    -- paid order straight to PREPARING, and an unpaid one is not on the board.
    when p_order_status in ('ACCEPTED', 'PREPARING') then 'NEW'
    when p_order_status = 'READY'                    then 'READY'
    else 'CLOSED'
  end;
$$;

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
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  item_count bigint,
  total_pesewas bigint,
  submitted_at timestamp with time zone,
  age_seconds integer,
  destination_zone text,
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
       -- A scan order asks nothing of the restaurant through Campus Dash.
       and o.order_type = 'FOOD'
       -- PAID ONLY. A store is never shown an order somebody has not paid for:
       -- there is nothing to do about it, and a basket abandoned at a checkout
       -- is not a ticket.
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
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         r.total_pesewas,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
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

drop function if exists public.vendor_order_detail(uuid);

create or replace function public.vendor_order_detail(p_order_id uuid)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_id uuid,
  bucket text,
  order_status public.order_status,
  payment_status public.payment_status,
  delivery_status public.delivery_status,
  fulfilment_type public.fulfilment_type,
  subtotal_pesewas bigint,
  service_fee_pesewas bigint,
  delivery_fee_pesewas bigint,
  total_pesewas bigint,
  submitted_at timestamp with time zone,
  age_seconds integer,
  accepted_at timestamp with time zone,
  preparing_at timestamp with time zone,
  ready_at timestamp with time zone,
  completed_at timestamp with time zone,
  destination_zone text,
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
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.subtotal_pesewas,
         o.service_fee_pesewas,
         o.delivery_fee_pesewas,
         o.total_pesewas,
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         -- ZONE ONLY. The room number never leaves the database for a vendor.
         case when o.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = o.destination_zone_id) end,
         o.partner_id is not null,
         public.given_name(p.first_name, p.full_name),
         -- Whether there is a code to read out right now: a Partner at the
         -- counter, or a collection whose food is made.
         (o.payment_status = 'PAID' and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
         -- The name the store calls out when the customer is collecting. First
         -- name only, and only when nobody is bringing it — a delivery is met by
         -- a Partner, so the customer's name is not the store's business.
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
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

-- Paid orders still to be made. The alert on the board, and the reason a phone
-- next to a hot plate is worth glancing at.
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
     and o.order_type = 'FOOD'
     and o.payment_status = 'PAID'
     and o.order_status in ('ACCEPTED', 'PREPARING')
     and public.is_vendor_staff(p_vendor_id);
$$;

-- The Partner's own record of finished work, carrying the same queue number
-- the store called out — so a Partner querying an earning can name the order
-- the way everybody else on campus does.
drop function if exists public.partner_delivery_history(integer);

create or replace function public.partner_delivery_history(p_limit integer default 30)
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  destination_zone text,
  delivery_status public.delivery_status,
  earnings_pesewas bigint,
  delivered_at timestamp with time zone,
  paid_out boolean
)
language sql
stable
security definer
set search_path to ''
as $$
  select o.id, o.order_number, o.vendor_order_no, v.name, coalesce(z.name, 'Campus'),
         o.delivery_status, o.partner_earnings_pesewas, o.delivered_at,
         exists (
           select 1 from public.allocations a
            where a.order_id = o.id and a.payee_type = 'PARTNER'
              and a.payee_id = auth.uid() and a.status = 'SETTLED'
         )
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     and o.delivery_status in ('DELIVERED', 'FAILED_CUSTOMER_ABSENT')
   order by o.delivered_at desc nulls last, o.updated_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

-- ---------------------------------------------------------------------------
-- 8. THE SWEEP
-- ---------------------------------------------------------------------------
-- There is no vendor answer window left to elapse. What can now go stale is an
-- order that was priced and never paid for — a basket taken to a checkout and
-- abandoned. It is CANCELLED, not EXPIRED: nobody failed to answer.

create index if not exists orders_awaiting_payment_idx
  on public.orders (accept_deadline_at)
  where order_status = 'ACCEPTED' and payment_status = 'UNPAID';

create or replace function public.expire_stale_orders()
returns integer
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_count integer := 0;
  v_id    uuid;
begin
  perform public.assert_service_or_admin();

  -- Legacy: an order still waiting on a vendor from before paid-first ordering.
  for v_id in
    update public.orders
       set order_status = 'EXPIRED', cancelled_at = now(),
           cancellation_reason = 'vendor did not respond within the acceptance window'
     where order_status = 'SUBMITTED' and accept_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'ORDER_EXPIRED', true, 'SYSTEM',
      'order_status', 'SUBMITTED', 'EXPIRED', 'vendor acceptance window elapsed');
    v_count := v_count + 1;
  end loop;

  -- Priced, never paid. UNPAID only: a payment in flight is PENDING and belongs
  -- to expire_stale_payments(), which knows how to ask the provider first.
  for v_id in
    update public.orders
       set order_status = 'CANCELLED', cancelled_at = now(),
           cancellation_reason = 'the order was not paid for'
     where order_status = 'ACCEPTED'
       and payment_status = 'UNPAID'
       and accept_deadline_at is not null
       and accept_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'ORDER_EXPIRED', true, 'SYSTEM',
      'order_status', 'ACCEPTED', 'CANCELLED', 'payment window elapsed');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. GRANTS
-- ---------------------------------------------------------------------------
-- Every function this migration replaced needs its grant restated: CREATE OR
-- REPLACE keeps the ACL, but a DROP + CREATE does not, and a new function
-- starts with Postgres's default of EXECUTE to PUBLIC.

revoke execute on function public.next_vendor_order_no(uuid, date) from public, anon, authenticated;
revoke execute on function public.submit_order_for(uuid, uuid, jsonb, public.fulfilment_type, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.submit_order(uuid, jsonb, public.fulfilment_type, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.quote_order(uuid, jsonb, public.fulfilment_type)
  from public, anon, authenticated;
revoke execute on function public.fulfilment_options(uuid) from public, anon, authenticated;
revoke execute on function public.customer_order_list(integer) from public, anon, authenticated;
revoke execute on function public.customer_order_detail(uuid) from public, anon, authenticated;
revoke execute on function public.my_order_summary() from public, anon, authenticated;
revoke execute on function public.vendor_order_board(uuid, integer) from public, anon, authenticated;
revoke execute on function public.vendor_order_detail(uuid) from public, anon, authenticated;
revoke execute on function public.vendor_handoff_code(uuid) from public, anon, authenticated;
revoke execute on function public.customer_complete_pickup(uuid, text) from public, anon, authenticated;
revoke execute on function public.partner_active_delivery() from public, anon, authenticated;
revoke execute on function public.get_delivery_offers() from public, anon, authenticated;
revoke execute on function public.partner_delivery_history(integer) from public, anon, authenticated;

grant execute on function public.submit_order(uuid, jsonb, public.fulfilment_type, uuid, text) to authenticated;
grant execute on function public.quote_order(uuid, jsonb, public.fulfilment_type) to authenticated;
grant execute on function public.fulfilment_options(uuid)          to authenticated;
grant execute on function public.customer_choose_fulfilment(uuid, public.fulfilment_type, uuid, text) to authenticated;
grant execute on function public.customer_order_list(integer)      to authenticated;
grant execute on function public.customer_order_detail(uuid)       to authenticated;
grant execute on function public.customer_order_stage(public.order_status, public.payment_status, public.delivery_status, public.fulfilment_type) to authenticated;
grant execute on function public.my_order_summary()                to authenticated;
grant execute on function public.customer_complete_pickup(uuid, text) to authenticated;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated;
grant execute on function public.vendor_order_bucket(public.order_status) to authenticated;
grant execute on function public.vendor_order_detail(uuid)         to authenticated;
grant execute on function public.vendor_pending_count(uuid)        to authenticated;
grant execute on function public.vendor_mark_ready(uuid)           to authenticated;
grant execute on function public.vendor_handoff_code(uuid)         to authenticated;
grant execute on function public.get_delivery_offers()             to authenticated;
grant execute on function public.partner_accept_delivery(uuid)     to authenticated;
grant execute on function public.partner_active_delivery()         to authenticated;
grant execute on function public.partner_confirm_pickup(uuid, text) to authenticated;
grant execute on function public.partner_delivery_history(integer)  to authenticated;

-- ---------------------------------------------------------------------------
-- THE WORKFLOW THAT IS GONE
-- ---------------------------------------------------------------------------
-- Acceptance, rejection and the separate "start preparing" tap are removed from
-- the product. The functions stay, because order_events on real orders point at
-- them and an administrator may still need the cancel path, but nothing with a
-- browser can call them again.
--
-- vendor_complete_pickup_order and get_my_pickup_code go with them, and for a
-- sharper reason: the collection handoff reversed direction. The vendor now
-- holds the code and the customer types it. Leaving either of these reachable
-- would hand the code and the act to the same person.
revoke execute on function public.vendor_accept_order(uuid)             from anon, authenticated;
revoke execute on function public.vendor_reject_order(uuid, text)       from anon, authenticated;
revoke execute on function public.vendor_mark_preparing(uuid)           from anon, authenticated;
revoke execute on function public.vendor_complete_pickup_order(uuid, text) from anon, authenticated;
revoke execute on function public.get_my_pickup_code(uuid)              from anon, authenticated;
revoke execute on function public.vendor_pickup_code(uuid)              from anon, authenticated;
