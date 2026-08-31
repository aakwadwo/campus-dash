-- ============================================================================
-- Delivery lifecycle: the Partner's job, customer absence, disputes
-- ============================================================================

-- --- Absence and disputes ---------------------------------------------------
-- Timestamps, not booleans. "The customer is not answering" is a claim made at
-- a moment, and the whole safeguard is that a Partner must WAIT after making it
-- before the claim can become an outcome.
alter table public.orders
  add column if not exists customer_absent_reported_at timestamptz,
  add column if not exists disputed_at                 timestamptz,
  add column if not exists dispute_reason              text,
  add column if not exists dispute_resolved_at         timestamptz;

create index if not exists orders_disputed_idx on public.orders (disputed_at)
  where disputed_at is not null and dispute_resolved_at is null;

-- How long a Partner must wait between reporting an absent customer and being
-- allowed to give up. Long enough for someone to come downstairs; short enough
-- that a Partner is not trapped.
alter table public.pricing_config
  add column if not exists customer_absent_wait_seconds integer not null default 300
    check (customer_absent_wait_seconds > 0);

-- ---------------------------------------------------------------------------
-- The Partner's current job
-- ---------------------------------------------------------------------------
-- THE PRIVACY RULE LIVES HERE. Before the vendor confirms handoff the Partner
-- sees the ZONE. After it, they see the room and the customer's phone, because
-- they now need to find a person.
--
-- Doing this in the database rather than the page means the room number never
-- crosses the wire early, whatever a screen decides to render.
create or replace function public.partner_active_delivery()
returns table (
  order_id            uuid,
  order_number        text,
  delivery_status     public.delivery_status,
  vendor_name         text,
  vendor_location     text,
  vendor_phone        text,
  destination_zone    text,
  destination         text,
  destination_note    text,
  customer_name       text,
  customer_phone      text,
  earnings_pesewas    bigint,
  item_count          bigint,
  assigned_at         timestamptz,
  picked_up_at        timestamptz,
  customer_absent_reported_at timestamptz,
  seconds_until_absent_allowed integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id,
         o.order_number,
         o.delivery_status,
         v.name,
         public.location_path(v.location_id),
         -- The vendor's phone is operational, not private: the Partner may need
         -- to say they are running late.
         v.phone,
         coalesce(z.name, 'Campus'),
         -- Released only after the vendor confirms handoff.
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then public.location_path(o.destination_location_id) end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then o.destination_note end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.full_name end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.phone end,
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
              ) end
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    join public.users c on c.id = o.customer_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;

-- A Partner's completed work, for their own record. No customer details: the
-- job is over, so the need to reach that person is over too.
create or replace function public.partner_delivery_history(p_limit integer default 30)
returns table (
  order_id         uuid,
  order_number     text,
  vendor_name      text,
  destination_zone text,
  delivery_status  public.delivery_status,
  earnings_pesewas bigint,
  delivered_at     timestamptz,
  paid_out         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.order_number, v.name, coalesce(z.name, 'Campus'), o.delivery_status,
         o.partner_earnings_pesewas, o.delivered_at,
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

-- What a Partner has earned, and what is still owed.
create or replace function public.partner_earnings_summary()
returns table (
  delivered_count  bigint,
  earned_pesewas   bigint,
  awaiting_pesewas bigint,
  settled_pesewas  bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where a.status is not null),
         coalesce(sum(a.amount_pesewas), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status <> 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint
    from public.allocations a
   where a.payee_type = 'PARTNER' and a.payee_id = auth.uid()
     and a.status <> 'CANCELLED';
$$;

-- ---------------------------------------------------------------------------
-- Customer absence
-- ---------------------------------------------------------------------------
-- Two steps on purpose. A Partner cannot arrive, tap "absent" and walk away
-- with the food and the fee — the first call only starts a clock.
create or replace function public.partner_report_customer_absent(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and partner_id = auth.uid();

  if not found then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;
  if v_order.delivery_status <> 'PICKED_UP' then
    return row(false, 'you can only report this once you are carrying the order')::public.transition_result;
  end if;
  if v_order.customer_absent_reported_at is not null then
    return row(true, 'already reported')::public.transition_result;
  end if;

  update public.orders set customer_absent_reported_at = now() where id = p_order_id;

  perform public.log_order_event(p_order_id, 'CUSTOMER_ABSENT_REPORTED', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'PICKED_UP',
    'partner reports the customer is not responding');

  return row(true, null)::public.transition_result;
end;
$$;

-- Only after the wait. The server checks the clock; the Partner's phone does
-- not get a vote.
create or replace function public.partner_confirm_customer_absent(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order  public.orders%rowtype;
  v_wait   integer;
  v_result public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and partner_id = auth.uid();
  if not found then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  if v_order.customer_absent_reported_at is null then
    return row(false, 'report that the customer is not responding first')::public.transition_result;
  end if;

  select customer_absent_wait_seconds into v_wait from public.pricing_config where id;

  if now() < v_order.customer_absent_reported_at + make_interval(secs => v_wait) then
    return row(
      false,
      format('please keep waiting — you can close this %s seconds after reporting',  v_wait)
    )::public.transition_result;
  end if;

  update public.orders
     set delivery_status = 'FAILED_CUSTOMER_ABSENT', delivered_at = null
   where id = p_order_id and delivery_status = 'PICKED_UP'
  returning * into v_result;

  if not found then
    return row(false, 'this delivery is no longer in progress')::public.transition_result;
  end if;

  -- The Partner did the work: they collected the food and travelled. The
  -- earning stands, and the food question becomes an admin matter.
  perform public.settle_partner_earnings(p_order_id);

  perform public.log_order_event(p_order_id, 'DELIVERY_FAILED_CUSTOMER_ABSENT', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'FAILED_CUSTOMER_ABSENT',
    'customer did not respond within the waiting period');

  return row(true, null)::public.transition_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Disputes
-- ---------------------------------------------------------------------------
-- Records a claim. Deliberately changes NO money or delivery state: a dispute
-- is an assertion, and acting on an assertion automatically is how a system
-- gets played.
create or replace function public.customer_dispute_delivery(p_order_id uuid, p_reason text)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and customer_id = auth.uid();
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    return row(false, 'please tell us what went wrong')::public.transition_result;
  end if;
  if v_order.disputed_at is not null and v_order.dispute_resolved_at is null then
    return row(true, 'already reported')::public.transition_result;
  end if;
  if v_order.payment_status <> 'PAID' then
    return row(false, 'there is nothing to dispute on an unpaid order')::public.transition_result;
  end if;

  update public.orders
     set disputed_at = now(), dispute_reason = btrim(p_reason), dispute_resolved_at = null
   where id = p_order_id;

  perform public.log_order_event(p_order_id, 'DISPUTE_RAISED', true, 'CUSTOMER',
    null, null, null, btrim(p_reason));

  return row(true, null)::public.transition_result;
end;
$$;

create or replace function public.admin_resolve_dispute(
  p_order_id uuid,
  p_reason   text,
  p_notes    text default null
)
returns public.orders
language plpgsql
volatile
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
  if not found or v_before.disputed_at is null then
    raise exception 'no open dispute on this order' using errcode = 'no_data_found';
  end if;

  update public.orders set dispute_resolved_at = now() where id = p_order_id
  returning * into v_after;

  perform public.log_order_event(p_order_id, 'DISPUTE_RESOLVED', true, 'ADMIN',
    null, null, null, p_notes);
  perform public.log_admin_action('DISPUTE_RESOLVE', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.partner_active_delivery() from public, anon;
revoke execute on function public.partner_delivery_history(integer) from public, anon;
revoke execute on function public.partner_earnings_summary() from public, anon;
revoke execute on function public.partner_report_customer_absent(uuid) from public, anon;
revoke execute on function public.partner_confirm_customer_absent(uuid) from public, anon;
revoke execute on function public.customer_dispute_delivery(uuid, text) from public, anon;
revoke execute on function public.admin_resolve_dispute(uuid, text, text) from public, anon;

grant execute on function public.partner_active_delivery()               to authenticated;
grant execute on function public.partner_delivery_history(integer)       to authenticated;
grant execute on function public.partner_earnings_summary()              to authenticated;
grant execute on function public.partner_report_customer_absent(uuid)    to authenticated;
grant execute on function public.partner_confirm_customer_absent(uuid)   to authenticated;
grant execute on function public.customer_dispute_delivery(uuid, text)   to authenticated;
grant execute on function public.admin_resolve_dispute(uuid, text, text) to authenticated;
