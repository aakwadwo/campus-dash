-- ============================================================================
-- Phase 6 — record the provider's transaction id as soon as we have it
-- ============================================================================
-- create_payment_intent() writes our row before the provider has been called,
-- so the provider's own id arrives a moment later. Storing it immediately (not
-- only at confirmation) is what lets us ask the provider "what happened to this
-- one?" if a webhook never arrives — the reconciliation path.
--
-- Server-side only. Idempotent, and refuses to point a payment at a different
-- transaction once it has one, which would quietly detach a real charge.
-- ============================================================================

create or replace function public.attach_payment_transaction(
  p_payment_id              uuid,
  p_provider_transaction_id text
)
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

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  if v_payment.provider_transaction_id is not null then
    if v_payment.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'payment % is already attached to transaction %',
        p_payment_id, v_payment.provider_transaction_id using errcode = 'check_violation';
    end if;
    return v_payment;  -- idempotent replay
  end if;

  update public.payments
     set provider_transaction_id = p_provider_transaction_id
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

revoke execute on function public.attach_payment_transaction(uuid, text)
  from public, anon, authenticated;
