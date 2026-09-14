-- An administrator-only way to remove pilot TEST ACCOUNTS entirely: the
-- identity, every capability built on it, every order it touched, and the money
-- records hanging off those orders.
--
-- WHY admin_purge_test_history() IS NOT ENOUGH. It forgets the delivery log and
-- order history — the two append-only tables — and nothing else. Everything
-- after that was left to hand-written DELETEs, and the schema is built to make
-- those fail: payments and allocations are RESTRICT on orders, orders are
-- RESTRICT on users and vendors, a vendor is RESTRICT on its owner, and a
-- Partner is RESTRICT on the customer profile it upgrades. Working through that
-- by hand in production is exactly the kind of one-off that gets a step wrong.
--
-- WHAT THIS DOES INSTEAD. One transaction, in dependency order, that REUSES
-- admin_purge_test_history() for the append-only rows. No trigger is disabled,
-- no guard gains an exception, and admin_actions is untouched except for the
-- rows this call appends to it.
--
-- WHY IT IS STILL NOT A "DELETE EVERYTHING" BUTTON:
--
--   * It is SCOPED to named accounts. Orders, vendors, payments and payouts go
--     only because they belong to one of those accounts. An empty call is
--     refused.
--   * It refuses to name an ADMINISTRATOR, or the caller. The audit trail keys
--     off administrator rows and must never lose one.
--   * It refuses while a payout to any of those payees is PROCESSING: that is
--     money the provider has accepted and not yet resolved, and deleting the
--     row would lose the only thing that reconciles it.
--   * Nothing it does can be half done. A dependency it does not own — someone
--     else's order event naming the account as its actor, a reward the account
--     fulfilled — fails a foreign key or a guard and the whole call rolls back.
--   * No client role can execute it. The body re-checks is_admin() as well, so
--     it has to be called by the database owner acting AS an administrator,
--     and it is audited to admin_actions under that administrator's id.
--
-- STORAGE IS NOT DELETED HERE. storage.objects refuses a SQL DELETE by design —
-- removing the row would orphan the file behind it. The function returns the
-- object paths it saw on the rows it deleted so the caller can remove them
-- through the Storage API after this transaction commits.

create or replace function public.admin_purge_test_accounts(
  p_user_ids uuid[],
  p_reason   text
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_users    uuid[] := coalesce(p_user_ids, '{}');
  v_reason   text   := nullif(btrim(coalesce(p_reason, '')), '');
  v_vendors  uuid[];
  v_payees   uuid[];
  v_orders   uuid[];
  v_payments text[];
  v_runs     uuid[];
  v_paths    jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_n        integer;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = 'insufficient_privilege';
  end if;

  if array_length(v_users, 1) is null then
    raise exception 'name the accounts to purge' using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  if auth.uid() = any(v_users) then
    raise exception 'an administrator cannot purge their own account'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.users u where u.id = any(v_users) and u.is_admin)
     or exists (select 1 from public.admin_actions a where a.admin_user_id = any(v_users))
  then
    raise exception 'an administrator account cannot be purged'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(v.id), '{}') into v_vendors
    from public.vendors v where v.owner_user_id = any(v_users);

  v_payees := v_users || v_vendors;

  if exists (
    select 1 from public.payouts p
     where p.payee_id = any(v_payees) and p.status = 'PROCESSING'
  ) then
    raise exception 'a payout to one of these accounts is still PROCESSING; resolve it first'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(o.id), '{}') into v_orders
    from public.orders o
   where o.customer_id = any(v_users)
      or o.partner_id  = any(v_users)
      or o.vendor_id   = any(v_vendors);

  select coalesce(array_agg(p.provider_transaction_id) filter (where p.provider_transaction_id is not null), '{}')
    into v_payments
    from public.payments p where p.order_id = any(v_orders);

  -- The object paths, read before the rows that name them are gone.
  select jsonb_build_object(
    'vendor-images',
      coalesce((select jsonb_agg(i.storage_path) from public.vendor_images i
                 where i.vendor_id = any(v_vendors) and i.storage_path is not null), '[]'),
    'partner-documents',
      coalesce((select jsonb_agg(x.path) from public.partner_profiles pp,
                  lateral (values (pp.student_id_image_path), (pp.face_image_path)) as x(path)
                 where pp.user_id = any(v_users) and x.path is not null), '[]'),
    'scan-documents',
      coalesce((select jsonb_agg(s.image_path) from public.order_scans s
                 where (s.order_id = any(v_orders) or s.customer_id = any(v_users))
                   and s.image_path is not null), '[]')
  ) into v_paths;

  -- 1. The append-only rows, through the existing audited mechanism. It opens
  --    and closes its own transaction-local door; nothing here touches it.
  v_n := public.admin_purge_test_history(v_users, v_orders, v_reason);
  v_counts := v_counts || jsonb_build_object('notification_events', v_n);

  -- 2. Webhook deliveries that name a payment being removed. Matched on the
  --    provider's reference appearing in the payload, so no provider's payload
  --    shape is written into the schema.
  delete from public.webhook_events w
   where exists (
     select 1 from unnest(v_payments) as ref
      where strpos(w.payload::text, ref) > 0
   );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('webhook_events', v_n);

  -- 3. Money. Allocations and payments are RESTRICT on the order; payouts are
  --    RESTRICT on their run. The balance trigger accepts an order with no
  --    allocations left, which is the state this leaves.
  delete from public.allocations a
   where a.order_id = any(v_orders) or a.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('allocations', v_n);

  delete from public.payments p where p.order_id = any(v_orders);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payments', v_n);

  -- A run goes only if every payout in it belonged to these payees and no
  -- other allocation still points at it. A run that paid anyone else stays.
  select coalesce(array_agg(r.id), '{}') into v_runs
    from public.settlement_runs r
   where exists (select 1 from public.payouts p where p.settlement_run_id = r.id and p.payee_id = any(v_payees))
     and not exists (select 1 from public.payouts p where p.settlement_run_id = r.id and not (p.payee_id = any(v_payees)))
     and not exists (select 1 from public.allocations a where a.settlement_run_id = r.id);

  delete from public.payouts p where p.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payouts', v_n);

  delete from public.settlement_runs r where r.id = any(v_runs);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('settlement_runs', v_n);

  delete from public.payout_destinations d where d.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payout_destinations', v_n);

  -- 4. Orders. Items, secrets, scans and ratings cascade; their order_events
  --    and notification rows are already gone, so nothing append-only is hit.
  select count(*) into v_n from public.order_items where order_id = any(v_orders);
  v_counts := v_counts || jsonb_build_object('order_items', v_n);
  select count(*) into v_n from public.order_secrets where order_id = any(v_orders);
  v_counts := v_counts || jsonb_build_object('order_secrets', v_n);

  delete from public.order_scans s where s.order_id = any(v_orders) or s.customer_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('order_scans', v_n);

  delete from public.partner_ratings r
   where r.order_id = any(v_orders) or r.partner_id = any(v_users) or r.customer_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_ratings', v_n);

  delete from public.orders o where o.id = any(v_orders);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_n);

  -- 5. Stores. Menu items, images and the daily queue counters cascade.
  select count(*) into v_n from public.menu_items where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('menu_items', v_n);
  select count(*) into v_n from public.vendor_images where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('vendor_images', v_n);
  select count(*) into v_n from public.vendor_order_counters where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('vendor_order_counters', v_n);

  delete from public.vendors v where v.id = any(v_vendors);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('vendors', v_n);

  -- 6. Capabilities, in the order the foreign keys require: a Partner before
  --    the customer profile it upgrades.
  delete from public.idempotency_keys k where k.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n);

  delete from public.customer_rewards r where r.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_rewards', v_n);

  delete from public.terms_acceptances t where t.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('terms_acceptances', v_n);

  delete from public.partner_profiles p where p.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_profiles', v_n);

  delete from public.customer_profiles c where c.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_profiles', v_n);

  -- 7. The identity. public.users cascades from auth.users, and so do the
  --    account's sessions, identities and factors.
  delete from auth.users u where u.id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth_users', v_n);

  perform public.log_admin_action(
    'TEST_ACCOUNTS_PURGED',
    'users',
    null,
    v_reason,
    null,
    null,
    jsonb_build_object(
      'user_ids', to_jsonb(v_users),
      'vendor_ids', to_jsonb(v_vendors),
      'order_ids', to_jsonb(v_orders),
      'counts', v_counts
    )
  );

  return jsonb_build_object('counts', v_counts, 'storage_paths', v_paths);
end;
$$;

comment on function public.admin_purge_test_accounts(uuid[], text) is
  'Removes named pilot test accounts with every capability, store, order and money record that belongs to them, in one transaction. Reuses admin_purge_test_history() for the append-only rows. Refuses administrators, the caller, an empty list, a missing reason and PROCESSING payouts. Administrator only, re-checked in the body; executable by no client role; audited to admin_actions. Returns counts and the storage object paths the caller must remove through the Storage API.';

revoke execute on function public.admin_purge_test_accounts(uuid[], text)
  from public, anon, authenticated, service_role;
