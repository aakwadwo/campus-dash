-- ============================================================================
-- Partner dispatch
-- ============================================================================
-- The sharpest concurrency case in the system. Two Partners tapping Accept in
-- the same millisecond must produce exactly ONE winner, and the loser must be
-- told plainly rather than silently losing the food.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Offers — what a Partner sees BEFORE accepting
-- ---------------------------------------------------------------------------
-- Deliberately excludes the customer's identity, phone, exact room and the
-- pickup code. It includes everything needed to judge the job: who the vendor
-- is, which zone, the walk estimate, and the earnings. Nothing important is
-- hidden until after acceptance.
create or replace function public.get_delivery_offers()
returns table (
  order_id          uuid,
  order_number      text,
  vendor_name       text,
  vendor_location   text,
  destination_zone  text,
  walk_minutes      integer,
  earnings_pesewas  bigint,
  item_count        bigint,
  ready_at          timestamptz,
  food_is_ready     boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id,
    o.order_number,
    v.name,
    public.location_path(v.location_id),
    coalesce(z.name, 'Campus'),
    -- NULL when either leg is unknown: an estimate is omitted, never invented.
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    true
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  where o.delivery_status = 'SEARCHING'
    and o.order_status = 'READY'
    and o.payment_status = 'PAID'
    -- The caller must be a dispatchable Partner...
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- ...with no active delivery. One at a time in V1.
    and not exists (
      select 1 from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
  order by o.ready_at asc;
$$;

-- ---------------------------------------------------------------------------
-- partner_accept_delivery — ATOMIC
-- ---------------------------------------------------------------------------
create or replace function public.partner_accept_delivery(p_order_id uuid)
returns table (success boolean, reason text, order_number text, pickup_code text, vendor_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_code    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Authorisation failure: raise. Not a routine outcome.
  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  v_code := public.generate_numeric_code(4);

  -- THE ATOMIC CLAIM.
  --
  -- A single statement checks every eligibility rule in its WHERE clause and
  -- claims the row in the same breath. Postgres serialises the two racing
  -- UPDATEs on the row lock; the loser re-evaluates the WHERE against the
  -- winner's committed state, sees delivery_status is no longer SEARCHING, and
  -- matches zero rows.
  --
  -- The one-active-delivery rule is belt AND braces: this NOT EXISTS plus the
  -- partial unique index orders_one_active_delivery_per_partner, which would
  -- reject a second claim even if this predicate were somehow bypassed.
  update public.orders o
     set partner_id = v_partner,
         delivery_status = 'ASSIGNED',
         assigned_at = now()
   where o.id = p_order_id
     and o.delivery_status = 'SEARCHING'
     and o.order_status = 'READY'
     and o.payment_status = 'PAID'
     and o.partner_id is null
     and exists (
       select 1 from public.partner_profiles p
        where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
     )
     and not exists (
       select 1 from public.orders a
        where a.partner_id = v_partner
          and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
     )
  returning * into v_order;

  -- Losing the race is ROUTINE, so it returns rather than raising. That keeps
  -- the rejection log committed instead of rolling it back.
  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text, null::text;
    return;
  end if;

  -- Fresh code for this assignment. The version bump is what makes any earlier
  -- code dead rather than merely unused.
  update public.order_secrets
     set pickup_code = v_code,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now())
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED');

  return query
    select true, null::text, v_order.order_number, v_code, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- partner_cancel_delivery — before handoff
-- ---------------------------------------------------------------------------
-- THE SAME ORDER SURVIVES. Payment untouched, vendor preparation untouched.
-- The vendor experiences this as "still waiting for a Partner", never as
-- "cancel this and make a new one".
create or replace function public.partner_cancel_delivery(p_order_id uuid, p_reason text default null)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
begin
  update public.orders o
     set partner_id = null,
         delivery_status = 'SEARCHING',
         assigned_at = null
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
    jsonb_build_object('pickup_code_rotated', true));

  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- vendor_confirm_pickup — the handoff gate
-- ---------------------------------------------------------------------------
-- The Partner reads their code aloud; the vendor types in what they hear. The
-- vendor cannot READ the stored code (order_secrets has no client-readable RLS
-- policy at all), so they cannot confirm a handoff that did not happen.
create or replace function public.vendor_confirm_pickup(p_order_id uuid, p_pickup_code text)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order  public.orders%rowtype;
  v_stored text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  select pickup_code into v_stored
    from public.order_secrets where order_id = p_order_id;

  -- A rotated (NULL) code never matches, so a code from a cancelled assignment
  -- is worthless the moment the Partner walks away.
  -- A rotated (NULL) code never matches. A wrong code is logged as evidence.
  if v_stored is null or p_pickup_code is null or v_stored <> p_pickup_code then
    perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', false, 'VENDOR',
      'delivery_status', 'ASSIGNED', 'PICKED_UP', 'pickup code did not match');
    return row(false, 'pickup code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'PICKED_UP', picked_up_at = now()
   where o.id = p_order_id and o.delivery_status = 'ASSIGNED' and o.partner_id is not null
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', false, 'VENDOR',
      'delivery_status', null, 'PICKED_UP', 'delivery was not ASSIGNED');
    return row(false, 'order is not awaiting pickup')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', true, 'VENDOR',
    'delivery_status', 'ASSIGNED', 'PICKED_UP');
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- partner_complete_delivery — the customer's code is the proof
-- ---------------------------------------------------------------------------
-- A Partner cannot simply declare "delivered". The customer holds the code.
create or replace function public.partner_complete_delivery(p_order_id uuid, p_delivery_code text)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_stored  text;
begin
  -- Authorisation failure: raise.
  if not exists (
    select 1 from public.orders
     where id = p_order_id and partner_id = v_partner and delivery_status = 'PICKED_UP'
  ) then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  select delivery_code into v_stored from public.order_secrets where order_id = p_order_id;

  -- A Partner cannot simply declare "delivered": the customer holds the code.
  if v_stored is null or p_delivery_code is null or v_stored <> p_delivery_code then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', 'PICKED_UP', 'DELIVERED', 'delivery code did not match');
    return row(false, 'delivery code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'DELIVERED', delivered_at = now(),
         order_status = 'COMPLETED', completed_at = now()
   where o.id = p_order_id and o.delivery_status = 'PICKED_UP' and o.order_status = 'READY'
  returning * into v_order;

  if not found then
    return row(false, 'order is not in a completable state')::public.transition_result;
  end if;

  -- The Partner's money is carved out of the platform allocation only now, when
  -- a real Partner has actually earned it. It becomes eligible for the next
  -- weekly settlement run.
  perform public.settle_partner_earnings(p_order_id);

  perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'DELIVERED');
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pickup orders complete without any Partner at all
-- ---------------------------------------------------------------------------
create or replace function public.vendor_complete_pickup_order(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders o
     set order_status = 'COMPLETED', completed_at = now()
   where o.id = p_order_id
     and o.order_status = 'READY'
     and o.fulfilment_type = 'PICKUP'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'order was not a READY, PAID pickup order');
    return row(false, 'order is not a ready pickup order')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', true, 'VENDOR',
    'order_status', 'READY', 'COMPLETED');
  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Dispatch gave up
-- ---------------------------------------------------------------------------
-- CRITICAL: this touches delivery_status ONLY. order_status stays READY and
-- payment_status stays PAID. The food exists and the customer can still collect
-- it — a failed delivery must never destroy the food order.
create or replace function public.expire_partner_search()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_id    uuid;
begin
  perform public.assert_service_or_admin();

  for v_id in
    update public.orders
       set delivery_status = 'FAILED_NO_PARTNER'
     where delivery_status = 'SEARCHING' and search_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'DISPATCH_FAILED', true, 'SYSTEM',
      'delivery_status', 'SEARCHING', 'FAILED_NO_PARTNER',
      'no partner accepted within the search window; food order is unaffected');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Code retrieval — entitlement checked, never a plain SELECT
-- ---------------------------------------------------------------------------
create or replace function public.get_my_pickup_code(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  select s.pickup_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');

  if v_code is null then
    raise exception 'no pickup code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;

create or replace function public.get_my_delivery_code(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  select s.delivery_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id and o.customer_id = auth.uid();

  if v_code is null then
    raise exception 'no delivery code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- Partner availability
-- ---------------------------------------------------------------------------
create or replace function public.partner_set_availability(p_available boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  update public.partner_profiles
     set is_available = p_available
   where user_id = auth.uid();

  return p_available;
end;
$$;
