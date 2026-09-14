import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  closePools,
  resetTransactionalState,
  ACTORS,
  VENDORS,
} from './helpers/db.js';
import { paidOrder, vendorReady, partnerAccept, completeDelivery } from './helpers/flow.js';

/**
 * Removing pilot TEST ACCOUNTS end to end.
 *
 * WHAT MUST REMAIN TRUE: no client role can reach it, it refuses to touch an
 * administrator, it goes through the existing audited purge for the
 * append-only rows rather than around it, and a dependency it does not own
 * rolls the whole call back instead of leaving half an account behind.
 *
 * Every purge here runs inside a transaction that is ROLLED BACK, because it
 * deletes seeded identities the rest of the suite relies on.
 */
describe('the administrator-only test account purge', () => {
  before(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  /** Runs `fn` as the database owner acting AS `adminId`, then rolls back. */
  async function asOwnerActingAs(adminId, fn) {
    return asService(async (c) => {
      await c.query('begin');
      try {
        await c.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: adminId, role: 'authenticated' }),
        ]);
        return await fn(c);
      } finally {
        await c.query('rollback');
      }
    });
  }

  async function refusal(promise) {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    return null;
  }

  test('no client role can execute it, not even a signed-in administrator', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const { rows } = await asService((c) =>
        c.query(
          `select has_function_privilege($1, 'public.admin_purge_test_accounts(uuid[], text)', 'EXECUTE') as ok`,
          [role]
        )
      );
      assert.equal(rows[0].ok, false, `${role} must not hold EXECUTE`);
    }

    const error = await refusal(
      asUser(ACTORS.admin, (c) =>
        c.query(`select public.admin_purge_test_accounts(array[$1::uuid], 'nope')`, [
          ACTORS.customerEfua,
        ])
      )
    );
    assert.ok(error);
    assert.match(String(error.message), /permission denied/i);
  });

  test('without an administrator identity it is refused', async () => {
    const error = await refusal(
      asOwnerActingAs(ACTORS.customerAma, (c) =>
        c.query(`select public.admin_purge_test_accounts(array[$1::uuid], 'nope')`, [
          ACTORS.customerEfua,
        ])
      )
    );
    assert.ok(error);
    assert.match(String(error.message), /administrator access required/i);
  });

  test('it refuses an empty list, a missing reason, and any administrator', async () => {
    const empty = await refusal(
      asOwnerActingAs(ACTORS.admin, (c) =>
        c.query(`select public.admin_purge_test_accounts('{}', 'reason')`)
      )
    );
    assert.match(String(empty?.message), /name the accounts/i);

    const reasonless = await refusal(
      asOwnerActingAs(ACTORS.admin, (c) =>
        c.query(`select public.admin_purge_test_accounts(array[$1::uuid], '  ')`, [
          ACTORS.customerEfua,
        ])
      )
    );
    assert.match(String(reasonless?.message), /reason is required/i);

    const self = await refusal(
      asOwnerActingAs(ACTORS.admin, (c) =>
        c.query(`select public.admin_purge_test_accounts(array[$1::uuid], 'reason')`, [
          ACTORS.admin,
        ])
      )
    );
    assert.match(String(self?.message), /own account/i);
  });

  test('it removes the accounts, their store, orders and money, and is audited', async () => {
    // A delivered order touching all three kinds of account, so every table
    // the purge is responsible for has something in it.
    const order = await paidOrder({ customer: ACTORS.customerAma, vendorId: VENDORS.one });
    await vendorReady(order.order_id);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const targets = [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.vendor1Staff];

    await asOwnerActingAs(ACTORS.admin, async (c) => {
      const before = (
        await c.query(
          `select
             (select count(*)::int from public.admin_actions) as audit,
             (select count(*)::int from public.order_events where order_id = $1) as events,
             (select count(*)::int from public.allocations where order_id = $1) as allocations`,
          [order.order_id]
        )
      ).rows[0];
      assert.ok(before.events > 0 && before.allocations > 0, 'the fixture has history and money');

      const { rows } = await c.query(
        `select public.admin_purge_test_accounts($1::uuid[], 'pilot reset') as r`,
        [targets]
      );
      const { counts, storage_paths: paths } = rows[0].r;

      assert.equal(counts.auth_users, 3);
      assert.equal(counts.vendors, 1);
      assert.ok(counts.orders >= 1);
      assert.ok(counts.payments >= 1);
      assert.ok(counts.allocations >= 1);
      assert.ok(Array.isArray(paths['partner-documents']));
      assert.ok(
        paths['partner-documents'].some((p) => p.includes('student-id')),
        'the Partner document paths come back for the Storage API'
      );

      const after = (
        await c.query(
          `select
             (select count(*)::int from auth.users where id = any($1)) as auth_users,
             (select count(*)::int from public.users where id = any($1)) as users,
             (select count(*)::int from public.vendors where id = $2) as vendors,
             (select count(*)::int from public.menu_items where vendor_id = $2) as menu,
             (select count(*)::int from public.orders where id = $3) as orders,
             (select count(*)::int from public.order_events where order_id = $3) as events,
             (select count(*)::int from public.payments where order_id = $3) as payments,
             (select count(*)::int from public.allocations where order_id = $3) as allocations,
             (select count(*)::int from public.partner_ratings where order_id = $3) as ratings,
             (select count(*)::int from public.admin_actions) as audit,
             (select count(*)::int from public.users where id = $4 and is_admin) as admin`,
          [targets, VENDORS.one, order.order_id, ACTORS.admin]
        )
      ).rows[0];

      assert.deepEqual(
        { ...after, audit: undefined },
        {
          auth_users: 0,
          users: 0,
          vendors: 0,
          menu: 0,
          orders: 0,
          events: 0,
          payments: 0,
          allocations: 0,
          ratings: 0,
          audit: undefined,
          admin: 1,
        }
      );
      assert.equal(
        after.audit,
        before.audit + 2,
        'the history purge and this call are both audited'
      );

      const { rows: audit } = await c.query(
        `select action from public.admin_actions order by id desc limit 2`
      );
      assert.deepEqual(
        audit.map((r) => r.action),
        ['TEST_ACCOUNTS_PURGED', 'TEST_HISTORY_PURGED']
      );
    });
  });

  test('a dependency it does not own rolls the whole call back', async () => {
    // Efua is named; Kwesi's order is not hers, so it is not purged. An event on
    // that order naming Efua as its ACTOR would need a SET NULL on an
    // append-only table. The guard must refuse it and nothing may be removed.
    const order = await paidOrder({ customer: ACTORS.customerKwesi, vendorId: VENDORS.one });

    await asOwnerActingAs(ACTORS.admin, async (c) => {
      await c.query(
        `insert into public.order_events (order_id, actor_id, actor_role, event, accepted)
         values ($1, $2, 'CUSTOMER', 'TEST_FIXTURE', true)`,
        [order.order_id, ACTORS.customerEfua]
      );

      await c.query('savepoint before_purge');
      const error = await refusal(
        c.query(`select public.admin_purge_test_accounts(array[$1::uuid], 'reason')`, [
          ACTORS.customerEfua,
        ])
      );
      assert.ok(error, 'the append-only guard on order_events must still hold');
      assert.match(String(error.message), /append-only/i);
      await c.query('rollback to savepoint before_purge');

      const { rows } = await c.query(
        `select (select count(*)::int from auth.users where id = $1) as account,
                (select count(*)::int from public.customer_profiles where user_id = $1) as profile`,
        [ACTORS.customerEfua]
      );
      assert.deepEqual(rows[0], { account: 1, profile: 1 }, 'nothing was removed');
    });
  });
});
