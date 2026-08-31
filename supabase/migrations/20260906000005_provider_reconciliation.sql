-- ============================================================================
-- Reconciliation against the PROVIDER
-- ============================================================================
-- The existing report checks our tables against each other. That catches a
-- ledger that disagrees with itself, but not the case that actually loses
-- money: our records disagreeing with the payment provider's.
--
-- The provider cannot be queried from SQL, so the application fetches its view
-- and hands it in. Everything after that — the comparison, the classification —
-- happens here, once, so the fake and real adapters cannot drift into two
-- different notions of "matches".
--
-- Safe to run as often as you like: it writes nothing.
-- ============================================================================

-- One row per transaction, as the provider sees it.
--   [{ "provider_transaction_id": "...", "status": "SUCCEEDED",
--      "amount_pesewas": 8000, "kind": "collection" }, ...]
create or replace function public.admin_reconcile_against_provider(
  p_provider   text,
  p_provider_rows jsonb
)
returns table (
  issue                   text,
  provider_transaction_id text,
  order_number            text,
  our_status              text,
  provider_status         text,
  our_amount_pesewas      bigint,
  provider_amount_pesewas bigint,
  detail                  text
)
language sql
stable
security definer
set search_path = ''
as $$
  with theirs as (
    select r ->> 'provider_transaction_id' as txn,
           upper(r ->> 'status')           as status,
           (r ->> 'amount_pesewas')::bigint as amount,
           coalesce(r ->> 'kind', 'collection') as kind
      from jsonb_array_elements(coalesce(p_provider_rows, '[]'::jsonb)) r
     where public.is_admin()
  ),
  ours as (
    select p.provider_transaction_id as txn,
           p.status::text            as status,
           p.amount_pesewas          as amount,
           o.order_number
      from public.payments p
      join public.orders o on o.id = p.order_id
     where public.is_admin() and p.provider = p_provider
  ),
  transfers_ours as (
    select po.provider_transfer_id as txn,
           po.status::text         as status,
           po.amount_pesewas       as amount
      from public.payouts po
     where public.is_admin() and po.provider = p_provider
  )

  -- The provider took money we have no record of. The worst case: a customer
  -- was charged and we never credited anyone.
  select 'PROVIDER_ONLY', t.txn, null, null, t.status, null, t.amount,
         'the provider reports a transaction we have no payment row for'
    from theirs t
   where t.kind = 'collection'
     and not exists (select 1 from ours o where o.txn = t.txn)

  union all

  -- We think we collected; the provider has never heard of it.
  select 'MISSING_AT_PROVIDER', o.txn, o.order_number, o.status, null, o.amount, null,
         'we recorded a succeeded payment the provider does not report'
    from ours o
   where o.status = 'SUCCEEDED'
     and o.txn is not null
     and not exists (select 1 from theirs t where t.txn = o.txn and t.kind = 'collection')

  union all

  -- Both know it, and disagree about the amount.
  select 'AMOUNT_MISMATCH', o.txn, o.order_number, o.status, t.status, o.amount, t.amount,
         format('we recorded %s, the provider reports %s', o.amount, t.amount)
    from ours o
    join theirs t on t.txn = o.txn and t.kind = 'collection'
   where o.amount <> t.amount

  union all

  -- Both know it, and disagree about whether it happened.
  select 'STATUS_MISMATCH', o.txn, o.order_number, o.status, t.status, o.amount, t.amount,
         format('we say %s, the provider says %s', o.status, t.status)
    from ours o
    join theirs t on t.txn = o.txn and t.kind = 'collection'
   where (o.status = 'SUCCEEDED') <> (t.status = 'SUCCEEDED')

  union all

  -- A transfer we believe we sent that the provider has no record of. This is
  -- the direction that silently under-pays a vendor or Partner.
  select 'TRANSFER_MISSING_AT_PROVIDER', po.txn, null, po.status, null, po.amount, null,
         'we recorded a paid payout the provider does not report'
    from transfers_ours po
   where po.status = 'PAID'
     and po.txn is not null
     and not exists (select 1 from theirs t where t.txn = po.txn and t.kind = 'transfer')

  union all

  -- A transfer the provider made that we did not ask for.
  select 'TRANSFER_PROVIDER_ONLY', t.txn, null, null, t.status, null, t.amount,
         'the provider reports a transfer we have no payout row for'
    from theirs t
   where t.kind = 'transfer'
     and not exists (select 1 from transfers_ours po where po.txn = t.txn)

  union all

  -- A provider event we stored but never acted on. Often the first sign that a
  -- webhook handler is failing quietly.
  select 'WEBHOOK_UNPROCESSED', w.event_id, null, w.status::text, null, null, null,
         coalesce(w.error, 'event received but never processed')
    from public.webhook_events w
   where public.is_admin()
     and w.provider = p_provider
     and w.status in ('RECEIVED', 'FAILED')
     and w.received_at < now() - interval '10 minutes';
$$;

-- Which transactions the application should ask the provider about. Keeps the
-- fetch bounded rather than pulling a provider's entire history.
create or replace function public.admin_provider_transaction_ids(p_provider text)
returns table (provider_transaction_id text, kind text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.provider_transaction_id, 'collection'
    from public.payments p
   where public.is_admin() and p.provider = p_provider
     and p.provider_transaction_id is not null
  union all
  select po.provider_transfer_id, 'transfer'
    from public.payouts po
   where public.is_admin() and po.provider = p_provider
     and po.provider_transfer_id is not null;
$$;

revoke execute on function public.admin_reconcile_against_provider(text, jsonb) from public, anon;
revoke execute on function public.admin_provider_transaction_ids(text) from public, anon;
grant execute on function public.admin_reconcile_against_provider(text, jsonb) to authenticated;
grant execute on function public.admin_provider_transaction_ids(text) to authenticated;
