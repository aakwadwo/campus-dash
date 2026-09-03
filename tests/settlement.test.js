import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  MENU,
} from './helpers/db.js';
import {
  submitOrder,
  vendorAccept,
  payOrder,
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
  getSecrets,
  expectRejection,
  tryTransition,
} from './helpers/flow.js';

/**
 * Settlement and reconciliation.
 *
 * The question these answer is always the same: how much belongs to whom, has
 * it left yet, and could pressing the button twice pay anybody twice.
 */
describe('settlement and reconciliation', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const PERIOD = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

  const run = (payeeType) =>
    asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            payeeType,
            ...PERIOD,
          ])
        ).rows[0]
    );

  const payoutsFor = (runId) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select * from public.payouts where settlement_run_id = $1 order by amount_pesewas desc',
            [runId]
          )
        ).rows
    );

  const adminRows = (sql, params) =>
    asUser(ACTORS.admin, async (c) => (await c.query(sql, params)).rows);

  /**
   * Temporarily lifts the balance trigger.
   *
   * Only for simulating states the trigger normally makes impossible. Always
   * re-enables, even if the body throws — leaving it off would silently disarm
   * the money safety for every test that follows.
   */
  async function withBalanceTriggerDisabled(fn) {
    await asService(async (c) => {
      await c.query('alter table public.allocations disable trigger allocations_must_balance');
      try {
        await fn(c);
      } finally {
        await c.query('alter table public.allocations enable trigger allocations_must_balance');
      }
    });
  }

  /** A delivered order, so there is money for all three payees. */
  async function deliveredOrder(options = {}) {
    const order = await orderReadyForDispatch(options);
    await partnerAccept(order.order_id, options.partner ?? ACTORS.partnerYaw);
    await completeDelivery(order.order_id, options.partner ?? ACTORS.partnerYaw);
    return order;
  }

  // =========================================================================
  // Allocation correctness
  // =========================================================================
  test('a delivered order splits three ways and sums to what was paid', async () => {
    const order = await deliveredOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });

    const money = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_order_money($1)', [order.order_id])).rows[0]
    );

    assert.equal(money.vendor_allocation, 3500, 'the food money');
    assert.equal(money.partner_allocation, 500, 'the delivery fee');
    assert.equal(money.platform_allocation, 175, 'the service fee');
    assert.equal(money.allocated_pesewas, 4175);
    assert.equal(money.total_pesewas, 4175);
    assert.equal(money.balances, true);
    assert.equal(money.paid_pesewas, 4175);
  });

  test('a pickup order allocates nothing to a Partner', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const money = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_order_money($1)', [order.order_id])).rows[0]
    );
    assert.equal(money.partner_allocation, 0);
    assert.equal(money.balances, true);
  });

  // =========================================================================
  // Runs and payouts
  // =========================================================================
  test('a vendor run gathers what is owed and pays it once', async () => {
    await deliveredOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    await deliveredOrder({
      items: [{ menu_item_id: MENU.waakye, quantity: 1 }],
      partner: ACTORS.partnerAdjoa,
    });

    const settlement = await run('VENDOR');
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 1, 'one vendor, one payout');
    assert.equal(payouts[0].amount_pesewas, 6500, 'GH₵35 + GH₵30');
    assert.equal(settlement.total_pesewas, 6500);
  });

  test('a Partner run pays each Partner separately', async () => {
    await deliveredOrder({ partner: ACTORS.partnerYaw });
    await deliveredOrder({ partner: ACTORS.partnerAdjoa });

    const settlement = await run('PARTNER');
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 2);
    assert.ok(payouts.every((p) => p.amount_pesewas === 500));
  });

  test('running the same period twice pays nobody twice', async () => {
    await deliveredOrder();

    const first = await run('VENDOR');
    const second = await run('VENDOR');
    assert.equal(second.id, first.id, 'the same run comes back');

    const payouts = await payoutsFor(first.id);
    assert.equal(payouts.length, 1);

    const total = await asService(async (c) =>
      Number((await c.query('select count(*)::int as n from public.payouts')).rows[0].n)
    );
    assert.equal(total, 1, 'no second payout anywhere');
  });

  test('a second run over the same allocations finds nothing left', async () => {
    await deliveredOrder();
    await run('VENDOR');

    const later = await asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            'VENDOR',
            '2100-01-02T00:00:00Z',
            '2100-01-03T00:00:00Z',
          ])
        ).rows[0]
    );
    const payouts = await payoutsFor(later.id);
    assert.equal(payouts.length, 0, 'the allocations were already claimed');
    assert.equal(later.total_pesewas, 0);
  });

  test('a duplicate payout for the same payee in a run is impossible', async () => {
    await deliveredOrder();
    const settlement = await run('VENDOR');

    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
           values ($1, 'VENDOR', $2, 100, 'forged-key')`,
          [settlement.id, VENDORS.one]
        )
      )
    );
    assert.match(error.message, /payouts_run_payee_unique/);
  });

  test('marking a payout paid settles its allocations and is idempotent', async () => {
    const order = await deliveredOrder();
    const settlement = await run('VENDOR');
    const [payout] = await payoutsFor(settlement.id);

    await asService((c) =>
      c.query("select public.mark_payout_paid($1, 'fake', 'transfer_1')", [payout.id])
    );
    await asService((c) =>
      c.query("select public.mark_payout_paid($1, 'fake', 'transfer_1')", [payout.id])
    );

    const allocations = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.allocations where order_id = $1 and payee_type = 'VENDOR'",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(allocations[0].status, 'SETTLED');
    assert.ok(allocations[0].settled_at);

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where id = $1', [payout.id])).rows[0]
    );
    assert.equal(stored.status, 'PAID');
    assert.equal(stored.provider_transfer_id, 'transfer_1');
  });

  test('a cancelled order is excluded from settlement', async () => {
    const good = await deliveredOrder();
    const bad = await submitOrder({ customer: ACTORS.customerKwesi });
    await vendorAccept(bad.order_id);
    await payOrder(bad.order_id);
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [bad.order_id, 'vendor closed']),
      { commit: true }
    );

    const settlement = await run('VENDOR');
    const [payout] = await payoutsFor(settlement.id);
    assert.equal(payout.amount_pesewas, 3500, 'only the good order');
    assert.ok(good.order_id);
  });

  // =========================================================================
  // What each party sees about their own money
  // =========================================================================
  test('a vendor sees earned, awaiting and settled — never a balance', async () => {
    await deliveredOrder();

    let summary = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.vendor_earnings_summary($1)', [VENDORS.one])).rows[0]
    );
    assert.equal(summary.earned_pesewas, 3500);
    assert.equal(summary.awaiting_pesewas, 3500);
    assert.equal(summary.settled_pesewas, 0);

    const settlement = await run('VENDOR');
    const [payout] = await payoutsFor(settlement.id);
    await asService((c) =>
      c.query("select public.mark_payout_paid($1, 'fake', 'transfer_x')", [payout.id])
    );

    summary = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.vendor_earnings_summary($1)', [VENDORS.one])).rows[0]
    );
    assert.equal(summary.awaiting_pesewas, 0);
    assert.equal(summary.settled_pesewas, 3500);
  });

  test("a vendor cannot see another vendor's earnings", async () => {
    await deliveredOrder();
    const rows = await asUser(
      ACTORS.vendor2Staff,
      async (c) =>
        (await c.query('select * from public.vendor_earnings_summary($1)', [VENDORS.one])).rows
    );
    assert.equal(rows[0].earned_pesewas, 0, 'the filter is inside the function');
  });

  test('a Partner sees only their own earnings', async () => {
    await deliveredOrder({ partner: ACTORS.partnerYaw });

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(mine.earned_pesewas, 500);

    const theirs = await asUser(
      ACTORS.partnerAdjoa,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(theirs.earned_pesewas, 0);
  });

  // =========================================================================
  // Reconciliation
  // =========================================================================
  test('a healthy system reconciles to nothing', async () => {
    await deliveredOrder();
    const issues = await adminRows('select * from public.admin_reconciliation()');
    assert.deepEqual(issues, [], 'no discrepancies is the good outcome');
  });

  test('reconciliation catches an order marked PAID with no allocations', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    // Simulate the ledger failing to write.
    await asService((c) =>
      c.query('delete from public.allocations where order_id = $1', [order.order_id])
    );

    const issues = await adminRows('select * from public.admin_reconciliation()');
    const issue = issues.find((i) => i.order_id === order.order_id);
    assert.ok(issue);
    assert.equal(issue.issue, 'NO_ALLOCATIONS');
  });

  test('the balance trigger refuses to let allocations drift in the first place', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const error = await expectRejection(
      asService((c) =>
        c.query("delete from public.allocations where order_id = $1 and payee_type = 'PLATFORM'", [
          order.order_id,
        ])
      )
    );
    assert.match(error.message, /sum to 3500 but order total is 4175/);
  });

  test('reconciliation still catches an imbalance if one ever appeared', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    // The deferred trigger makes this state unreachable through normal DML —
    // which is why a healthy system reconciles to nothing. Disabling it here
    // simulates the case the report exists as a backstop FOR: a restore from
    // backup, a migration that dropped the trigger, or direct repair gone wrong.
    await withBalanceTriggerDisabled(async (c) => {
      await c.query(
        "delete from public.allocations where order_id = $1 and payee_type = 'PLATFORM'",
        [order.order_id]
      );
    });

    const issues = await adminRows('select * from public.admin_reconciliation()');
    const issue = issues.find((i) => i.order_id === order.order_id);
    assert.ok(issue, 'the discrepancy is reported');
    assert.equal(issue.issue, 'ALLOCATION_MISMATCH');
    assert.match(issue.detail, /allocations sum to 3500 but the order total is 4175/);
  });

  test('reconciliation catches a delivered order with no Partner allocation', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
      order.order_id,
      secrets.delivery_code,
    ]);

    await withBalanceTriggerDisabled(async (c) => {
      await c.query(
        `delete from public.allocations where order_id = $1 and payee_type = 'PARTNER'`,
        [order.order_id]
      );
    });

    const issues = await adminRows('select * from public.admin_reconciliation()');
    assert.ok(issues.some((i) => i.order_id === order.order_id && i.issue === 'PARTNER_UNPAID'));
  });

  test('only an admin can see settlement, reconciliation or payouts', async () => {
    await deliveredOrder();
    await run('VENDOR');

    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.partnerYaw]) {
      for (const sql of [
        'select * from public.admin_reconciliation()',
        "select * from public.admin_pending_settlement('VENDOR')",
        'select * from public.admin_settlement_runs()',
        'select * from public.admin_payments()',
      ]) {
        const rows = await asUser(actor, async (c) => (await c.query(sql)).rows);
        assert.deepEqual(rows, [], `${sql} must return nothing for a non-admin`);
      }
    }
  });

  test('nobody but the server can create a settlement run or mark a payout paid', async () => {
    for (const [sql, params] of [
      ["select public.create_settlement_run('VENDOR', $1, $2)", PERIOD],
      ["select public.mark_payout_paid($1, 'fake', 'x')", ['00000000-0000-0000-0000-000000000000']],
    ]) {
      const error = await expectRejection(asUser(ACTORS.admin, (c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i);
    }
  });
});
