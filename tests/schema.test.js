import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools } from './helpers/db.js';

/**
 * Schema invariants.
 *
 * These are the properties the whole security model rests on. They are asserted
 * here so that a future migration cannot quietly grant a write, drop a policy or
 * disable RLS without a test going red.
 */
describe('schema invariants', () => {
  after(closePools);

  test('row level security is enabled on every table in public', async () => {
    const unprotected = await asService(async (c) =>
      (
        await c.query(`
        select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `)
      ).rows.map((r) => r.relname)
    );
    assert.deepEqual(unprotected, [], 'every table must have RLS enabled');
  });

  test('no client role holds INSERT, UPDATE, DELETE or TRUNCATE on any table', async () => {
    const writes = await asService(
      async (c) =>
        (
          await c.query(`
        select grantee, table_name, privilege_type
          from information_schema.role_table_grants
         where table_schema = 'public'
           and grantee in ('anon', 'authenticated')
           and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
      `)
        ).rows
    );
    assert.deepEqual(writes, [], 'all writes must go through SECURITY DEFINER functions');
  });

  test('the secret and server-only tables are unreadable by clients', async () => {
    const readable = await asService(
      async (c) =>
        (
          await c.query(`
        select table_name, grantee
          from information_schema.role_table_grants
         where table_schema = 'public'
           and grantee in ('anon', 'authenticated')
           and table_name in ('order_secrets', 'webhook_events', 'idempotency_keys', 'admin_actions', 'payout_destinations')
      `)
        ).rows
    );
    assert.deepEqual(
      readable,
      [],
      'pickup codes, provider payloads and payout account numbers are server-only'
    );
  });

  test('money-moving functions are not callable by any client role', async () => {
    const forbidden = [
      'confirm_payment',
      'create_payment_intent',
      'fail_payment',
      'create_order_allocations',
      'settle_partner_earnings',
      'create_settlement_run',
      'mark_payout_paid',
      // The payout lifecycle. A client that could call any of these could mark
      // its own payout PAID, or release somebody else's allocation claim.
      'mark_payout_processing',
      'fail_payout',
      'retry_payout',
      // Unwinds a completed transfer and puts the liability back. A client that
      // could call this could un-settle somebody else's money.
      'reverse_payout',
      'payout_for_transfer',
      // Where the money goes. Reading it is as sensitive as writing it.
      'payout_destination_for',
      'attach_payout_recipient',
      // payments.raw holds whole provider payloads, checkout URL included.
      'payment_checkout_url',
      'record_webhook_event',
      'mark_webhook_processed',
      'expire_stale_orders',
      'expire_partner_search',
      'generate_numeric_code',
      'log_order_event',
      'handle_new_auth_user',
      'handle_new_auth_user_for',
      // Places an order AS a given customer. Server contexts only — a client
      // grant here would let anyone order in someone else's name.
      'submit_order_for',
      // Prices an order. Reachable only through quote_order (read-only) and
      // submit_order_for; never directly, so a client cannot probe pricing for
      // a vendor or item it should not see.
      'price_order',
      // Writes the provider's transaction id onto a payment.
      'attach_payment_transaction',
      // Sweeps payments the provider never confirmed.
      'expire_stale_payments',
      // Asked before sending, to stop a retry buzzing somebody twice.
      'mark_payment_failed_internal',
      'notification_already_sent',
      // Writes the SMS delivery log. Server contexts only — a client that could
      // write here could forge a record of a message nobody sent.
      'record_notification',
      // Applies the provider's delivery report. A client that could call this
      // could mark its own unsent messages delivered, which is precisely the
      // record support relies on when someone says a code never arrived.
      'record_sms_delivery_status',
      // Deletes whole accounts, their stores, orders and money records. Run
      // only by the database owner acting as an administrator, never through
      // PostgREST — not even a signed-in administrator's browser session.
      'admin_purge_test_accounts',
    ];
    const callable = await asService(
      async (c) =>
        (
          await c.query(
            `select p.proname, r.rolname
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join (values ('anon'), ('authenticated')) as r(rolname)
          where n.nspname = 'public'
            and p.proname = any($1)
            and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
            [forbidden]
          )
        ).rows
    );
    assert.deepEqual(callable, [], 'these run under the service role only');
  });

  test('every SECURITY DEFINER function pins an empty search_path', async () => {
    // Postgres stores an empty pin as either search_path= or search_path="",
    // depending on how it was written. Anything else — including no entry at
    // all — means the function resolves names against the caller's path.
    const unpinned = await asService(async (c) =>
      (
        await c.query(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and coalesce(
                 (select cfg from unnest(coalesce(p.proconfig, '{}')) cfg
                   where cfg like 'search_path=%'), '')
               not in ('search_path=', 'search_path=""')
      `)
      ).rows.map((r) => r.proname)
    );
    assert.deepEqual(unpinned, [], 'an unpinned search_path is a privilege-escalation vector');
  });

  test('the money-safety constraints and indexes all exist', async () => {
    const required = [
      // TWO active deliveries per Partner, and the index is what makes that a
      // guarantee. "At most one" could be a unique index on partner_id; "at
      // most two" cannot, so an active delivery holds a numbered SLOT and the
      // slot is what is unique.
      'orders_partner_active_slot_unique',
      'payments_one_pending_per_order',
      'payments_one_succeeded_per_order',
      'payments_idempotency_key_unique',
      'payouts_run_payee_unique',
      'payouts_idempotency_key_unique',
      'webhook_events_provider_event_unique',
      'allocations_order_payee_unique',
      'settlement_runs_period_unique',
      // A phone number is unique when present, and NULLABLE — an administrator
      // has none at all, because operational access must not depend on an SMS.
      'users_phone_key',
      // One identity owns at most one store, so every vendor screen can be
      // about "your store" rather than carrying a picker nobody in the pilot
      // would use.
      'vendors_owner_unique',
      // One student ID backs one CUSTOMER identity. The index moved here with
      // the column it guards when Customer became a capability.
      'customer_profiles_student_id_unique',
      // ONE EMAIL → ONE ACCOUNT IDENTITY. Not an identity key — auth.users.id
      // is — but unique, which is what makes future OAuth linking unambiguous.
      'users_email_unique',
    ];
    const present = await asService(async (c) =>
      (
        await c.query(
          "select indexname from pg_indexes where schemaname = 'public' and indexname = any($1)",
          [required]
        )
      ).rows.map((r) => r.indexname)
    );
    assert.deepEqual(present.sort(), [...required].sort());
  });

  test('every money column is an integer type — no floats anywhere', async () => {
    const nonInteger = await asService(
      async (c) =>
        (
          await c.query(`
        select table_name, column_name, data_type
          from information_schema.columns
         where table_schema = 'public'
           and column_name like '%_pesewas'
           and data_type not in ('bigint', 'integer')
      `)
        ).rows
    );
    assert.deepEqual(nonInteger, [], 'money is always integer pesewas');
  });

  test('the set of client-callable functions matches an explicit allowlist', async () => {
    // Postgres grants EXECUTE to PUBLIC by default, so a new function is
    // reachable by anon unless something takes that away. A blanket revoke only
    // covers functions that exist when it runs — which is exactly how three
    // auth provisioning helpers ended up anon-callable after Phase 3.
    //
    // This asserts the WHOLE surface, so adding a function without deciding who
    // may call it fails here rather than shipping quietly.
    // Everything an anonymous visitor may call. The marketplace is browsable
    // signed out, so the storefront is here on purpose — and the vendor's phone
    // number is deliberately not among the columns any of it returns.
    const ANON = [
      'current_terms',
      'current_user_id',
      'deliverable_locations',
      // The campus tree for the destination picker. Place names and whether
      // each can be chosen: the same public facts deliverable_locations()
      // already gave, in the shape a drill-down needs.
      'destination_places',
      // A pure text helper: given a first name and a legacy full name, it
      // returns the one to show. It reads nothing and can leak nothing.
      'given_name',
      'is_admin',
      'is_customer',
      'is_vendor_staff',
      'location_floor',
      'location_path',
      'location_zone',
      'my_vendor_ids',
      'platform_config',
      // THE SCAN CATALOGUE IS GONE. scan_menu() and scan_restaurants() served a
      // separate way to browse; a Meal Scan is a switch on an eligible store's
      // ordinary checkout now, and the storefront read carries scan_eligible
      // like any other column.
      'storefront_vendor',
      'storefront_vendors',
      'active_vendor_categories',
      // Asked BEFORE a vendor sign-in code is sent, which is by definition
      // before anybody is signed in. Returns ONE WORD about a number the caller
      // already typed — strictly less than the screen's own error message tells
      // them either way — and stops /login/vendor being used to send an SMS to
      // an arbitrary number, or to sign somebody into an identity that holds
      // the number but owns nothing.
      'vendor_phone_sign_in_status',
    ];

    // Everything a signed-in account may call. Reachability, NOT authorisation:
    // every admin_* function re-checks is_admin() in its own body, so a
    // non-admin who calls one directly gets an empty result or a raised
    // exception, never data.
    //
    // ABSENT ON PURPOSE, and each absence is a rule:
    //
    //   vendor_accept_order         acceptance is gone from the product. The
    //   vendor_reject_order         functions survive for orders placed before
    //   vendor_mark_preparing       that changed, and for admin tooling, but no
    //                               browser can reach them
    //   vendor_complete_pickup_order  the collection handoff reversed: the
    //   get_my_pickup_code            VENDOR holds the code and reads it out;
    //   vendor_pickup_code            the CUSTOMER types it in. Either of these
    //                                 being reachable would put the secret and
    //                                 the act on the same side of the counter
    //   vendor_confirm_pickup       the Partner handoff works the same way, so
    //                               a Partner has no way to read a code either
    //   partners_to_notify_of_offer service-only: it returns other people's
    //   vendor_owner_contact        phone numbers to a caller who is not them
    //   payout_recipient_contact
    //   price_order                 reachable only through quote_order and
    //                               submit_order_for, so a client cannot probe
    //                               pricing for a vendor or item it cannot see
    const AUTHENTICATED = [
      ...ANON,
      'accept_terms',
      'admin_cancel_order',
      'admin_clear_partner_documents',
      'admin_complete_order',
      'admin_create_location',
      'admin_create_menu_item',
      'admin_create_vendor',
      // Creates a store WITH an owner, for one recruited in person. The
      // identity itself is provisioned through the auth admin API by the
      // server; this only attaches it to a PENDING_APPROVAL store, so the
      // existing review queue and welcome SMS still apply.
      'admin_create_vendor_account',
      'admin_create_vendor_category',
      'admin_customer_detail',
      'admin_customer_rewards',
      'admin_customer_summary',
      'admin_customers',
      'admin_dashboard',
      'admin_dashboard_totals',
      'admin_purge_test_history',
      // DELETION FROM THE CONSOLE, and both are narrow on purpose: each refuses
      // an account or a store with orders, settlement records or ratings, so
      // nothing that reconciles money can be removed by a button. The sweeping
      // version — admin_purge_test_accounts — is still reachable by nobody.
      'admin_delete_customer',
      'admin_delete_location',
      'admin_delete_menu_item',
      'admin_delete_vendor',
      'admin_exceptions',
      'admin_failed_notifications',
      'admin_ledger',
      'admin_ledger_totals',
      'admin_list_actions',
      'admin_list_partner_applications',
      'admin_mark_refunded',
      'admin_notification_log',
      'admin_order_board',
      'admin_order_board_summary',
      'admin_order_money',
      'admin_partner_activity',
      'admin_partner_detail',
      'admin_partner_documents_due_for_purge',
      'admin_partner_balances',
      'admin_partner_ratings',
      'admin_partners',
      'admin_payments',
      'admin_payout_destinations',
      'admin_payout_readiness',
      'admin_payout_history',
      // The weekly Partner settlement, done by hand. A run creates the payouts
      // and stops; a person sends the money and records the reference, which
      // appends to admin_actions.
      'admin_payouts_awaiting_settlement',
      'admin_pending_settlement',
      'admin_pilot_metrics',
      'admin_provider_transaction_ids',
      'admin_reassign_delivery',
      'admin_reconcile_against_provider',
      'admin_reconciliation',
      'admin_resolve_dispute',
      'admin_review_partner',
      'admin_review_vendor',
      'admin_scan_order',
      'admin_scheduled_job_status',
      'admin_set_location_active',
      'admin_set_menu_item_available',
      'admin_set_payout_destination',
      'admin_settle_payout_manually',
      'admin_set_user_suspended',
      'admin_set_vendor_scans',
      'admin_set_vendor_status',
      'admin_settle_customer_reward',
      'admin_settlement_overview',
      'admin_settlement_payouts',
      'admin_settlement_runs',
      'admin_undelivered_notifications',
      'admin_update_config',
      'admin_update_location',
      'admin_update_menu_item',
      'admin_update_vendor',
      'admin_update_vendor_category',
      'admin_vendor_categories',
      'admin_vendors',
      'admin_webhook_events',
      'complete_customer_onboarding',
      'customer_abandon_stuck_payment',
      // An UNPAID order, abandoned by the person who placed it. Guarded on the
      // payment state, so a paid order is refused rather than cancelled.
      'customer_abandon_unpaid_order',
      'customer_choose_fulfilment',
      'customer_collect_instead',
      // The customer types in the four digits the STORE read out, and that
      // completes a collection. The direction is the whole point — see the
      // absence of get_my_pickup_code below.
      'customer_complete_pickup',
      'customer_dispute_delivery',
      'customer_keep_waiting',
      'customer_order_detail',
      'customer_order_list',
      // The order screen's poll: an opaque signature of the caller's own order.
      'customer_order_signal',
      'customer_order_stage',
      'customer_rate_partner',
      'customer_reward_milestones',
      'fulfilment_options',
      'get_delivery_offers',
      'get_my_delivery_code',
      'my_capabilities',
      'my_customer_profile',
      'my_order_summary',
      'my_outstanding_terms',
      'my_partner_application',
      'my_partner_activity',
      'my_partner_payouts',
      'my_partner_rating',
      'my_payout_destination',
      'my_reward_progress',
      'my_scan_order',
      'my_vendor_application',
      'partner_accept_delivery',
      'partner_active_delivery',
      'partner_apply',
      'partner_cancel_delivery',
      'partner_capacity',
      'partner_complete_delivery',
      'partner_confirm_customer_absent',
      'partner_confirm_pickup',
      'partner_delivery_history',
      'partner_earnings_summary',
      // partner_may_read_scan and partner_scan_brief are NOT here, and not
      // because they lost a grant: they do not exist. A Partner is told
      // nothing about a Meal Scan and never sees the image — the store
      // verifies it before dispatch is even opened.
      'partner_report_customer_absent',
      // A pure read of one configured number. It leaks nothing: the threshold
      // is a published product policy, shown on the Partner dashboard.
      'payout_threshold_for',
      'partner_set_availability',
      'partner_set_payout_destination',
      'quote_order',
      'quote_scan_order',
      'scan_image_path',
      'set_my_email',
      // Copies the caller's VERIFIED auth phone onto their own profile. No
      // parameter: the number comes from auth.users, never from the request.
      'sync_my_verified_phone',
      'submit_order',
      'submit_scan_order',
      'update_my_profile',
      'vendor_add_image',
      'vendor_delete_image',
      'vendor_set_primary_image',
      'vendor_earnings_summary',
      'vendor_handoff_code',
      'vendor_mark_ready',
      // A STORE OWNS ITS OWN MENU. Adding, pricing and photographing items used
      // to be an administrator's job, which put a support queue between a cook
      // and their own board for no protection — price_order() snapshots every
      // figure onto the order at submission, so an edit reaches the next quote
      // and nothing that already exists.
      'vendor_menu',
      'vendor_create_menu_item',
      'vendor_update_menu_item',
      'vendor_delete_menu_item',
      'vendor_set_menu_item_image',
      'vendor_clear_menu_item_image',
      // THE STORE IS THE REDEMPTION POINT. It sees the scan while the order is
      // live on its board, says whether the entitlement is good, and reads out
      // the same four digits every other order uses. vendor_may_read_scan is
      // the predicate behind both the image and the order_scans policy, and is
      // reachable because a policy evaluates as the caller.
      'vendor_may_read_scan',
      'vendor_order_board',
      'vendor_order_bucket',
      'vendor_order_bucket_for',
      'vendor_redeem_scan',
      'vendor_refuse_scan',
      'vendor_scan_image_path',
      'vendor_order_detail',
      'vendor_daily_sales',
      'vendor_orders_on_day',
      // A store's own money by the day it was paid, for "Next payout". Staff or
      // admin, enforced in the body; a read that writes no settlement record.
      'vendor_payout_days',
      'vendor_pending_count',
      'vendor_active_count',
      'vendor_set_accepting_orders',
      // THE ACTIVE MENU. A catalogue item is turned on when the store is
      // serving it and off when it is not, and the store's open state follows:
      // the last item off closes the shop, any item on opens it.
      'vendor_set_menu_item_active',
      'vendor_set_menu_item_available',
      'vendor_set_payout_destination',
      'vendor_signup',
      'vendor_update_profile',
    ];

    for (const [role, allowed] of [
      ['anon', ANON],
      ['authenticated', AUTHENTICATED],
    ]) {
      const actual = await asService(async (c) =>
        (
          await c.query(
            `select distinct p.proname
               from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and has_function_privilege($1, p.oid, 'EXECUTE')
              order by p.proname`,
            [role]
          )
        ).rows.map((r) => r.proname)
      );
      assert.deepEqual(
        actual,
        [...allowed].sort(),
        `${role} can call functions that are not on the allowlist (or vice versa)`
      );
    }
  });

  test('new TABLES are deny-by-default too', async () => {
    // The same hole as functions, and it bit for real: Supabase ships default
    // ACLs granting anon and authenticated full DML on tables in this schema,
    // so every table added after Phase 2's revoke came back writable — an
    // anonymous visitor briefly held TRUNCATE on the notification audit log.
    const defaults = await asService(async (c) =>
      (
        await c.query(`
        select unnest(d.defaclacl)::text as grant_entry
          from pg_default_acl d
          join pg_namespace n on n.oid = d.defaclnamespace
          join pg_roles r on r.oid = d.defaclrole
         where n.nspname = 'public' and d.defaclobjtype = 'r' and r.rolname = 'postgres'
      `)
      ).rows.map((r) => r.grant_entry)
    );
    for (const grantee of ['', 'anon', 'authenticated']) {
      assert.ok(
        !defaults.some((entry) => entry.startsWith(`${grantee}=`)),
        `default table privileges must grant nothing to ${grantee || 'PUBLIC'}`
      );
    }
  });

  test('new functions are deny-by-default, not PUBLIC-by-default', async () => {
    // Scoped to the 'postgres' role, because that is who migrations run as and
    // therefore whose default privileges govern the functions we create. The
    // separate supabase_admin row is platform-owned: it applies only to objects
    // supabase_admin itself creates, and is not ours to change.
    const defaults = await asService(async (c) =>
      (
        await c.query(`
        select unnest(d.defaclacl)::text as grant_entry
          from pg_default_acl d
          join pg_namespace n on n.oid = d.defaclnamespace
          join pg_roles r on r.oid = d.defaclrole
         where n.nspname = 'public' and d.defaclobjtype = 'f' and r.rolname = 'postgres'
      `)
      ).rows.map((r) => r.grant_entry)
    );
    // Supabase ships its own default ACLs granting EXECUTE to anon and
    // authenticated on functions in this schema, so revoking PUBLIC alone
    // leaves new functions reachable. All three must be gone.
    for (const grantee of ['', 'anon', 'authenticated']) {
      assert.ok(
        !defaults.some((entry) => entry.startsWith(`${grantee}=X/`)),
        `default privileges must not grant EXECUTE to ${grantee || 'PUBLIC'}`
      );
    }
  });

  test('every admin function re-checks is_admin() in its own body', async () => {
    // A grant only decides who may ATTEMPT a call. If one of these ever stops
    // checking, any signed-in user becomes an admin for that operation.
    const unchecked = await asService(async (c) =>
      (
        await c.query(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname like 'admin\\_%'
           and pg_get_functiondef(p.oid) not like '%is_admin()%'
      `)
      ).rows.map((r) => r.proname)
    );
    assert.deepEqual(unchecked, [], 'every admin function must gate on is_admin()');
  });

  test('every admin MUTATION writes an audit row in the same transaction', async () => {
    const missing = await asService(async (c) =>
      (
        await c.query(`
        select p.proname
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.provolatile = 'v'
           and p.proname like 'admin\\_%'
           and p.proname <> 'admin_list_actions'
           and pg_get_functiondef(p.oid) not like '%log_admin_action%'
      `)
      ).rows.map((r) => r.proname)
    );
    assert.deepEqual(missing, [], 'an administrative change with no audit row is not auditable');
  });

  test('the three state dimensions are separate enum types', async () => {
    const columns = await asService(
      async (c) =>
        (
          await c.query(`
        select column_name, udt_name from information_schema.columns
         where table_schema = 'public' and table_name = 'orders'
           and column_name in ('order_status', 'payment_status', 'delivery_status')
         order by column_name
      `)
        ).rows
    );
    assert.deepEqual(columns, [
      { column_name: 'delivery_status', udt_name: 'delivery_status' },
      { column_name: 'order_status', udt_name: 'order_status' },
      { column_name: 'payment_status', udt_name: 'payment_status' },
    ]);
  });

  test('the Postgres enums match the values in lib/orders/state.js', async () => {
    const { ORDER_STATUS, PAYMENT_STATUS, DELIVERY_STATUS } =
      await import('../lib/orders/state.js');

    for (const [typeName, jsValues] of [
      ['order_status', ORDER_STATUS],
      ['payment_status', PAYMENT_STATUS],
      ['delivery_status', DELIVERY_STATUS],
    ]) {
      const dbValues = await asService(async (c) =>
        (
          await c.query(
            `select e.enumlabel from pg_enum e
             join pg_type t on t.oid = e.enumtypid
            where t.typname = $1 order by e.enumsortorder`,
            [typeName]
          )
        ).rows.map((r) => r.enumlabel)
      );
      assert.deepEqual(
        dbValues.sort(),
        Object.values(jsValues).sort(),
        `${typeName} has drifted between the database and the application`
      );
    }
  });
});
