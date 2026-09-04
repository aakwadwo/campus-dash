-- ============================================================================
-- Admin Console corrections — revenue semantics, and account suspension
-- ============================================================================
-- Two changes, and neither of them moves a cedi.
--
-- 1. PLATFORM REVENUE IS NOT THE PLATFORM ALLOCATION.
--
--    The ledger is right and stays exactly as it is: at payment time there is
--    no Partner yet, so `create_order_allocations` parks everything that is not
--    the food — service fee AND delivery fee — on the PLATFORM row, and
--    `settle_partner_earnings` carves the Partner's share out of it when a
--    delivery is actually completed. Two rows that always sum to the total, at
--    every step, which is what `allocations_must_balance` is there to police.
--
--    The ADMIN CONSOLE then read that row and called the whole of it "Platform
--    earned / Service fees". On a paid but undelivered order that is a lie of
--    GH₵5.00 per order in the platform's favour, and it grows with the number
--    of deliveries still in flight — precisely the moment an operator is most
--    likely to be looking at the number.
--
--    So the platform allocation is now REPORTED in three parts:
--
--      service fee        the platform's actual revenue on the order
--      delivery held      delivery money still owed to whoever completes the
--                         delivery — a LIABILITY sitting in the platform row
--                         because the ledger has nowhere else to put it yet
--      delivery margin    what the platform keeps of the delivery fee once a
--                         Partner HAS been settled. Zero while
--                         partner_share_of_delivery_bps is 10000.
--
--    The three always sum back to the allocation, so `allocated_pesewas` still
--    balances against gross and nothing downstream of the ledger changes.
--
-- 2. SUSPENDING AN ACCOUNT NEEDED A SQL CLIENT.
--
--    `users.is_suspended` is the switch that every capability already consults
--    — is_admin(), is_customer(), is_approved_partner(), my_vendor_ids() — and
--    there was no audited way for an administrator to throw it. There is now,
--    and it follows the same shape as every other admin write: is_admin(),
--    a mandatory reason, and an admin_actions row in the same transaction.
--
--    SELF-SUSPENSION IS REFUSED IN SQL. is_admin() requires `not is_suspended`,
--    so an administrator suspending themselves would revoke, in one statement,
--    the authority needed to undo it. A disabled button is not a control.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. The dashboard's money section
-- ---------------------------------------------------------------------------
-- Replaced in place. The signature is unchanged, so `create or replace` keeps
-- the existing REVOKE/GRANT rather than handing EXECUTE back to PUBLIC — the
-- mistake this project has now made three times. Nothing outside the `money`
-- object differs from the previous definition.

create or replace function public.admin_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- One row per non-cancelled PLATFORM allocation, split into what the platform
  -- has actually earned and what it is merely holding.
  --
  -- `service_component` is capped at the allocation because the ledger may only
  -- ever carve the DELIVERY fee out of this row (partner_earnings_pesewas <=
  -- delivery_fee_pesewas is a table constraint), so the service fee is always
  -- fully present — the least() is belt and braces against a future change
  -- making that untrue and silently reporting a negative delivery component.
  with platform_rows as (
    select a.amount_pesewas,
           least(o.service_fee_pesewas, a.amount_pesewas)                as service_component,
           a.amount_pesewas - least(o.service_fee_pesewas, a.amount_pesewas) as delivery_component,
           exists (
             select 1 from public.allocations pa
              where pa.order_id = a.order_id
                and pa.payee_type = 'PARTNER'
                and pa.status <> 'CANCELLED'
           ) as partner_settled
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.payee_type = 'PLATFORM' and a.status <> 'CANCELLED'
  )
  select case when not public.is_admin() then null else jsonb_build_object(

    'operations', jsonb_build_object(
      'orders_today', (select count(*) from public.orders
                        where order_status <> 'DRAFT' and created_at >= date_trunc('day', now())),
      'active_food',  (select count(*) from public.orders
                        where order_type = 'FOOD' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'active_scan',  (select count(*) from public.orders
                        where order_type = 'SCAN' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'searching',    (select count(*) from public.orders where delivery_status = 'SEARCHING'),
      'assigned',     (select count(*) from public.orders where delivery_status in ('ASSIGNED','PICKED_UP')),
      'no_partner',   (select count(*) from public.orders where delivery_status = 'FAILED_NO_PARTNER'),
      'scan_refused', (select count(*) from public.orders
                        where order_type = 'SCAN' and scan_status = 'REFUSED'),
      'needs_attention', (select count(*) from public.admin_order_board(null, 500) b
                           where b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','NO_PARTNER',
                                                 'REFUND_PENDING','PAYMENT_FAILED'))
    ),

    'money', jsonb_build_object(
      -- What customers have actually paid us, gross.
      'collected_pesewas', (select coalesce(sum(amount_pesewas),0) from public.payments where status = 'SUCCEEDED'),
      'payments_count',    (select count(*) from public.payments where status = 'SUCCEEDED'),
      -- What we owe, by payee, excluding anything already settled or cancelled.
      'vendor_owed',   (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'VENDOR'  and status in ('PENDING','ELIGIBLE')),
      'partner_owed',  (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'PARTNER' and status in ('PENDING','ELIGIBLE')),

      -- REVENUE. The service fee the platform charged, plus whatever it keeps
      -- of a delivery fee once the Partner on that delivery has been settled.
      -- It deliberately EXCLUDES delivery money still waiting on a delivery.
      'platform_earned', (select coalesce(sum(service_component),0)::bigint
                            + coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                            from platform_rows),
      -- The same figure's two halves, so a suspicious number can be taken apart
      -- on the screen instead of in a SQL client.
      'platform_service_fee',    (select coalesce(sum(service_component),0)::bigint from platform_rows),
      'platform_delivery_margin',(select coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                                    from platform_rows),
      -- LIABILITY, not revenue: delivery fees collected from customers, sitting
      -- in the platform allocation only because no Partner row exists to hold
      -- them yet. This is the money the old `platform_earned` was quietly
      -- counting as ours.
      'delivery_fees_held',      (select coalesce(sum(delivery_component) filter (where not partner_settled),0)::bigint
                                    from platform_rows),
      -- The raw allocation row total, unchanged, so the ledger identity
      -- vendor + partner + platform_allocated = gross can still be checked.
      'platform_allocated',      (select coalesce(sum(amount_pesewas),0)::bigint from platform_rows),

      'payouts_pending',    (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PENDING'),
      'payouts_processing', (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PROCESSING'),
      'payouts_failed',     (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'FAILED'),
      'payouts_paid',       (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PAID'),
      'refunded_pesewas',   (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUNDED'),
      'refund_pending_pesewas', (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUND_PENDING')
    ),

    'people', jsonb_build_object(
      'customers',        (select count(*) from public.customer_profiles),
      'partners',         (select count(*) from public.partner_profiles where status = 'APPROVED'),
      'partners_pending', (select count(*) from public.partner_profiles where status = 'PENDING_REVIEW'),
      'partners_online',  (select count(*) from public.partner_profiles where status = 'APPROVED' and is_available),
      'vendors',          (select count(*) from public.vendors),
      'vendors_active',   (select count(*) from public.vendors where status = 'ACTIVE'),
      'vendors_scan',     (select count(*) from public.vendors where can_accept_scans),
      'suspended',        (select count(*) from public.users where is_suspended)
    ),

    'system', jsonb_build_object(
      'webhooks_24h',        (select count(*) from public.webhook_events where received_at >= now() - interval '24 hours'),
      'webhooks_invalid_24h',(select count(*) from public.webhook_events
                               where received_at >= now() - interval '24 hours' and not signature_valid),
      'notifications_24h',   (select count(*) from public.notification_events where created_at >= now() - interval '24 hours'),
      'notifications_failed_24h', (select count(*) from public.notification_events
                                    where created_at >= now() - interval '24 hours' and not succeeded),
      'admin_actions_24h',   (select count(*) from public.admin_actions where created_at >= now() - interval '24 hours'),
      'scan_fee_configured', (select scan_service_fee_pesewas is not null from public.pricing_config where id)
    )
  ) end;
$$;


-- ---------------------------------------------------------------------------
-- 2. Ledger totals
-- ---------------------------------------------------------------------------
-- `platform_pesewas` now means PLATFORM REVENUE, which is what every caller
-- already believed it meant and labelled it as. The raw allocation sum it used
-- to hold is still available as `platform_allocated_pesewas`, and
-- `allocated_pesewas` is untouched — so the balance check on the finance page,
-- allocated = gross, continues to hold exactly as before.

create or replace function public.admin_ledger_totals(
  p_order_type text default null,
  p_since      timestamptz default null,
  p_until      timestamptz default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- GROSS IS SUMMED OVER DISTINCT ORDERS, not over allocation rows. An order
  -- with three payees would otherwise contribute its total three times and the
  -- finance page would report revenue that does not exist.
  with rows as (
    select a.amount_pesewas, a.payee_type, o.id as order_id, o.total_pesewas,
           o.service_fee_pesewas
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.status <> 'CANCELLED'
       and (p_order_type is null or o.order_type::text = p_order_type)
       and (p_since is null or o.created_at >= p_since)
       and (p_until is null or o.created_at <  p_until)
  ),
  orders_once as (select distinct order_id, total_pesewas from rows),
  -- The PLATFORM row, taken apart. `partner_settled` is decided from the same
  -- filtered set, which is safe because every filter here is order-level: an
  -- order's PLATFORM and PARTNER rows are always both in or both out.
  platform_rows as (
    select p.amount_pesewas,
           least(p.service_fee_pesewas, p.amount_pesewas)                as service_component,
           p.amount_pesewas - least(p.service_fee_pesewas, p.amount_pesewas) as delivery_component,
           exists (select 1 from rows x
                    where x.order_id = p.order_id and x.payee_type = 'PARTNER') as partner_settled
      from rows p
     where p.payee_type = 'PLATFORM'
  )
  select case when not public.is_admin() then null else jsonb_build_object(
    'orders',            (select count(*) from orders_once),
    'gross_pesewas',     (select coalesce(sum(total_pesewas),0)::bigint from orders_once),
    'vendor_pesewas',    (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'VENDOR'),
    'partner_pesewas',   (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'PARTNER'),

    -- Platform REVENUE: service fees, plus retained delivery margin on
    -- deliveries a Partner has already been settled for.
    'platform_pesewas',  (select coalesce(sum(service_component),0)::bigint
                            + coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                            from platform_rows),
    'platform_service_fee_pesewas',     (select coalesce(sum(service_component),0)::bigint from platform_rows),
    'platform_delivery_margin_pesewas', (select coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                                           from platform_rows),
    -- Delivery fees parked in the PLATFORM row awaiting Partner settlement.
    -- Owed, not earned.
    'delivery_fees_held_pesewas',       (select coalesce(sum(delivery_component) filter (where not partner_settled),0)::bigint
                                           from platform_rows),
    -- The unsplit PLATFORM allocation. Kept so the ledger identity is still
    -- expressible: vendor + partner + platform_allocated = allocated = gross.
    'platform_allocated_pesewas',       (select coalesce(sum(amount_pesewas),0)::bigint from platform_rows),

    'allocated_pesewas', (select coalesce(sum(amount_pesewas),0)::bigint from rows)
  ) end;
$$;


-- ---------------------------------------------------------------------------
-- 3. Account suspension
-- ---------------------------------------------------------------------------
-- The only audited write path onto `users.is_suspended`.
--
-- Suspension is not a capability of its own and this function grants none: it
-- flips one boolean that is_admin(), is_customer(), is_approved_partner() and
-- my_vendor_ids() already consult, so every capability the account holds
-- disappears together and comes back together. That is the whole point of it
-- being one column — there is no per-capability suspension to forget.

create or replace function public.admin_set_user_suspended(
  p_user_id   uuid,
  p_suspended boolean,
  p_reason    text
)
returns public.users
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_before public.users%rowtype;
  v_after  public.users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_suspended is null then
    raise exception 'suspend or unsuspend must be stated explicitly'
      using errcode = 'check_violation';
  end if;

  -- admin_actions enforces this too, but failing here names the missing field
  -- instead of surfacing a constraint violation on a table the operator has
  -- never heard of.
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required, and is recorded in the audit log'
      using errcode = 'check_violation';
  end if;

  -- SELF-SUSPENSION IS REFUSED, IN SQL.
  --
  -- is_admin() is `is_admin and not is_suspended`. An administrator suspending
  -- their own account therefore revokes, in the same statement, the authority
  -- needed to reverse it — and if they are the only administrator, the console
  -- is gone until somebody opens a SQL client against production. The UI hides
  -- the control; this is what actually stops it.
  --
  -- Suspending ANOTHER administrator is allowed and deliberately so: that is a
  -- real thing an operator may need to do, and the target keeps a colleague who
  -- can undo it.
  if p_suspended and p_user_id = auth.uid() then
    raise exception 'you cannot suspend your own account; ask another administrator'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.users where id = p_user_id;
  if not found then
    raise exception 'no such user' using errcode = 'no_data_found';
  end if;

  update public.users
     set is_suspended = p_suspended
   where id = p_user_id
  returning * into v_after;

  -- A suspended Partner must also stop being offered deliveries. is_available
  -- is the dispatch flag, and leaving it true would keep the account in the
  -- offer pool right up until is_approved_partner() rejected the acceptance —
  -- a Partner watching offers appear and fail. Reinstatement does NOT set it
  -- back: going online is the Partner's own decision, not an admin's.
  if p_suspended then
    update public.partner_profiles
       set is_available = false
     where user_id = p_user_id and is_available;
  end if;

  perform public.log_admin_action(
    case when p_suspended then 'USER_SUSPENDED' else 'USER_UNSUSPENDED' end,
    'user', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
-- Only the new function needs one: the two functions above were REPLACEd, not
-- dropped, so they keep the ACL they already had. authenticated only, never
-- anon, and the function re-checks is_admin() itself.

revoke execute on function public.admin_set_user_suspended(uuid, boolean, text) from public, anon;
grant  execute on function public.admin_set_user_suspended(uuid, boolean, text) to authenticated;
