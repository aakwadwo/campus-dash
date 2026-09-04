-- ============================================================================
-- partner_complete_delivery — separate the state check from the auth check
-- ============================================================================
-- HARD RULE 9: transitions return { success, reason } for STATE and CONTENTION
-- failures, and RAISE only for AUTHORISATION failures. Logging-then-raising
-- would roll the log back, so a rejection must not raise.
--
-- This function's first guard broke that by folding two different questions
-- into one EXISTS:
--
--     where id = p_order_id and partner_id = v_partner and delivery_status = 'PICKED_UP'
--     → raise 'you are not carrying this delivery' (insufficient_privilege)
--
-- "Is this your delivery?" is authorisation. "Is it awaiting completion?" is
-- state. Merging them meant the RIGHTFUL Partner re-submitting on an order that
-- was already DELIVERED — a double tap, a retried request, a stale screen — got
-- an insufficient_privilege error saying they were not carrying a delivery they
-- had in fact just completed. Worse, because it raised, the rejection was never
-- recorded: order_events lost every replay, which is exactly the evidence the
-- log exists to keep.
--
-- vendor_confirm_pickup() already gets this right, returning
-- 'order is not awaiting pickup' as a soft envelope. This brings its
-- counterpart into line.
--
-- WHAT CHANGES: the first guard, and nothing else.
--
--   * NOT the assigned Partner (wrong Partner, unassigned order, or no such
--     order) → still RAISES insufficient_privilege, with the same message. The
--     security boundary is unchanged, and a caller still cannot tell a
--     nonexistent order from somebody else's.
--   * IS the assigned Partner but the state is not PICKED_UP → soft envelope,
--     and the rejected transition is LOGGED like every other rejection.
--
-- WHAT DOES NOT CHANGE: the delivery code check, the atomic conditional UPDATE
-- and its state guard, settle_partner_earnings(), the success log, the return
-- shape, the delivery state machine, Partner eligibility, the own-order and
-- vendor-staff exclusions, payment, settlement, payouts, RLS, admin
-- authorisation and the scheduler. Everything below the first guard is
-- byte-for-byte what it was.
-- ============================================================================

create or replace function public.partner_complete_delivery(p_order_id uuid, p_delivery_code text)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_partner  uuid := auth.uid();
  v_order    public.orders%rowtype;
  v_stored   text;
  v_assigned uuid;
  v_state    public.delivery_status;
begin
  select o.partner_id, o.delivery_status
    into v_assigned, v_state
    from public.orders o
   where o.id = p_order_id;

  -- AUTHORISATION failure: raise. Covers the wrong Partner, an order with no
  -- Partner attached, and an order id that does not exist — all three get the
  -- same message, so probing tells the caller nothing.
  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  -- STATE failure: the rightful Partner, at the wrong moment. Routine, so it is
  -- logged and returned rather than raised — a replayed completion is evidence,
  -- and evidence that rolls itself back is no evidence at all.
  if v_state <> 'PICKED_UP' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', v_state::text, 'DELIVERED',
      'order is not awaiting delivery completion');
    return row(false, 'this delivery is not awaiting completion')::public.transition_result;
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

-- CREATE OR REPLACE keeps existing privileges; restated so the grant is visible
-- beside the function rather than only in a Phase 2 migration.
revoke execute on function public.partner_complete_delivery(uuid, text) from public, anon;
grant  execute on function public.partner_complete_delivery(uuid, text) to authenticated;
