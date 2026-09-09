-- ============================================================================
-- FOUR-DIGIT HANDOFF CODES, AND THE THING THAT MAKES FOUR DIGITS SAFE
-- ============================================================================
-- All three codes are already exactly four digits, generated server-side from
-- gen_random_bytes and stored under a CHECK that admits nothing else. What was
-- missing is the other half of the argument: four digits is ten thousand
-- guesses, and ten thousand guesses is minutes of scripted requests.
--
-- So each side of the handoff now counts its failures and locks out. The
-- counters live on order_secrets, which no client role can read or write, and
-- they are reset by success and by a fresh code — a new assignment starts a new
-- Partner on a clean slate rather than inheriting the last one's failures.
--
-- WHO IS BEING SLOWED DOWN. Only somebody who is already authorised to attempt:
-- a wrong Partner is refused before a code is even compared, and an unauthorised
-- caller never reaches the counter. This is not a substitute for the
-- authorisation checks; it is what stops the RIGHT actor brute-forcing a code
-- they were not told.

alter table public.order_secrets
  add column if not exists pickup_attempts    integer     not null default 0,
  add column if not exists pickup_locked_until   timestamptz,
  add column if not exists delivery_attempts  integer     not null default 0,
  add column if not exists delivery_locked_until timestamptz;

alter table public.order_secrets drop constraint if exists order_secrets_attempts_nonneg;
alter table public.order_secrets
  add constraint order_secrets_attempts_nonneg
  check (pickup_attempts >= 0 and delivery_attempts >= 0);

comment on column public.order_secrets.pickup_attempts is
  'Consecutive wrong pickup codes. Reset by a correct one and by a newly generated code. Server-only, like everything else on this table.';
comment on column public.order_secrets.delivery_attempts is
  'Consecutive wrong delivery codes. Reset by a correct one.';

alter table public.pricing_config
  add column if not exists code_attempt_limit  integer not null default 5,
  add column if not exists code_lockout_seconds integer not null default 300;

alter table public.pricing_config drop constraint if exists pricing_config_code_attempt_limit_check;
alter table public.pricing_config
  add constraint pricing_config_code_attempt_limit_check
  check (code_attempt_limit >= 3 and code_attempt_limit <= 20);

alter table public.pricing_config drop constraint if exists pricing_config_code_lockout_seconds_check;
alter table public.pricing_config
  add constraint pricing_config_code_lockout_seconds_check
  check (code_lockout_seconds >= 30 and code_lockout_seconds <= 3600);

comment on column public.pricing_config.code_attempt_limit is
  'Wrong handoff codes tolerated before a lockout. Five, because a counter is noisy and somebody mishearing a digit twice is normal.';
comment on column public.pricing_config.code_lockout_seconds is
  'How long a locked-out handoff stays locked. Long enough to make scripting a four-digit code hopeless, short enough that a genuine mistake is not a ruined delivery.';

-- ---------------------------------------------------------------------------
-- One place that decides
-- ---------------------------------------------------------------------------
-- Three call sites compare a code. Each of them had its own three lines of
-- "is it null, is it equal"; they now share one function so the lockout cannot
-- be applied to two of the three and forgotten on the last.
--
-- Returns one of: 'OK', 'LOCKED', 'MISMATCH'. It writes — a counter that only
-- counted when the caller remembered to would count nothing.

create or replace function public.check_handoff_code(
  p_order_id uuid,
  p_kind     text,       -- 'PICKUP' | 'DELIVERY'
  p_supplied text
) returns text
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_stored  text;
  v_tries   integer;
  v_locked  timestamptz;
  v_limit   integer;
  v_seconds integer;
begin
  select code_attempt_limit, code_lockout_seconds into v_limit, v_seconds
    from public.pricing_config where id;
  v_limit   := coalesce(v_limit, 5);
  v_seconds := coalesce(v_seconds, 300);

  if p_kind = 'PICKUP' then
    select s.pickup_code, s.pickup_attempts, s.pickup_locked_until
      into v_stored, v_tries, v_locked
      from public.order_secrets s where s.order_id = p_order_id
      for update;
  else
    select s.delivery_code, s.delivery_attempts, s.delivery_locked_until
      into v_stored, v_tries, v_locked
      from public.order_secrets s where s.order_id = p_order_id
      for update;
  end if;

  if not found then
    return 'MISMATCH';
  end if;

  -- Locked out. Checked BEFORE the comparison, so a lockout is not a free
  -- oracle that tells an attacker when they have finally guessed right.
  if v_locked is not null and v_locked > now() then
    return 'LOCKED';
  end if;

  -- The lockout has expired: the slate is clean, and the next wrong answer
  -- starts counting again from one.
  if v_locked is not null then
    v_tries := 0;
    if p_kind = 'PICKUP' then
      update public.order_secrets
         set pickup_attempts = 0, pickup_locked_until = null
       where order_id = p_order_id;
    else
      update public.order_secrets
         set delivery_attempts = 0, delivery_locked_until = null
       where order_id = p_order_id;
    end if;
  end if;

  -- A rotated (NULL) code never matches, so a code from a cancelled assignment
  -- is worthless the moment the Partner walks away.
  if v_stored is not null and p_supplied is not null
     and v_stored = btrim(p_supplied) then
    if p_kind = 'PICKUP' then
      update public.order_secrets
         set pickup_attempts = 0, pickup_locked_until = null
       where order_id = p_order_id;
    else
      update public.order_secrets
         set delivery_attempts = 0, delivery_locked_until = null
       where order_id = p_order_id;
    end if;
    return 'OK';
  end if;

  v_tries := v_tries + 1;

  if p_kind = 'PICKUP' then
    update public.order_secrets
       set pickup_attempts = v_tries,
           pickup_locked_until = case when v_tries >= v_limit
                                      then now() + make_interval(secs => v_seconds) end
     where order_id = p_order_id;
  else
    update public.order_secrets
       set delivery_attempts = v_tries,
           delivery_locked_until = case when v_tries >= v_limit
                                        then now() + make_interval(secs => v_seconds) end
     where order_id = p_order_id;
  end if;

  return case when v_tries >= v_limit then 'LOCKED' else 'MISMATCH' end;
end;
$$;

alter function public.check_handoff_code(uuid, text, text) owner to postgres;
comment on function public.check_handoff_code(uuid, text, text) is
  'Compares a supplied handoff code and counts the failure. SERVER-ONLY: no client role may call it, because a client that could would have an oracle for the code it is meant to be told out loud.';
revoke all on function public.check_handoff_code(uuid, text, text) from public;
grant execute on function public.check_handoff_code(uuid, text, text) to service_role;

-- A fresh assignment is a fresh slate. Folded into the claim rather than left
-- to a separate call so it cannot be missed.
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

alter function public.partner_accept_delivery(uuid) owner to postgres;

-- ---------------------------------------------------------------------------
-- The three comparisons
-- ---------------------------------------------------------------------------

-- VENDOR reads out, PARTNER types in.
create or replace function public.partner_confirm_pickup(p_order_id uuid, p_pickup_code text)
  returns public.transition_result
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_partner  uuid := auth.uid();
  v_assigned uuid;
  v_state    public.delivery_status;
  v_type     public.order_type;
  v_check    text;
  v_order    public.orders%rowtype;
begin
  select o.partner_id, o.delivery_status, o.order_type
    into v_assigned, v_state, v_type
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

alter function public.partner_confirm_pickup(uuid, text) owner to postgres;

-- CUSTOMER reads out, PARTNER types in.
create or replace function public.partner_complete_delivery(p_order_id uuid, p_delivery_code text)
  returns public.transition_result
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_partner  uuid := auth.uid();
  v_order    public.orders%rowtype;
  v_check    text;
  v_assigned uuid;
  v_state    public.delivery_status;
begin
  select o.partner_id, o.delivery_status
    into v_assigned, v_state
    from public.orders o
   where o.id = p_order_id;

  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  -- STATE failure: the rightful Partner, at the wrong moment. Routine, so it is
  -- logged and returned rather than raised — a replayed completion is evidence,
  -- and evidence that rolls itself back is no evidence at all. Checked before
  -- the code, so a replay does not burn an attempt.
  if v_state <> 'PICKED_UP' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', v_state::text, 'DELIVERED',
      'order is not awaiting delivery completion');
    return row(false, 'this delivery is not awaiting completion')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'DELIVERY', p_delivery_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', 'PICKED_UP', 'DELIVERED', 'delivery code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask for the code again')::public.transition_result;
  end if;

  -- A Partner cannot simply declare "delivered": the customer holds the code.
  if v_check <> 'OK' then
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

alter function public.partner_complete_delivery(uuid, text) owner to postgres;

-- CUSTOMER reads out, VENDOR types in. Same rule, third direction.
create or replace function public.vendor_complete_pickup_order(p_order_id uuid, p_pickup_code text)
  returns public.transition_result
  language plpgsql security definer
  set search_path to ''
as $$
declare
  v_order  public.orders%rowtype;
  v_check  text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'collection code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes and try again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
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

alter function public.vendor_complete_pickup_order(uuid, text) owner to postgres;
