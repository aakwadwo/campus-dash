-- ============================================================================
-- CONFIGURABLE PARTNER CAPACITY
-- ============================================================================
-- Two concurrent deliveries was a number in three places: a CHECK constraint, a
-- generate_series, and a count in the claim's WHERE. It is now one number in
-- pricing_config, and the three places read it.
--
-- WHAT DOES NOT CHANGE IS THE GUARANTEE. orders_partner_active_slot_unique is
-- still what actually enforces the limit — a unique index cannot be raced. The
-- configured maximum decides how many slots there are to compete for; the index
-- decides that two claims never get the same one. Reading a number from a table
-- is not an atomicity primitive and is not being asked to be one.
--
-- LOWERING THE LIMIT DOES NOT STRAND ANYBODY. A Partner already carrying three
-- when the maximum drops to two keeps all three: the claim's count check
-- refuses only NEW acceptances, and the slot index ignores finished deliveries.
-- They come back under the limit by finishing what they have.

alter table public.pricing_config
  add column if not exists max_active_deliveries_per_partner smallint not null default 2;

alter table public.pricing_config
  drop constraint if exists pricing_config_max_active_deliveries_check;
alter table public.pricing_config
  add constraint pricing_config_max_active_deliveries_check
  check (max_active_deliveries_per_partner >= 1 and max_active_deliveries_per_partner <= 10);

comment on column public.pricing_config.max_active_deliveries_per_partner is
  'How many deliveries one Partner may carry at once. Default 2. The ceiling of 10 is a guard against a typo emptying the offer board into one person''s hands, not a product opinion.';

-- The slot range widens to the configurable ceiling. It stays a CHECK rather
-- than becoming a lookup: a constraint that reads another table is not a
-- constraint, it is a trigger with worse failure modes.
alter table public.orders drop constraint if exists orders_partner_slot_range;
alter table public.orders
  add constraint orders_partner_slot_range
  check (partner_slot is null or (partner_slot >= 1 and partner_slot <= 10));

comment on column public.orders.partner_slot is
  'Which of a Partner''s concurrent delivery slots this order occupies. Unique per Partner while the delivery is active — that index IS the capacity limit; pricing_config.max_active_deliveries_per_partner decides how many slots exist. Retained after completion for the audit trail; the index ignores it there, so a finished delivery never blocks a new one.';

create or replace function public.partner_accept_delivery(p_order_id uuid)
  returns table(success boolean, reason text, order_number text, vendor_name text)
  language plpgsql security definer
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

  -- READ AT CLAIM TIME, not cached anywhere. An administrator who changes the
  -- maximum changes the next acceptance attempt, not the next deployment.
  select max_active_deliveries_per_partner into v_max from public.pricing_config where id;
  v_max := coalesce(v_max, 2);

  v_full := case
    when v_max = 1 then 'You already have an active delivery. Finish it first.'
    else 'You already have ' || v_max || ' active deliveries. Finish one first.'
  end;

  -- The lowest free slot. Racy on its own, which is precisely why the unique
  -- index exists and why the whole statement is wrapped in a handler.
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
       -- Belt. The index below is braces, and it is the one that cannot be
       -- raced. Both read the same configured maximum.
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
    -- The slot was taken between the SELECT above and this UPDATE: this Partner
    -- accepted two offers at once and the index caught the second. Routine, and
    -- it reads to them exactly as losing a race to another Partner does.
    when unique_violation then
      perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
        'delivery_status', null, 'ASSIGNED', 'partner delivery slot already taken');
      return query select false, v_full, null::text, null::text;
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

alter function public.partner_accept_delivery(uuid) owner to postgres;


-- ---------------------------------------------------------------------------
-- The admin control
-- ---------------------------------------------------------------------------
-- One more optional parameter on the function that already edits every other
-- operational number, so the change is audited in admin_actions exactly like a
-- fee change is. The old signature is dropped rather than left beside the new
-- one: two overloads differing only by a trailing default is how a caller ends
-- up ambiguous.

drop function if exists public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint);

create or replace function public.admin_update_config(
  p_reason                          text,
  p_service_fee_bps                 integer  default null,
  p_delivery_fee_pesewas            bigint   default null,
  p_partner_share_of_delivery_bps   integer  default null,
  p_vendor_response_seconds         integer  default null,
  p_partner_search_seconds          integer  default null,
  p_customer_absent_wait_seconds    integer  default null,
  p_payment_pending_timeout_seconds integer  default null,
  p_min_payout_pesewas              bigint   default null,
  p_notification_retry_limit        integer  default null,
  p_vendor_poll_seconds             integer  default null,
  p_partner_poll_seconds            integer  default null,
  p_customer_poll_seconds           integer  default null,
  p_scan_service_fee_pesewas        bigint   default null,
  p_max_active_deliveries_per_partner smallint default null
) returns public.pricing_config
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_max_active_deliveries_per_partner is not null
     and (p_max_active_deliveries_per_partner < 1 or p_max_active_deliveries_per_partner > 10) then
    raise exception 'a Partner may carry between 1 and 10 deliveries at once'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.pricing_config where id;

  update public.pricing_config
     set service_fee_bps                 = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas            = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps   = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds         = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds          = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds    = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas              = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit        = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds             = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds            = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds),
         scan_service_fee_pesewas        = coalesce(p_scan_service_fee_pesewas, scan_service_fee_pesewas),
         max_active_deliveries_per_partner =
           coalesce(p_max_active_deliveries_per_partner, max_active_deliveries_per_partner),
         updated_at                      = now()
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;

alter function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint) owner to postgres;
revoke all on function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint) from public;
grant execute on function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint, smallint) to authenticated;

-- ---------------------------------------------------------------------------
-- What a Partner is told
-- ---------------------------------------------------------------------------
-- The offer board needs to know how many slots are free before it offers a
-- button that will be refused. This is a display fact, not a permission: the
-- claim re-derives everything for itself.

create or replace function public.partner_capacity()
  returns table(max_active integer, active_now integer, slots_free integer)
  language sql stable security definer
  set search_path to ''
as $$
  select c.max_active_deliveries_per_partner::integer,
         v.live::integer,
         greatest(0, c.max_active_deliveries_per_partner - v.live)::integer
    from public.pricing_config c
    cross join lateral (
      select count(*)::integer as live
        from public.orders o
       where o.partner_id = auth.uid()
         and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
    ) v
   where c.id and auth.uid() is not null;
$$;

alter function public.partner_capacity() owner to postgres;
comment on function public.partner_capacity() is
  'How many deliveries this Partner may hold and how many they hold now. For display only — partner_accept_delivery() re-checks both, and the unique slot index is what actually enforces the limit.';
revoke all on function public.partner_capacity() from public;
grant execute on function public.partner_capacity() to authenticated;
