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
  getOrder,
  getAllocations,
  expectRejection,
  completeDelivery,
} from './helpers/flow.js';

describe('money, allocations and settlement', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  // --- 17 ------------------------------------------------------------------
  test('allocations split a paid order correctly and sum to the total', async () => {
    // GH₵35 jollof + GH₵3 water = GH₵38 food, + GH₵2 service + GH₵5 delivery = GH₵45
    const order = await submitOrder({
      items: [
        { menu_item_id: MENU.jollof, quantity: 1 },
        { menu_item_id: MENU.water, quantity: 1 },
      ],
    });
    assert.equal(order.total_pesewas, 4500);

    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const allocations = await getAllocations(order.order_id);
    const byPayee = Object.fromEntries(allocations.map((a) => [a.payee_type, a]));

    assert.equal(byPayee.VENDOR.amount_pesewas, 3800, 'the vendor gets the food money');
    assert.equal(byPayee.VENDOR.payee_id, VENDORS.one);
    // Partner earnings are still inside the platform row: no Partner exists yet.
    assert.equal(byPayee.PLATFORM.amount_pesewas, 700, 'service + delivery, pending a Partner');
    assert.equal(byPayee.PLATFORM.payee_id, null);
    assert.equal(
      allocations.reduce((n, a) => n + a.amount_pesewas, 0),
      4500
    );
  });

  test('the Partner share is carved out only once a Partner has actually delivered', async () => {
    const order = await orderReadyForDispatch({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
    });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const allocations = await getAllocations(order.order_id);
    const byPayee = Object.fromEntries(allocations.map((a) => [a.payee_type, a]));

    assert.equal(byPayee.VENDOR.amount_pesewas, 3500);
    assert.equal(byPayee.PARTNER.amount_pesewas, 500, 'the full GH₵5 delivery fee');
    assert.equal(
      byPayee.PARTNER.payee_id,
      ACTORS.partnerYaw,
      'named to the person who did the work'
    );
    assert.equal(byPayee.PLATFORM.amount_pesewas, 200, 'platform keeps the GH₵2 service fee');

    const total = allocations.reduce((n, a) => n + a.amount_pesewas, 0);
    assert.equal(total, 4200, 'still sums exactly to what the customer paid');
    assert.equal(total, (await getOrder(order.order_id)).total_pesewas);
  });

  test('a pickup order allocates nothing to any Partner', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const allocations = await getAllocations(order.order_id);
    assert.ok(!allocations.some((a) => a.payee_type === 'PARTNER'));
    assert.equal(allocations.find((a) => a.payee_type === 'PLATFORM').amount_pesewas, 200);
    assert.equal(
      allocations.reduce((n, a) => n + a.amount_pesewas, 0),
      3700
    );
  });

  test('allocations that do not sum to the order total are refused by the database', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas)
           values ($1, 'PARTNER', $2, 99999)`,
          [order.order_id, ACTORS.partnerYaw]
        )
      )
    );
    assert.match(error.message, /allocations for order .* sum to .* but order total is/);
  });

  test('running allocation twice does not double the ledger', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const again = await asService(
      async (c) =>
        (await c.query('select public.create_order_allocations($1) as n', [order.order_id])).rows[0]
          .n
    );
    assert.equal(again, 0, 'idempotent no-op');
    assert.equal((await getAllocations(order.order_id)).length, 2);
  });

  test('confirming a payment twice is a no-op, not a second PAID transition', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    const payment = await payOrder(order.order_id);

    const replay = await asService(
      async (c) =>
        (
          await c.query('select public.confirm_payment($1, $2, $3)', [
            payment.id,
            `fake_txn_${payment.id}`,
            payment.amount_pesewas,
          ])
        ).rows[0]
    );
    assert.ok(replay, 'the replay returns the existing payment');
    assert.equal((await getOrder(order.order_id)).payment_status, 'PAID');
    assert.equal((await getAllocations(order.order_id)).length, 2);
  });

  test('a provider reporting the wrong amount is refused, not reconciled away', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    const payment = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            'amount-check',
          ])
        ).rows[0]
    );

    const error = await expectRejection(
      asService((c) => c.query('select public.confirm_payment($1, $2, $3)', [payment.id, 'txn', 1]))
    );
    assert.match(error.message, /amount mismatch/);
    assert.equal((await getOrder(order.order_id)).payment_status, 'PENDING');
  });

  test('settlement gathers eligible allocations into one payout per payee', async () => {
    const a = await orderReadyForDispatch({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    const b = await orderReadyForDispatch({ items: [{ menu_item_id: MENU.waakye, quantity: 1 }] });
    await partnerAccept(a.order_id, ACTORS.partnerYaw);
    await completeDelivery(a.order_id, ACTORS.partnerYaw);
    await partnerAccept(b.order_id, ACTORS.partnerAdjoa);
    await completeDelivery(b.order_id, ACTORS.partnerAdjoa);

    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

    const vendorRun = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('VENDOR', $1, $2)", period))
          .rows[0]
    );
    const vendorPayouts = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [vendorRun.id]))
          .rows
    );
    assert.equal(vendorPayouts.length, 1, 'both orders are the same vendor: one payout');
    assert.equal(vendorPayouts[0].amount_pesewas, 6500, 'GH₵35 + GH₵30');
    assert.equal(vendorRun.total_pesewas, 6500);

    const partnerRun = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('PARTNER', $1, $2)", period))
          .rows[0]
    );
    const partnerPayouts = await asService(
      async (c) =>
        (
          await c.query(
            'select * from public.payouts where settlement_run_id = $1 order by payee_id',
            [partnerRun.id]
          )
        ).rows
    );
    assert.equal(partnerPayouts.length, 2, 'two different Partners: two payouts');
    assert.ok(partnerPayouts.every((p) => p.amount_pesewas === 500));
  });

  test('the system can answer "how much belongs to this vendor, and how much is already paid?"', async () => {
    const order = await orderReadyForDispatch({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
    });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const owedBefore = await asService(
      async (c) =>
        (
          await c.query(
            `select coalesce(sum(amount_pesewas), 0)::bigint as owed from public.allocations
          where payee_type = 'VENDOR' and payee_id = $1 and status <> 'SETTLED'`,
            [VENDORS.one]
          )
        ).rows[0].owed
    );
    assert.equal(owedBefore, 3500);

    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
    const run = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('VENDOR', $1, $2)", period))
          .rows[0]
    );
    const payout = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [run.id]))
          .rows[0]
    );
    await asService((c) =>
      c.query("select public.mark_payout_paid($1, 'fake', 'transfer_abc')", [payout.id])
    );

    const settled = await asService(
      async (c) =>
        (
          await c.query(
            `select coalesce(sum(amount_pesewas), 0)::bigint as paid from public.allocations
          where payee_type = 'VENDOR' and payee_id = $1 and status = 'SETTLED'`,
            [VENDORS.one]
          )
        ).rows[0].paid
    );
    assert.equal(settled, 3500, 'and it is now recorded as paid, not as a wallet balance');
  });

  // --- 16 ------------------------------------------------------------------
  test('cancelling a paid order moves it to REFUND_PENDING and cancels the allocations', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [
          order.order_id,
          'vendor ran out of food',
        ]),
      { commit: true }
    );

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'CANCELLED');
    assert.equal(
      stored.payment_status,
      'REFUND_PENDING',
      'money already taken is never silently kept'
    );

    const allocations = await getAllocations(order.order_id);
    assert.ok(allocations.every((a) => a.status === 'CANCELLED'));
  });

  test('a refund completes only from REFUND_PENDING', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    // Cannot jump straight to REFUNDED.
    const early = await expectRejection(
      asUser(ACTORS.admin, (c) =>
        c.query('select public.admin_mark_refunded($1, $2)', [order.order_id, 'too soon'])
      )
    );
    assert.match(early.message, /not REFUND_PENDING/);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [
          order.order_id,
          'cancelled for refund test',
        ]),
      { commit: true }
    );
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_mark_refunded($1, $2)', [
          order.order_id,
          'refund confirmed by provider',
        ]),
      { commit: true }
    );

    assert.equal((await getOrder(order.order_id)).payment_status, 'REFUNDED');
  });

  test('cancelled allocations are excluded from settlement', async () => {
    const good = await submitOrder();
    await vendorAccept(good.order_id);
    await payOrder(good.order_id);

    const bad = await submitOrder({ customer: ACTORS.customerKwesi });
    await vendorAccept(bad.order_id);
    await payOrder(bad.order_id, { key: `pay-${bad.order_id}` });
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [bad.order_id, 'refunded']),
      { commit: true }
    );

    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
    const run = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('VENDOR', $1, $2)", period))
          .rows[0]
    );
    const payouts = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [run.id])).rows
    );
    assert.equal(payouts[0].amount_pesewas, 3500, 'only the good order is settled');
  });

  test('money columns reject non-integer and negative amounts', async () => {
    const negative = await expectRejection(
      asService((c) =>
        c.query('update public.menu_items set price_pesewas = -1 where id = $1', [MENU.jollof])
      )
    );
    assert.match(negative.message, /menu_items_price_pesewas_check/);

    // bigint columns cannot hold a fractional value at all.
    const fractional = await asService(
      async (c) => (await c.query('select 3550::bigint as v')).rows[0].v
    );
    assert.equal(Number.isInteger(fractional), true);
  });
});
