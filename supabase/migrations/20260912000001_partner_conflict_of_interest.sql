-- ============================================================================
-- Partner conflict of interest
-- ============================================================================
-- Two rules, agreed as policy:
--
--   1. A Partner may not deliver an order they placed themselves.
--   2. A Partner may not deliver an order from a vendor they are staff of.
--
-- Both exist because a Partner is MANUALLY APPROVED by an administrator, and
-- that approval is the only control standing behind a delivery. The handoff is
-- proved by two 4-digit codes: the vendor releases the food against the pickup
-- code, and the customer releases the delivery against the delivery code. When
-- the Partner is also the customer, or also the person behind the counter, they
-- hold both halves of the proof and the control collapses — a delivery could be
-- recorded, and earned, without anything having moved.
--
-- Nothing new is needed to know this. orders.customer_id is on the row being
-- claimed, and vendor_users already says who works for which vendor. So this
-- adds no table, no column and no policy: it is two predicates, applied in the
-- two places dispatch decides anything.
--
-- WHERE THE RULES GO, and why in both places:
--
--   get_delivery_offers()     so a conflicted order is never even shown. An
--                             offer a Partner cannot accept is a bug in the UI
--                             whichever way it is refused.
--
--   partner_accept_delivery() twice, deliberately:
--                             * an explicit pre-check that RAISES, because a
--                               policy violation is an authorisation failure,
--                               not a lost race (hard rule 9). This mirrors the
--                               is_approved_partner() check exactly.
--                             * the same predicates inside the atomic claim, so
--                               there is no window between checking and
--                               claiming. This mirrors how the availability
--                               check is already duplicated.
--
-- CHECK ORDER IS LOAD-BEARING. is_approved_partner() stays FIRST. Someone who
-- is not a Partner at all must be told that, not told about a conflict — and
-- tests/vendor.test.js asserts precisely that message for a vendor who tries to
-- assign themselves.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- get_delivery_offers — conflicted orders are not offered
-- ---------------------------------------------------------------------------
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
    -- CONFLICT OF INTEREST 1: never your own order.
    and o.customer_id <> auth.uid()
    -- CONFLICT OF INTEREST 2: never a vendor you work for.
    --
    -- Read straight from vendor_users rather than through my_vendor_ids(),
    -- which also filters out suspended users. That extra condition is harmless
    -- here but it would fold a second rule into this one, and this predicate
    -- should say exactly what the policy says and nothing else.
    and not exists (
      select 1 from public.vendor_users vu
       where vu.vendor_id = o.vendor_id and vu.user_id = auth.uid()
    )
  order by o.ready_at asc;
$$;

-- ---------------------------------------------------------------------------
-- partner_accept_delivery — refuse a conflicted claim, by id or otherwise
-- ---------------------------------------------------------------------------
-- Hiding an offer is presentation. This is the control: a Partner who knows an
-- order id must still be refused.
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
  --
  -- FIRST, and it must stay first: somebody who is not a Partner at all is told
  -- that, rather than being told about a conflict they could not have had.
  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  -- CONFLICT OF INTEREST. Also authorisation failures, so also raised: this is
  -- a Partner attempting something policy forbids, not one losing a race.
  --
  -- Neither message tells the caller anything they did not already know — that
  -- an order is theirs, or that they work for a vendor.
  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
      from public.orders o
      join public.vendor_users vu on vu.vendor_id = o.vendor_id
     where o.id = p_order_id and vu.user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a vendor you work for'
      using errcode = 'insufficient_privilege';
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
  --
  -- The two conflict rules are repeated here for the same reason. The checks
  -- above ran in an earlier statement; a staff row inserted in between would
  -- otherwise slip through the gap.
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
     and o.customer_id <> v_partner
     and not exists (
       select 1 from public.vendor_users vu
        where vu.vendor_id = o.vendor_id and vu.user_id = v_partner
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
