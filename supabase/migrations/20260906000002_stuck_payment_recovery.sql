-- ============================================================================
-- Stuck payment recovery
-- ============================================================================
-- THE BUG THIS FIXES
--
-- A payment moves to PENDING the moment we ask the provider to collect. If the
-- provider's callback never arrives — the customer closed the tab mid-payment,
-- the webhook was lost, the provider had an outage — the payment stays PENDING
-- for ever, and so does the order.
--
-- That is not a cosmetic stall. A partial unique index allows only ONE live
-- payment intent per order, so the customer cannot retry. The vendor has
-- accepted and cannot cook. The order is dead, and nothing in the system was
-- going to notice.
--
-- Found while auditing for stuck states: every other timeout had a sweep, and
-- this one did not.
--
-- The sweep marks the payment FAILED and returns the order to ACCEPTED/FAILED,
-- which is a state the customer can already retry from. It deliberately does
-- NOT cancel the order: the vendor accepted in good faith, and the food is
-- still wanted.
-- ============================================================================

create or replace function public.expire_stale_payments()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_count   integer := 0;
  v_payment record;
begin
  perform public.assert_service_or_admin();

  select * into v_cfg from public.pricing_config where id;

  for v_payment in
    select p.id, p.order_id
      from public.payments p
     where p.status = 'PENDING'
       and p.created_at < now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds)
  loop
    -- Reuses fail_payment() rather than writing the states here, so there is
    -- exactly one implementation of "this payment did not happen".
    perform public.fail_payment(
      v_payment.id,
      'no confirmation from the payment provider within the timeout'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.expire_stale_payments() from public, anon, authenticated;

-- Every fifteen minutes: often enough that a customer is not left staring at a
-- spinner, rare enough that it never races a callback that is merely slow.
select cron.schedule(
  'campus-dash-expire-stale-payments',
  '*/15 * * * *',
  $$ select public.expire_stale_payments(); $$
);

-- ---------------------------------------------------------------------------
-- Let a customer give up on a payment that is clearly not coming
-- ---------------------------------------------------------------------------
-- The sweep runs on a timer; a customer watching a stuck screen should not have
-- to wait for it. This only touches a payment that is ALREADY past the timeout,
-- so it cannot be used to abandon a charge that is still in flight.
create or replace function public.customer_abandon_stuck_payment(p_order_id uuid)
returns public.transition_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  select p.* into v_payment
    from public.payments p
    join public.orders o on o.id = p.order_id
   where p.order_id = p_order_id
     and o.customer_id = auth.uid()
     and p.status = 'PENDING';

  if not found then
    return row(false, 'there is no payment waiting on this order')::public.transition_result;
  end if;

  if v_payment.created_at > now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds) then
    return row(
      false,
      'we are still waiting to hear from the payment provider — please give it a moment'
    )::public.transition_result;
  end if;

  perform public.fail_payment(v_payment.id, 'customer abandoned a stuck payment');

  return row(true, null)::public.transition_result;
end;
$$;

revoke execute on function public.customer_abandon_stuck_payment(uuid) from public, anon;
grant execute on function public.customer_abandon_stuck_payment(uuid) to authenticated;
