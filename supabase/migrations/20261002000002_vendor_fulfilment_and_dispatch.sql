-- ---------------------------------------------------------------------------
-- VENDOR FULFILMENT, PARTNER SESSIONS, AND WHAT HAPPENS WHEN A PARTNER CANCELS
-- ---------------------------------------------------------------------------
-- Four unrelated-looking corrections that share one shape: a fact the product
-- relies on was being INFERRED from another fact, and the inference was wrong.
--
--   1. "the store is finished with this order" was inferred from order_status,
--      which does not become COMPLETED until the CUSTOMER has their food. So a
--      store that handed a bag to a Partner watched the order sit on their
--      board until somebody across campus opened a door.
--   2. "this Partner is online" was inferred from a boolean nobody had a reason
--      to keep current, and "how long have they been online" was not answerable
--      at all.
--   3. "where is this going" was inferred, for a Partner deciding whether to
--      take a job, from the BLOCK alone — no floor, which is most of the walk.
--   4. "somebody will pick this up again" was inferred, after a cancellation,
--      from a search that had already been running and a broadcast that had
--      already gone out and would not go out again.
--
-- Each is replaced by a fact that is recorded rather than derived.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. VENDOR FULFILMENT IS ITS OWN DIMENSION
-- ---------------------------------------------------------------------------
-- The store's job ends at the counter. For a collection that is also the end of
-- the order, so the two were indistinguishable and nobody noticed; for a
-- Partner order they are minutes or miles apart.
--
-- THIS IS NOT A NEW ORDER STATE. order_status keeps meaning exactly what it
-- meant — the whole order, through to the customer — and hard rule 2 keeps its
-- three dimensions. This is a fourth, narrow fact with one reader: the board.

alter table public.orders
  add column if not exists vendor_completed_at timestamp with time zone;

comment on column public.orders.vendor_completed_at is
  'When the store handed the food over and its part ended — to a collecting customer, or to a Partner. NOT the end of the order: a Partner order is still in flight, and order_status says so. The store''s board buckets on this, so handing a bag to a Partner clears the counter instead of leaving the order sitting there until somebody across campus opens a door.';

create index if not exists orders_vendor_open_idx
  on public.orders (vendor_id, created_at desc)
  where vendor_completed_at is null;

-- Backfill: every order that already reached the customer is one the store
-- finished too. Doing this from completed_at rather than now() keeps the
-- history honest — these handoffs happened when they happened.
update public.orders
   set vendor_completed_at = coalesce(completed_at, cancelled_at)
 where vendor_completed_at is null
   and (completed_at is not null or cancelled_at is not null);

-- An order already collected by a Partner but not yet delivered: the store
-- finished at pickup.
update public.orders
   set vendor_completed_at = picked_up_at
 where vendor_completed_at is null
   and picked_up_at is not null;

-- The bucket reads the new column. NEW and READY are unchanged; CLOSED now
-- means "the store is done with it" rather than "the order is over".
create or replace function public.vendor_order_bucket_for(
  p_order_status public.order_status,
  p_vendor_completed_at timestamp with time zone
)
returns text
language sql
immutable
as $$
  select case
    when p_vendor_completed_at is not null                then 'CLOSED'
    when p_order_status in ('ACCEPTED', 'PREPARING')      then 'NEW'
    when p_order_status = 'READY'                         then 'READY'
    else 'CLOSED'
  end;
$$;

comment on function public.vendor_order_bucket_for(public.order_status, timestamp with time zone) is
  'Which column of the store''s board an order belongs in. Keyed on the store''s own completion rather than the order''s, so a Partner order leaves the counter at handoff.';

-- ---------------------------------------------------------------------------
-- 2. THE HANDOFFS RECORD IT
-- ---------------------------------------------------------------------------

-- A Partner takes the food: the store is finished, the delivery is not.
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
  -- additionally means the store has verified the scan.
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
     set delivery_status = 'PICKED_UP',
         picked_up_at = now(),
         -- THE STORE IS FINISHED. Their board clears here, and the customer
         -- stays in tracking because order_status has not moved.
         vendor_completed_at = coalesce(o.vendor_completed_at, now())
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
    'delivery_status', 'ASSIGNED', 'PICKED_UP', null,
    jsonb_build_object('vendor_completed', true));
  return row(true, null)::public.transition_result;
end;
$$;

-- A customer collects: the store is finished and so is the order.
create or replace function public.customer_complete_pickup(p_order_id uuid, p_pickup_code text)
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
     set order_status = 'COMPLETED',
         completed_at = now(),
         vendor_completed_at = coalesce(o.vendor_completed_at, now())
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
-- 3. THE BOARD READS THE NEW BUCKET
-- ---------------------------------------------------------------------------

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
  vendor_completed_at timestamp with time zone,
  awaiting_handoff boolean,
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
           public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at)
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
         case when r.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = r.id)
              else 0::bigint end,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         r.vendor_completed_at,
         -- SOMEBODY IS DUE AT THE COUNTER. Deliberately does not say who: the
         -- store does the same thing either way, and naming the recipient
         -- invited stores to treat the two differently.
         (r.vendor_completed_at is null and r.order_status = 'READY'
            and (r.delivery_status = 'ASSIGNED' or r.delivery_status = 'NONE')),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when r.bucket = 'CLOSED' then null else r.created_at end asc,
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
  vendor_completed_at timestamp with time zone,
  handoff_code_available boolean,
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
         o.subtotal_pesewas,
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.vendor_completed_at,
         -- Whether there is a code to read out right now.
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
         )
    from public.orders o
    left join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;

-- The count on the store's own tab. Open orders only, on the new definition.
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
     and o.vendor_completed_at is null
     and o.order_status in ('ACCEPTED', 'PREPARING')
     and public.is_vendor_staff(p_vendor_id);
$$;

-- ---------------------------------------------------------------------------
-- 4. WHERE IT IS GOING, FOR SOMEBODY DECIDING WHETHER TO WALK THERE
-- ---------------------------------------------------------------------------
-- An offer carried the BLOCK and nothing else, which is the wrong half of the
-- answer: a fourth-floor room and a ground-floor one are the same block and a
-- very different job. The ROOM is still withheld — every available Partner sees
-- this list, and a student's room number is not something to broadcast to a
-- pool of people none of whom has the job yet.

create or replace function public.location_floor(p_location_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $$
  with recursive up as (
    select l.id, l.parent_id, l.kind, l.name
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.kind, l.name
      from public.locations l
      join up on l.id = up.parent_id
  )
  select name from up where kind = 'FLOOR' limit 1;
$$;

comment on function public.location_floor(uuid) is
  'The FLOOR a destination sits on, or null. Shown on an offer beside the block: a fourth-floor room and a ground-floor one are the same block and a very different walk. The ROOM is never on an offer.';

drop function if exists public.get_delivery_offers();

create or replace function public.get_delivery_offers()
returns table(
  order_id uuid,
  order_number text,
  vendor_order_no integer,
  vendor_name text,
  vendor_location text,
  destination_zone text,
  destination_floor text,
  walk_minutes integer,
  earnings_pesewas bigint,
  item_count bigint,
  ready_at timestamp with time zone,
  food_is_ready boolean,
  order_type public.order_type,
  seconds_until_search_expires integer
)
language sql
stable
security definer
set search_path to ''
as $$
  select
    o.id, o.order_number, o.vendor_order_no, v.name, public.location_path(v.location_id),
    -- BLOCK AND FLOOR, never the room. The exact destination arrives with the
    -- assignment, to the one person who then needs it.
    coalesce(z.name, 'Campus'),
    public.location_floor(o.destination_location_id),
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    -- WHETHER THERE IS ANYTHING TO COLLECT YET. Offers go out while the order
    -- is still being put together, so this is the difference between "go now"
    -- and "it is yours, wait for the store".
    (o.order_status = 'READY'),
    o.order_type,
    -- How long this offer has left before the search gives up. The Partner sees
    -- the same deadline the customer is counting down against.
    case when o.search_deadline_at is not null
         then greatest(0, extract(epoch from (o.search_deadline_at - now()))::integer) end
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

-- ---------------------------------------------------------------------------
-- 5. A CANCELLATION REOPENS THE SEARCH PROPERLY
-- ---------------------------------------------------------------------------
-- It used to release the order and stop. Which meant the customer kept counting
-- down against the ORIGINAL deadline — often nearly expired — while nobody was
-- told there was work again, because the broadcast had already gone out for
-- this order and the notification layer deduplicates on the order.
--
-- So the window restarts, and `dispatch_generation` is bumped: it is the thing
-- that makes the next broadcast a DIFFERENT notification from the last one, so
-- every eligible Partner is reachable again — including the ones who were told
-- the first time and did not take it.

alter table public.orders
  add column if not exists dispatch_generation integer not null default 0;

comment on column public.orders.dispatch_generation is
  'How many times this order has been put out to Partners. Incremented whenever a search reopens — a cancellation, an admin reassignment. It exists to be part of the notification dedupe key, so re-broadcasting reaches Partners who were already told once and did not take it; without it the second broadcast silently reached nobody.';

create or replace function public.partner_cancel_delivery(p_order_id uuid, p_reason text default null)
returns public.transition_result
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_cfg     public.pricing_config%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  update public.orders o
     set partner_id = null,
         partner_slot = null,
         delivery_status = 'SEARCHING',
         assigned_at = null,
         -- A FRESH WINDOW. The customer is now waiting for a Partner who has
         -- not been found yet, and counting them down against a deadline set
         -- when a different Partner took the job would expire the search under
         -- somebody who had done nothing wrong.
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds),
         dispatch_generation = o.dispatch_generation + 1
   where o.id = p_order_id
     and o.partner_id = v_partner
     -- Only before handoff. Once PICKED_UP the Partner holds the food and this
     -- is an admin problem, not a self-service cancellation.
     and o.delivery_status = 'ASSIGNED'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_CANCEL', false, 'PARTNER',
      'delivery_status', null, 'SEARCHING', 'not the assigned partner, or food already collected');
    return row(false, 'you are not the assigned partner, or the food is already collected')::public.transition_result;
  end if;

  -- ROTATE. The previous pickup code dies here, immediately.
  update public.order_secrets
     set pickup_code = null,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = null
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_CANCEL', true, 'PARTNER',
    'delivery_status', 'ASSIGNED', 'SEARCHING', p_reason,
    jsonb_build_object('pickup_code_rotated', true,
                       'dispatch_generation', v_order.dispatch_generation,
                       'search_reopened', true));

  return row(true, null)::public.transition_result;
end;
$$;

-- An administrator taking an order off a Partner reopens the search the same
-- way, for the same reasons.
create or replace function public.admin_reassign_delivery(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
  v_cfg    public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from public.pricing_config where id;
  select * into v_before from public.orders where id = p_order_id;

  update public.orders o
     set partner_id = null, partner_slot = null, delivery_status = 'SEARCHING',
         assigned_at = null, picked_up_at = null,
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds),
         dispatch_generation = o.dispatch_generation + 1,
         -- The store is back in it: whoever comes next has to be handed the
         -- food, so the order returns to their board.
         vendor_completed_at = null
   where o.id = p_order_id
     and o.fulfilment_type = 'DELIVERY'
     -- FAILED_CUSTOMER_ABSENT deliberately excluded: that Partner is owed money.
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER')
  returning * into v_after;

  if not found then
    raise exception 'order has no reassignable delivery' using errcode = 'check_violation';
  end if;

  update public.order_secrets
     set pickup_code = null,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = null
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'ADMIN_REASSIGN', true, 'ADMIN',
    'delivery_status', v_before.delivery_status::text, 'SEARCHING', p_reason,
    jsonb_build_object('previous_partner_id', v_before.partner_id,
                       'pickup_code_rotated', true,
                       'dispatch_generation', v_after.dispatch_generation));
  perform public.log_admin_action('DELIVERY_REASSIGN', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. THE CUSTOMER CAN SEE THE CLOCK, AND WHO BROUGHT IT
-- ---------------------------------------------------------------------------

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
  seconds_until_partner_search_expires integer,
  server_now timestamp with time zone,
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

-- The list names the Partner on a finished delivery too, for the same reason.
-- EVERY OTHER COLUMN IS UNTOUCHED: the shape of this function is what half a
-- dozen screens read, and changing it to make one expression clearer would be
-- churn with a blast radius.
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
         -- FIRST NAME, AND IT STAYS. It used to be nulled the moment the
         -- delivery ended, so a history row named nobody — a record of a
         -- transaction rather than of something that happened. "Kwame brought
         -- this" is what a person remembers. The PHONE NUMBER is what ends with
         -- the delivery, and this list never carried one.
         public.given_name(pu.first_name, pu.full_name),
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;

-- ---------------------------------------------------------------------------
-- 7. PARTNER AVAILABILITY IS A RECORDED SESSION, NOT A GUESS
-- ---------------------------------------------------------------------------
-- `is_available` said whether a Partner was online. Nothing said for how long,
-- or when they last were, and the honest answer to "how much has this person
-- been available this week" was that nobody knew. Inferring it from page visits
-- would have been worse than not answering: it measures whether somebody looked
-- at their phone, not whether they were willing to take work.
--
-- So availability writes a row. The boolean stays as the live flag every
-- dispatch query already reads; the table is the history behind it.

create table if not exists public.partner_sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  -- Why it ended, for the one case that is not the Partner's own choice.
  ended_reason text,
  constraint partner_sessions_ends_after_start check (ended_at is null or ended_at >= started_at)
);

comment on table public.partner_sessions is
  'One row per period a Partner was online and willing to take work. Opened by partner_set_availability(true) and closed by the matching false, so online time is MEASURED rather than inferred from page visits — which would measure whether somebody looked at their phone.';

-- AT MOST ONE OPEN SESSION PER PARTNER. Two would double-count every minute
-- between them, and the totals an administrator steers by would drift upward
-- for as long as nobody noticed.
create unique index if not exists partner_sessions_one_open_per_user
  on public.partner_sessions (user_id) where ended_at is null;

create index if not exists partner_sessions_user_started_idx
  on public.partner_sessions (user_id, started_at desc);

alter table public.partner_sessions enable row level security;

-- A Partner may read their own history. Nobody else reaches the table directly;
-- an administrator sees it through admin_partner_activity().
--
-- DROPPED FIRST, because the table above is created `if not exists` and this
-- policy was not. On a database that already has the table — a hand-applied
-- fix, or a schema.sql install ahead of the migration history — the CREATE
-- would fail on 42710 and stop the deployment on a line that changes nothing.
-- Every other policy in this chain is written this way; this one was the
-- exception.
drop policy if exists "partner_sessions_own" on public.partner_sessions;
create policy "partner_sessions_own" on public.partner_sessions
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

grant select on public.partner_sessions to authenticated;

drop function if exists public.partner_set_availability(boolean);

create or replace function public.partner_set_availability(p_available boolean)
returns public.partner_profiles
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- THE FLAG IS ALL THIS SETS. The session is opened or closed by the trigger
  -- below, so the column and the table cannot disagree however the column is
  -- written — including by a migration, an administrator or a fixture.
  update public.partner_profiles p
     set is_available = p_available
   where p.user_id = v_user
     -- ONLY AN APPROVED PARTNER GOES ONLINE. An applicant flipping this would
     -- appear in no dispatch query — is_approved_partner() guards those too —
     -- but it would start a session and make the activity report a fiction.
     and p.status = 'APPROVED'
  returning * into v_profile;

  if not found then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  return v_profile;
end;
$$;

-- ---------------------------------------------------------------------------
-- THE ONE PLACE A SESSION OPENS OR CLOSES
-- ---------------------------------------------------------------------------
-- `is_available` is the live flag every dispatch query already reads;
-- partner_sessions is the history behind it. A trigger is what keeps them from
-- drifting: the alternative is every writer remembering to do both, and the
-- first one that forgets leaves a Partner marked online with no session — which
-- reads as "online now, zero minutes online today" on an operational report,
-- and is the kind of wrong that gets believed.
--
-- APPROVAL PUTS A PARTNER ONLINE. Somebody who has just been told they are a
-- Partner is willing to take work; making them find a toggle first was a step
-- that existed only because the flag defaulted to false. Withdrawing approval
-- takes them off, so a suspended Partner does not accrue online time.
create or replace function public.partner_availability_follows_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'APPROVED' and new.is_available then
      insert into public.partner_sessions (user_id) values (new.user_id)
      on conflict (user_id) where ended_at is null do nothing;
    end if;
    return new;
  end if;

  -- Approval grants availability; losing approval withdraws it. Done before
  -- the session work below, so one update settles both facts.
  if new.status = 'APPROVED' and old.status is distinct from 'APPROVED' then
    new.is_available := true;
  elsif new.status is distinct from 'APPROVED' and old.status = 'APPROVED' then
    new.is_available := false;
  end if;

  -- A Partner is only ever online while APPROVED, whatever the flag says.
  if new.status <> 'APPROVED' then
    new.is_available := false;
  end if;

  if new.is_available and not coalesce(old.is_available, false) then
    insert into public.partner_sessions (user_id) values (new.user_id)
    on conflict (user_id) where ended_at is null do nothing;
  elsif not new.is_available and coalesce(old.is_available, false) then
    update public.partner_sessions
       set ended_at = now(),
           ended_reason = case when new.status <> 'APPROVED' then 'approval withdrawn' end
     where user_id = new.user_id and ended_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists partner_availability_follows_status on public.partner_profiles;
create trigger partner_availability_follows_status
  before insert or update of status, is_available on public.partner_profiles
  for each row execute function public.partner_availability_follows_status();

-- Existing approved Partners are online, and the trigger opens their session.
-- Not backdated: we do not know when they would have come online, and inventing
-- a start time would put a number in an operational report nobody measured.
update public.partner_profiles set is_available = true where status = 'APPROVED';

-- ---------------------------------------------------------------------------
-- 8. WHAT AN ADMINISTRATOR SEES
-- ---------------------------------------------------------------------------

create or replace function public.admin_partner_activity()
returns table(
  user_id uuid,
  full_name text,
  phone text,
  status public.partner_application_status,
  is_suspended boolean,
  is_online boolean,
  current_session_seconds integer,
  online_seconds_today bigint,
  online_seconds_this_week bigint,
  last_online_at timestamp with time zone,
  last_offline_at timestamp with time zone,
  deliveries_completed bigint,
  active_deliveries bigint,
  owed_pesewas bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  with bounds as (
    select date_trunc('day', now()) as day_start,
           date_trunc('week', now()) as week_start
  ),
  -- Overlap of each session with the window, so a session that started
  -- yesterday and is still open counts only today's share of itself.
  windowed as (
    select s.user_id,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.day_start)))) as today_seconds,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.week_start)))) as week_seconds
      from public.partner_sessions s
      cross join bounds b
     where coalesce(s.ended_at, now()) >= b.week_start
  )
  select p.user_id,
         u.full_name,
         u.phone,
         p.status,
         u.is_suspended,
         p.is_available,
         (select extract(epoch from (now() - s.started_at))::integer
            from public.partner_sessions s
           where s.user_id = p.user_id and s.ended_at is null
           limit 1),
         (select coalesce(sum(w.today_seconds), 0)::bigint from windowed w where w.user_id = p.user_id),
         (select coalesce(sum(w.week_seconds), 0)::bigint from windowed w where w.user_id = p.user_id),
         (select max(s.started_at) from public.partner_sessions s where s.user_id = p.user_id),
         (select max(s.ended_at) from public.partner_sessions s where s.user_id = p.user_id),
         (select count(*) from public.orders o
           where o.partner_id = p.user_id and o.delivery_status = 'DELIVERED'),
         (select count(*) from public.orders o
           where o.partner_id = p.user_id and o.delivery_status in ('ASSIGNED', 'PICKED_UP')),
         (select coalesce(sum(a.amount_pesewas), 0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = p.user_id and a.status = 'ELIGIBLE')
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
   where public.is_admin()
   order by p.is_available desc, u.full_name;
$$;

comment on function public.admin_partner_activity() is
  'Partner supply, measured. Online time is summed from partner_sessions rows clipped to the window, so a session still open counts only the part of itself inside it. Never derived from page visits.';

-- A Partner's own record of it, so the dashboard can say "online 3h today"
-- without an administrator being the only one who can see it.
create or replace function public.my_partner_activity()
returns table(
  is_online boolean,
  current_session_seconds integer,
  online_seconds_today bigint,
  online_seconds_this_week bigint
)
language sql
stable
security definer
set search_path to ''
as $$
  with bounds as (
    select date_trunc('day', now()) as day_start,
           date_trunc('week', now()) as week_start
  ),
  windowed as (
    select greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.day_start)))) as today_seconds,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.week_start)))) as week_seconds
      from public.partner_sessions s
      cross join bounds b
     where s.user_id = auth.uid()
       and coalesce(s.ended_at, now()) >= b.week_start
  )
  select p.is_available,
         (select extract(epoch from (now() - s.started_at))::integer
            from public.partner_sessions s
           where s.user_id = auth.uid() and s.ended_at is null
           limit 1),
         (select coalesce(sum(w.today_seconds), 0)::bigint from windowed w),
         (select coalesce(sum(w.week_seconds), 0)::bigint from windowed w)
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 9. GRANTS
-- ---------------------------------------------------------------------------

revoke all on function public.vendor_order_bucket_for(public.order_status, timestamp with time zone) from public, anon;
grant execute on function public.vendor_order_bucket_for(public.order_status, timestamp with time zone) to authenticated;

revoke all on function public.vendor_order_board(uuid, integer) from public, anon;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated;

revoke all on function public.vendor_order_detail(uuid) from public, anon;
grant execute on function public.vendor_order_detail(uuid) to authenticated;

revoke all on function public.vendor_pending_count(uuid) from public, anon;
grant execute on function public.vendor_pending_count(uuid) to authenticated;

revoke all on function public.partner_confirm_pickup(uuid, text) from public, anon;
grant execute on function public.partner_confirm_pickup(uuid, text) to authenticated;

revoke all on function public.customer_complete_pickup(uuid, text) from public, anon;
grant execute on function public.customer_complete_pickup(uuid, text) to authenticated;

revoke all on function public.get_delivery_offers() from public, anon;
grant execute on function public.get_delivery_offers() to authenticated;

-- A pure text helper over the location tree, like location_path and
-- location_zone beside it. It reads nothing about anybody.
revoke all on function public.location_floor(uuid) from public;
grant execute on function public.location_floor(uuid) to anon, authenticated;

revoke all on function public.partner_cancel_delivery(uuid, text) from public, anon;
grant execute on function public.partner_cancel_delivery(uuid, text) to authenticated;

revoke all on function public.admin_reassign_delivery(uuid, text) from public, anon;
grant execute on function public.admin_reassign_delivery(uuid, text) to authenticated;

revoke all on function public.customer_order_detail(uuid) from public, anon;
grant execute on function public.customer_order_detail(uuid) to authenticated;

revoke all on function public.customer_order_list(integer) from public, anon;
grant execute on function public.customer_order_list(integer) to authenticated;

revoke all on function public.partner_set_availability(boolean) from public, anon;
grant execute on function public.partner_set_availability(boolean) to authenticated;

revoke all on function public.admin_partner_activity() from public, anon;
grant execute on function public.admin_partner_activity() to authenticated;

revoke all on function public.my_partner_activity() from public, anon;
grant execute on function public.my_partner_activity() to authenticated;

-- A trigger function. Nothing calls it directly, and nothing should.
revoke all on function public.partner_availability_follows_status() from public, anon, authenticated;
