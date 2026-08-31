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
           and table_name in ('order_secrets', 'webhook_events', 'idempotency_keys', 'admin_actions')
      `)
        ).rows
    );
    assert.deepEqual(readable, [], 'pickup codes and provider payloads are server-only');
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
      'record_webhook_event',
      'mark_webhook_processed',
      'expire_stale_orders',
      'expire_partner_search',
      'generate_numeric_code',
      'log_order_event',
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
      'orders_one_active_delivery_per_partner',
      'payments_one_pending_per_order',
      'payments_one_succeeded_per_order',
      'payments_idempotency_key_unique',
      'payouts_run_payee_unique',
      'payouts_idempotency_key_unique',
      'webhook_events_provider_event_unique',
      'allocations_order_payee_unique',
      'settlement_runs_period_unique',
      'users_phone_key',
      'partner_profiles_student_id_unique',
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
