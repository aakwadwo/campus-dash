-- Lifetime totals for the operations dashboard.
--
-- WHY THIS EXISTS. admin_dashboard() answers "what is happening right now" —
-- what is in flight, what is unsettled. It could not answer the questions an
-- operator actually opens the console for: how much has this platform sold,
-- what did Campus Dash earn, what have vendors and Partners taken out of it.
-- Those were only obtainable by opening the payouts and allocations screens and
-- adding up by eye.
--
-- A SEPARATE FUNCTION, NOT A BIGGER ONE. admin_dashboard() is left exactly as it
-- is, because every tile that reads it keeps working and the smallest change
-- that answers the question is a new read.
--
-- NOTHING NEW IS CALCULATED. Every figure is a sum over rows the payment
-- architecture already writes:
--
--   total_sales      successful payments — what customers actually paid
--   vendor_sales     VENDOR allocations, whichever channel settled them
--   partner_earnings PARTNER allocations, which exist only once a delivery is
--                    completed — the GH₵5 carved out at completion
--   partner_payouts_pending
--                    PARTNER payouts raised and not yet paid
--
-- Cancelled allocations are excluded, exactly as the existing vendor_owed and
-- partner_owed figures exclude them. There is deliberately no vendor payout
-- queue: vendors settle by SPLIT at the charge, so no such queue exists. See
-- hard rule 17. This reads the ledger; it changes nothing about how money is
-- divided or routed.
create or replace function public.admin_dashboard_totals()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $$
  select case when public.is_admin() then jsonb_build_object(
    -- COUNTING ORDERS, not payments: a retried payment is still one order, and
    -- counting payments would quietly inflate this.
    'orders_total', (
      select count(*) from public.orders where payment_status = 'PAID'
    ),
    'orders_active', (
      select count(*) from public.orders
       where payment_status = 'PAID'
         and order_status not in ('COMPLETED', 'CANCELLED')
    ),
    'total_sales', (
      select coalesce(sum(amount_pesewas), 0)
        from public.payments where status = 'SUCCEEDED'
    ),
    'vendor_sales', (
      select coalesce(sum(amount_pesewas), 0)
        from public.allocations
       where payee_type = 'VENDOR' and status <> 'CANCELLED'
    ),
    'partner_earnings', (
      select coalesce(sum(amount_pesewas), 0)
        from public.allocations
       where payee_type = 'PARTNER' and status <> 'CANCELLED'
    ),
    'partner_payouts_pending', (
      select coalesce(sum(amount_pesewas), 0)
        from public.payouts
       where payee_type = 'PARTNER' and status in ('PENDING', 'PROCESSING')
    ),
    'vendors_pending', (
      select count(*) from public.vendors where status = 'PENDING_APPROVAL'
    ),
    'partners_pending', (
      select count(*) from public.partner_profiles where status = 'PENDING_REVIEW'
    )
  ) end;
$$;

comment on function public.admin_dashboard_totals() is
  'Lifetime totals for the operations dashboard — orders, sales, the vendor and Partner shares, and the pending Partner payout — summed from the existing payments, allocations and payouts ledger. Returns NULL for a non-administrator. Administrator only.';

-- Same posture as every other admin_* function: never anon, and the body
-- re-checks is_admin() regardless of who holds EXECUTE.
revoke execute on function public.admin_dashboard_totals() from public, anon;
grant  execute on function public.admin_dashboard_totals() to authenticated;
