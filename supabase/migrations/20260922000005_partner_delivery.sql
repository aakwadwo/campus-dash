-- ============================================================================
-- Two deliveries, a reversed pickup code, and the customer's phone number
-- ============================================================================
-- Three changes to the Partner side, all of them things the pilot walkthrough
-- kept running into.
--
-- 1. CAPACITY GOES FROM ONE TO TWO. One at a time was the safe first answer;
--    it is also the answer that makes a Partner walk back to the same block
--    twice. Two is a product decision, but "two" is a number a database has to
--    actually be able to hold — see the slot index below, which is the whole
--    reason this is not just a changed predicate.
--
-- 2. THE PICKUP CODE CHANGES DIRECTION. It used to travel Partner → Vendor:
--    the Partner read a code aloud and the vendor typed it in. Which meant the
--    person confirming the handoff was the person who was not carrying anything
--    away, and a vendor who mistyped blocked a Partner standing in front of
--    them. It now travels Vendor → Partner: the vendor SEES the code on their
--    order, reads it to the Partner, and the Partner enters it. The proof is
--    the same — possession of a secret only the counterparty holds — and the
--    person who acts is the person whose next step depends on it.
--
-- 3. THE ASSIGNED PARTNER GETS THE CUSTOMER'S PHONE NUMBER, at assignment
--    rather than at handoff. A Partner who cannot find a room needs to ring
--    before they are holding the food, not after. This is the most sensitive
--    thing in the schema, so it is enforced in three independent places: the
--    RLS policy on users, the read model below, and the assignment itself.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Capacity: a slot, not a predicate
-- ---------------------------------------------------------------------------
-- "At most two" cannot be a unique index on partner_id the way "at most one"
-- could. So an active delivery holds a numbered SLOT, and the slot is what is
-- unique. Two concurrent claims that both computed slot 2 do not both succeed:
-- one of them violates this index and is turned into an ordinary "already
-- taken" by the exception handler in partner_accept_delivery.
--
-- The NOT EXISTS count in the claim is belt; this is braces. Neither is
-- decorative — the count is evaluated against a snapshot, and under READ
-- COMMITTED two transactions can both see one active delivery.
alter table public.orders add column if not exists partner_slot smallint;

alter table public.orders drop constraint if exists orders_partner_slot_range;
alter table public.orders add constraint orders_partner_slot_range
  check (partner_slot is null or partner_slot between 1 and 2);

drop index if exists public.orders_one_active_delivery_per_partner;

create unique index if not exists orders_partner_active_slot_unique
  on public.orders (partner_id, partner_slot)
  where partner_id is not null
    and partner_slot is not null
    and delivery_status in ('ASSIGNED', 'PICKED_UP');

comment on column public.orders.partner_slot is
  'Which of a Partner''s two concurrent delivery slots this order occupies. '
  'Unique per Partner while the delivery is active — that index IS the capacity '
  'limit. Retained after completion for the audit trail; the index ignores it '
  'there, so a finished delivery never blocks a new one.';

-- ---------------------------------------------------------------------------
-- 2. Offers
-- ---------------------------------------------------------------------------
create or replace function public.get_delivery_offers()
returns table (
  order_id uuid, order_number text, vendor_name text, vendor_location text,
  destination_zone text, walk_minutes integer, earnings_pesewas bigint,
  item_count bigint, ready_at timestamptz, food_is_ready boolean,
  order_type public.order_type
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o.id, o.order_number, v.name, public.location_path(v.location_id),
    -- ZONE, not the room. Every available Partner sees this list, and a student's
    -- room number is not something to broadcast to a pool of people who have not
    -- been given the job yet. The exact destination arrives with the assignment.
    coalesce(z.name, 'Campus'),
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    (o.order_type = 'FOOD'),
    o.order_type
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  where o.delivery_status = 'SEARCHING'
    and o.order_status = 'READY'
    and o.payment_status = 'PAID'
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- TWO AT A TIME. A Partner already carrying two is shown nothing, rather
    -- than shown offers that would be refused on acceptance.
    and (
      select count(*) from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    ) < 2
    and o.customer_id <> auth.uid()
    and v.owner_user_id is distinct from auth.uid()
  order by o.ready_at asc;
$$;

-- ---------------------------------------------------------------------------
-- 3. The atomic claim
-- ---------------------------------------------------------------------------
drop function if exists public.partner_accept_delivery(uuid);
create function public.partner_accept_delivery(p_order_id uuid)
returns table (success boolean, reason text, order_number text, vendor_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_slot    smallint;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- AUTHORISATION failures raise; a lost race returns. FIRST, and it must stay
  -- first: somebody who is not a Partner at all is told that, rather than being
  -- told about a conflict they could not have had.
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

  -- The lowest free slot. Racy on its own, which is precisely why the unique
  -- index exists and why the whole statement is wrapped in a handler.
  select s into v_slot
    from generate_series(1, 2) s
   where not exists (
     select 1 from public.orders a
      where a.partner_id = v_partner
        and a.partner_slot = s
        and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
   )
   order by s
   limit 1;

  if v_slot is null then
    return query select false,
      'You already have two active deliveries. Finish one first.'::text,
      null::text, null::text;
    return;
  end if;

  begin
    -- THE ATOMIC CLAIM. One statement checks every eligibility rule in its
    -- WHERE clause and claims the row in the same breath. Postgres serialises
    -- two racing UPDATEs on the row lock; the loser re-evaluates the WHERE
    -- against the winner's committed state, sees delivery_status is no longer
    -- SEARCHING, and matches zero rows.
    update public.orders o
       set partner_id = v_partner,
           partner_slot = v_slot,
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
       and (
         select count(*) from public.orders a
          where a.partner_id = v_partner
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < 2
       and o.customer_id <> v_partner
       and not exists (
         select 1 from public.vendors v
          where v.id = o.vendor_id and v.owner_user_id = v_partner
       )
    returning * into v_order;
  exception
    -- The slot was taken between the SELECT above and this UPDATE: this Partner
    -- accepted two offers at once and the index caught the second. Routine, and
    -- it reads to them exactly as losing a race to another Partner does.
    when unique_violation then
      perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
        'delivery_status', null, 'ASSIGNED', 'partner delivery slot already taken');
      return query select false,
        'You already have two active deliveries. Finish one first.'::text,
        null::text, null::text;
      return;
  end;

  -- Losing the race is ROUTINE, so it returns rather than raising. That keeps
  -- the rejection log committed instead of rolling it back.
  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text;
    return;
  end if;

  -- Fresh codes for this assignment. The version bump is what makes any earlier
  -- pickup code dead rather than merely unused.
  --
  -- THE PICKUP CODE IS NOT RETURNED TO THE PARTNER. It goes to the vendor, who
  -- reads it out at the counter; the Partner types in what they hear. Returning
  -- it here would hand the Partner both halves of the handoff proof.
  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now())
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED', null,
    jsonb_build_object('partner_slot', v_slot));

  return query
    select true, null::text, v_order.order_number, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;
revoke all on function public.partner_accept_delivery(uuid) from public;
grant execute on function public.partner_accept_delivery(uuid) to authenticated;

-- A released slot must actually be released, or a Partner who cancels twice
-- ends up permanently at capacity.
create or replace function public.partner_cancel_delivery(p_order_id uuid, p_reason text default null)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
begin
  update public.orders o
     set partner_id = null,
         partner_slot = null,
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

create or replace function public.admin_reassign_delivery(p_order_id uuid, p_reason text)
returns public.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  update public.orders
     set partner_id = null, partner_slot = null, delivery_status = 'SEARCHING',
         assigned_at = null, picked_up_at = null
   where id = p_order_id
     and fulfilment_type = 'DELIVERY'
     -- FAILED_CUSTOMER_ABSENT deliberately excluded: that Partner is owed money.
     and delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER')
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
    jsonb_build_object('previous_partner_id', v_before.partner_id, 'pickup_code_rotated', true));
  perform public.log_admin_action('DELIVERY_REASSIGN', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The pickup code, travelling the other way
-- ---------------------------------------------------------------------------
-- The VENDOR reads it. This is the only function that will ever show it to
-- them, and it shows it only while there is a Partner actually waiting.
create or replace function public.vendor_pickup_code(p_order_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
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
     and o.delivery_status = 'ASSIGNED';

  if v_code is null then
    raise exception 'no pickup code on this order right now'
      using errcode = 'no_data_found';
  end if;
  return v_code;
end;
$$;
revoke all on function public.vendor_pickup_code(uuid) from public;
grant execute on function public.vendor_pickup_code(uuid) to authenticated;

-- The PARTNER types it. Confirming the handoff is now the act of the person
-- who is about to walk away with somebody's dinner.
create or replace function public.partner_confirm_pickup(p_order_id uuid, p_pickup_code text)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner  uuid := auth.uid();
  v_assigned uuid;
  v_state    public.delivery_status;
  v_type     public.order_type;
  v_stored   text;
  v_order    public.orders%rowtype;
begin
  select o.partner_id, o.delivery_status, o.order_type
    into v_assigned, v_state, v_type
    from public.orders o
   where o.id = p_order_id;

  -- AUTHORISATION failure: raise. Covers the wrong Partner, an order with no
  -- Partner attached, and an order id that does not exist — all three get the
  -- same message, so probing tells the caller nothing.
  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'this delivery is not assigned to you' using errcode = 'insufficient_privilege';
  end if;

  -- A scan delivery has no food to hand over. Its equivalent moment is the
  -- redemption report, which is a different function and a different fact.
  if v_type = 'SCAN' then
    raise exception 'a scan delivery is collected by reporting the redemption'
      using errcode = 'check_violation';
  end if;

  select s.pickup_code into v_stored
    from public.order_secrets s where s.order_id = p_order_id;

  -- A rotated (NULL) code never matches, so a code from a cancelled assignment
  -- is worthless the moment the Partner walks away. A wrong code is logged as
  -- evidence — which is why this returns rather than raising.
  if v_stored is null or p_pickup_code is null or v_stored <> btrim(p_pickup_code) then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code did not match');
    return row(false, 'that pickup code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'PICKED_UP', picked_up_at = now()
   where o.id = p_order_id
     and o.delivery_status = 'ASSIGNED'
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
revoke all on function public.partner_confirm_pickup(uuid, text) from public;
grant execute on function public.partner_confirm_pickup(uuid, text) to authenticated;

-- The old direction goes. Leaving it would leave a second, working way to
-- confirm a handoff — one in which the vendor both holds the secret and
-- performs the act, which is exactly the thing the code exists to prevent.
drop function if exists public.vendor_confirm_pickup(uuid, text);
drop function if exists public.get_my_pickup_code(uuid);

-- ---------------------------------------------------------------------------
-- 5. Self-pickup has a code too
-- ---------------------------------------------------------------------------
-- The customer collecting their own order is still a handoff, and it still
-- needs to be more than "the person at the counter said it was theirs". Same
-- mechanism, different holders: the CUSTOMER holds the code, the VENDOR types
-- it in. Minted when the customer chooses to collect, so it exists before they
-- have paid and is on their screen when they walk over.
create or replace function public.customer_choose_fulfilment(
  p_order_id                uuid,
  p_fulfilment_type         public.fulfilment_type,
  p_destination_location_id uuid default null,
  p_destination_note        text default null
)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
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
      'order was not an accepted, unpaid food order');
    return row(false, 'this order is past the point of choosing')::public.transition_result;
  end if;

  if p_fulfilment_type = 'PICKUP' then
    update public.order_secrets
       set pickup_code = public.generate_numeric_code(4),
           pickup_code_version = pickup_code_version + 1,
           pickup_code_set_at = now()
     where order_secrets.order_id = p_order_id;
  else
    -- Switching back to delivery kills any collection code that was issued.
    update public.order_secrets
       set pickup_code = null,
           pickup_code_version = pickup_code_version + 1,
           pickup_code_set_at = null
     where order_secrets.order_id = p_order_id;
  end if;

  perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', true, 'CUSTOMER',
    null, null, p_fulfilment_type::text, null,
    jsonb_build_object(
      'delivery_fee_pesewas', v_delivery,
      'total_pesewas', v_order.total_pesewas));

  return row(true, null)::public.transition_result;
end;
$$;

-- Falling back to collection when no Partner turned up mints one too, for the
-- same reason: the customer is about to walk to a counter.
create or replace function public.customer_collect_instead(p_order_id uuid)
returns public.transition_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  update public.orders
     set delivery_status = 'NONE'
   where id = p_order_id
     and customer_id = auth.uid()
     and fulfilment_type = 'DELIVERY'
     and delivery_status in ('SEARCHING', 'FAILED_NO_PARTNER')
     and order_status = 'READY'
  returning * into v_order;

  if not found then
    return row(false, 'this order cannot be collected right now')::public.transition_result;
  end if;

  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now()
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'CUSTOMER_WILL_COLLECT', true, 'CUSTOMER',
    'delivery_status', 'SEARCHING', 'NONE',
    'customer chose to collect; delivery fee refund is an admin decision');

  return row(true, null)::public.transition_result;
end;
$$;

-- The customer's own collection code, for the screen that shows it.
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
     and o.customer_id = auth.uid()
     -- Only for an order they are actually collecting. A delivery order's
     -- pickup code belongs to the vendor and the Partner, never to them.
     and o.fulfilment_type = 'PICKUP'
     and o.payment_status = 'PAID';

  if v_code is null then
    raise exception 'no collection code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;
revoke all on function public.get_my_pickup_code(uuid) from public;
grant execute on function public.get_my_pickup_code(uuid) to authenticated;

-- The vendor verifies it at the counter.
drop function if exists public.vendor_complete_pickup_order(uuid);
create function public.vendor_complete_pickup_order(p_order_id uuid, p_pickup_code text)
returns public.transition_result
language plpgsql
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

  select s.pickup_code into v_stored
    from public.order_secrets s where s.order_id = p_order_id;

  if v_stored is null or p_pickup_code is null or v_stored <> btrim(p_pickup_code) then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'collection code did not match');
    return row(false, 'that collection code does not match')::public.transition_result;
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
revoke all on function public.vendor_complete_pickup_order(uuid, text) from public;
grant execute on function public.vendor_complete_pickup_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. The customer's phone number
-- ---------------------------------------------------------------------------
-- THE PHONE NUMBER RULE, restated because it moved: the assigned Partner may
-- read the customer's row from ASSIGNMENT until the delivery ends. Not before —
-- the offer list shows a zone, never a person — and NOT AFTERWARDS. A completed
-- delivery leaves no standing access to anybody's number; if support needs it
-- later, that is an admin looking at an admin screen, which is a different
-- authorisation with an audit trail behind it.
drop policy if exists users_read_customer_during_active_delivery on public.users;
create policy users_read_customer_during_active_delivery on public.users
  for select to authenticated
  using (
    exists (
      select 1 from public.orders o
       where o.customer_id = public.users.id
         and o.partner_id = auth.uid()
         and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
  );

-- Up to two, so this returns a SET rather than at most one row. Everything a
-- Partner needs to actually run the errand, and nothing they do not.
drop function if exists public.partner_active_delivery();
create function public.partner_active_delivery()
returns table (
  order_id uuid, order_number text, partner_slot smallint,
  delivery_status public.delivery_status,
  vendor_name text, vendor_location text, vendor_phone text,
  destination_zone text, destination text, destination_note text,
  customer_name text, customer_phone text,
  earnings_pesewas bigint, item_count bigint,
  assigned_at timestamptz, picked_up_at timestamptz,
  customer_absent_reported_at timestamptz, seconds_until_absent_allowed integer,
  order_type public.order_type, scan_status public.scan_status
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.partner_slot,
         o.delivery_status,
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
revoke all on function public.partner_active_delivery() from public;
grant execute on function public.partner_active_delivery() to authenticated;

-- The vendor's board gains the pickup code's existence — not the code, which
-- has its own function and its own check.
drop function if exists public.vendor_order_detail(uuid);
create function public.vendor_order_detail(p_order_id uuid)
returns table (
  order_id uuid, order_number text, vendor_id uuid, bucket text,
  order_status public.order_status, payment_status public.payment_status,
  delivery_status public.delivery_status, fulfilment_type public.fulfilment_type,
  subtotal_pesewas bigint, service_fee_pesewas bigint, delivery_fee_pesewas bigint,
  total_pesewas bigint, submitted_at timestamptz, accept_deadline_at timestamptz,
  seconds_to_deadline integer, age_seconds integer, accepted_at timestamptz,
  preparing_at timestamptz, ready_at timestamptz, completed_at timestamptz,
  destination_zone text, partner_assigned boolean, partner_name text,
  pickup_code_available boolean, cancellation_reason text, items jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
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
         o.accept_deadline_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         -- ZONE ONLY. The room number never leaves the database for a vendor.
         case when o.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = o.destination_zone_id) end,
         o.partner_id is not null,
         p.full_name,
         (o.delivery_status = 'ASSIGNED'),
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
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;
grant execute on function public.vendor_order_detail(uuid) to authenticated;
