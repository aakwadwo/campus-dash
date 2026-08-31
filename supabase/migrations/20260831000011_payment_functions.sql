-- ============================================================================
-- Payment, allocation and settlement logic
-- ============================================================================
-- ALL of these are server-side only. A customer cannot reach any of them, which
-- is what makes "a customer cannot mark their own order PAID" a structural fact
-- rather than a rule someone remembered to check.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_payment_intent — idempotent
-- ---------------------------------------------------------------------------
-- Returns the EXISTING payment when the same idempotency key comes back, so a
-- retried request can never produce a second charge.
create or replace function public.create_payment_intent(
  p_order_id        uuid,
  p_provider        text,
  p_idempotency_key text
)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order   public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  -- Idempotent replay.
  select * into v_payment from public.payments where idempotency_key = p_idempotency_key;
  if found then
    if v_payment.order_id <> p_order_id then
      raise exception 'idempotency key reused with a different order'
        using errcode = 'check_violation';
    end if;
    return v_payment;
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Payment is only collected AFTER the vendor accepts. An expired or rejected
  -- order is never charged.
  if v_order.order_status <> 'ACCEPTED' then
    raise exception 'order must be ACCEPTED before payment (is %)', v_order.order_status
      using errcode = 'check_violation';
  end if;
  if v_order.payment_status not in ('UNPAID', 'FAILED') then
    raise exception 'order payment is already % ', v_order.payment_status
      using errcode = 'check_violation';
  end if;

  -- The amount comes from the ORDER, which the server calculated and snapshotted.
  -- No caller supplies it.
  insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
  values (p_order_id, p_provider, v_order.total_pesewas, p_idempotency_key, 'PENDING')
  returning * into v_payment;

  update public.orders set payment_status = 'PENDING' where id = p_order_id;

  perform public.log_order_event(p_order_id, 'PAYMENT_INTENT_CREATED', true, 'SYSTEM',
    'payment_status', 'UNPAID', 'PENDING', null,
    jsonb_build_object('payment_id', v_payment.id, 'amount_pesewas', v_payment.amount_pesewas));

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_order_allocations — the internal ledger
-- ---------------------------------------------------------------------------
-- Splits the collected total three ways. Deliberately independent of HOW the
-- provider moves money: whether it splits at source or we transfer later, these
-- rows are identical.
create or replace function public.create_order_allocations(p_order_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_platform bigint;
  v_count    integer := 0;
begin
  perform public.assert_service_or_admin();

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Already allocated: idempotent no-op, not a duplicate ledger entry.
  if exists (select 1 from public.allocations where order_id = p_order_id) then
    return 0;
  end if;

  -- At payment time NO PARTNER EXISTS YET — dispatch has not even opened. So we
  -- allocate in two rows now, and the Partner's share is carved out of the
  -- platform row later, at the moment a Partner actually earns it
  -- (see settle_partner_earnings). The two rows always sum to the total, so the
  -- balance constraint holds at every step.
  v_platform := v_order.total_pesewas - v_order.subtotal_pesewas;

  -- The vendor cooked the food; their money is eligible on payment, regardless
  -- of how the delivery later turns out.
  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'VENDOR', v_order.vendor_id, v_order.subtotal_pesewas, 'ELIGIBLE');
  v_count := v_count + 1;

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE');
  v_count := v_count + 1;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_payment — driven by the provider, never by the browser
-- ---------------------------------------------------------------------------
create or replace function public.confirm_payment(
  p_payment_id              uuid,
  p_provider_transaction_id text,
  p_amount_pesewas          bigint
)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
  v_order   public.orders%rowtype;
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

  return v_payment;
end;
$$;

create or replace function public.fail_payment(p_payment_id uuid, p_reason text default null)
returns public.payments
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  update public.payments
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  -- Back to FAILED, from which the customer may retry. The food order is
  -- untouched: the vendor's acceptance still stands.
  update public.orders set payment_status = 'FAILED'
   where id = v_payment.order_id and payment_status = 'PENDING';

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_FAILED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'FAILED', p_reason);

  return v_payment;
end;
$$;

-- ---------------------------------------------------------------------------
-- Webhook intake — deduplicated at the database
-- ---------------------------------------------------------------------------
-- Returns true when this event is NEW and should be processed; false when it is
-- a duplicate the provider retried. The unique index does the real work.
create or replace function public.record_webhook_event(
  p_provider        text,
  p_event_id        text,
  p_payload         jsonb,
  p_signature_valid boolean
)
returns table (webhook_id uuid, is_new boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_is_new boolean;
begin
  perform public.assert_service_or_admin();

  insert into public.webhook_events (provider, event_id, payload, signature_valid, status)
  values (p_provider, p_event_id, p_payload, p_signature_valid,
          case when p_signature_valid
               then 'RECEIVED'::public.webhook_event_status
               else 'INVALID_SIGNATURE'::public.webhook_event_status end)
  on conflict (provider, event_id) do nothing
  returning id into v_id;

  v_is_new := v_id is not null;

  if not v_is_new then
    select id into v_id from public.webhook_events
     where provider = p_provider and event_id = p_event_id;
  end if;

  return query select v_id, v_is_new;
end;
$$;

create or replace function public.mark_webhook_processed(p_webhook_id uuid, p_status public.webhook_event_status, p_error text default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.webhook_events
     set status = p_status, processed_at = now(), error = p_error
   where id = p_webhook_id;
$$;

-- ---------------------------------------------------------------------------
-- Settlement
-- ---------------------------------------------------------------------------
-- Vendors daily, Partners weekly. Campus Dash does NOT hold a vendor wallet:
-- these runs move eligible allocations out, they do not accrue a balance.
create or replace function public.create_settlement_run(
  p_payee_type   public.payee_type,
  p_period_start timestamptz,
  p_period_end   timestamptz
)
returns public.settlement_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_run   public.settlement_runs%rowtype;
  v_total bigint;
begin
  perform public.assert_service_or_admin();

  -- Re-running a period returns the existing run rather than creating a second
  -- one that would pay everybody twice.
  select * into v_run from public.settlement_runs
   where payee_type = p_payee_type
     and period_start = p_period_start and period_end = p_period_end;
  if found then
    return v_run;
  end if;

  insert into public.settlement_runs (payee_type, period_start, period_end, status, created_by)
  values (p_payee_type, p_period_start, p_period_end, 'PROCESSING', auth.uid())
  returning * into v_run;

  -- Claim the eligible allocations for this run.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at >= p_period_start
     and o.created_at <  p_period_end;

  -- One payout per payee, summing their allocations. The unique index on
  -- (settlement_run_id, payee_type, payee_id) makes a duplicate impossible.
  insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
  select v_run.id, a.payee_type, a.payee_id, sum(a.amount_pesewas),
         'payout:' || v_run.id || ':' || a.payee_type::text || ':' || a.payee_id
    from public.allocations a
   where a.settlement_run_id = v_run.id and a.payee_id is not null
   group by a.payee_type, a.payee_id
  having sum(a.amount_pesewas) > 0;

  select coalesce(sum(amount_pesewas), 0) into v_total
    from public.payouts where settlement_run_id = v_run.id;

  update public.settlement_runs set total_pesewas = v_total where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;

create or replace function public.mark_payout_paid(
  p_payout_id           uuid,
  p_provider            text,
  p_provider_transfer_id text
)
returns public.payouts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if v_payout.status = 'PAID' then
    return v_payout;  -- idempotent replay
  end if;

  update public.payouts
     set status = 'PAID', provider = p_provider,
         provider_transfer_id = p_provider_transfer_id, paid_at = now()
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not payable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'SETTLED', settled_at = now()
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id = v_payout.payee_id;

  return v_payout;
end;
$$;


-- ---------------------------------------------------------------------------
-- settle_partner_earnings — called when a delivery is confirmed DELIVERED
-- ---------------------------------------------------------------------------
-- Moves the Partner's share out of the platform allocation and into a Partner
-- allocation naming the person who actually did the work. Both writes happen in
-- one transaction, so allocations_must_balance never sees a torn state.
create or replace function public.settle_partner_earnings(p_order_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_order    public.orders%rowtype;
  v_earnings bigint;
begin
  select * into v_order from public.orders where id = p_order_id;

  if v_order.partner_id is null or v_order.partner_earnings_pesewas = 0 then
    return 0;
  end if;

  -- Idempotent: a Partner allocation already exists for this order.
  if exists (
    select 1 from public.allocations where order_id = p_order_id and payee_type = 'PARTNER'
  ) then
    return 0;
  end if;

  v_earnings := v_order.partner_earnings_pesewas;

  update public.allocations
     set amount_pesewas = amount_pesewas - v_earnings
   where order_id = p_order_id and payee_type = 'PLATFORM';

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'PARTNER', v_order.partner_id, v_earnings, 'ELIGIBLE');

  return 1;
end;
$$;
