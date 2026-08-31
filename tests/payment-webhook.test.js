import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, asUser, resetTransactionalState, closePools, ACTORS } from './helpers/db.js';
import { submitOrder, vendorAccept, getOrder, expectRejection } from './helpers/flow.js';

/**
 * The webhook path is the only thing that can mark an order PAID, so it gets
 * its own tests: deduplication, signature handling, and the states either side.
 */
describe('payment webhook handling', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  async function acceptedOrder() {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    return order;
  }

  async function intent(orderId, attempt = 1) {
    return asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            orderId,
            `order:${orderId}:attempt:${attempt}`,
          ])
        ).rows[0]
    );
  }

  const recordEvent = (eventId, valid = true) =>
    asService(
      async (c) =>
        (
          await c.query('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
            'fake',
            eventId,
            JSON.stringify({ eventId }),
            valid,
          ])
        ).rows[0]
    );

  test('the same provider event delivered five times is new exactly once', async () => {
    const deliveries = await Promise.all([1, 2, 3, 4, 5].map(() => recordEvent('evt_retry')));
    assert.equal(deliveries.filter((d) => d.is_new).length, 1);
    assert.equal(new Set(deliveries.map((d) => d.webhook_id)).size, 1);
  });

  test('a duplicate event cannot confirm a payment twice', async () => {
    const order = await acceptedOrder();
    const payment = await intent(order.order_id);

    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn_1',
        payment.amount_pesewas,
      ])
    );
    // A replayed confirmation is a no-op, not a second PAID transition.
    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn_1',
        payment.amount_pesewas,
      ])
    );

    const payments = await asService(
      async (c) =>
        (await c.query('select * from public.payments where order_id = $1', [order.order_id])).rows
    );
    assert.equal(payments.length, 1);
    assert.equal(payments[0].status, 'SUCCEEDED');

    const allocations = await asService(
      async (c) =>
        (await c.query('select * from public.allocations where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(allocations.length, 2, 'the ledger is written once');
  });

  test('an event with an invalid signature is stored, flagged, and never acted on', async () => {
    const recorded = await recordEvent('evt_forged', false);
    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.webhook_events where id = $1', [recorded.webhook_id]))
          .rows[0]
    );
    assert.equal(stored.status, 'INVALID_SIGNATURE');
    assert.equal(stored.signature_valid, false);
  });

  test('a provider reporting the wrong amount cannot confirm the payment', async () => {
    const order = await acceptedOrder();
    const payment = await intent(order.order_id);

    const error = await expectRejection(
      asService((c) => c.query('select public.confirm_payment($1, $2, $3)', [payment.id, 'txn', 1]))
    );
    assert.match(error.message, /amount mismatch/);
    assert.equal((await getOrder(order.order_id)).payment_status, 'PENDING');
  });

  test('confirming a payment moves the order and writes the ledger together', async () => {
    const order = await acceptedOrder();
    const payment = await intent(order.order_id);

    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn',
        payment.amount_pesewas,
      ])
    );

    const stored = await getOrder(order.order_id);
    assert.equal(stored.payment_status, 'PAID');
    assert.equal(
      stored.order_status,
      'ACCEPTED',
      'payment does not move the food forward by itself'
    );

    const allocations = await asService(
      async (c) =>
        (await c.query('select * from public.allocations where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(
      allocations.reduce((sum, a) => sum + a.amount_pesewas, 0),
      stored.total_pesewas,
      'allocations sum to what the customer paid'
    );
  });

  test('a failed payment leaves the vendor acceptance standing', async () => {
    const order = await acceptedOrder();
    const payment = await intent(order.order_id);
    await asService((c) => c.query('select public.fail_payment($1, $2)', [payment.id, 'declined']));

    const stored = await getOrder(order.order_id);
    assert.equal(stored.payment_status, 'FAILED');
    assert.equal(stored.order_status, 'ACCEPTED', 'the customer can try again without reordering');
  });

  test('webhook_events is unreadable and unwritable by any client', async () => {
    await recordEvent('evt_private');
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.admin]) {
      const error = await expectRejection(
        asUser(actor, (c) => c.query('select * from public.webhook_events'))
      );
      assert.match(error.message, /permission denied/i);
    }

    const write = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.record_webhook_event($1, $2, $3::jsonb, $4)', [
          'fake',
          'evt_forged_by_client',
          '{}',
          true,
        ])
      )
    );
    assert.match(write.message, /permission denied/i);
  });

  test('only one live payment intent can exist per order — checked twice', async () => {
    const order = await acceptedOrder();
    await intent(order.order_id, 1);

    // The function refuses first, with a message a person can act on.
    const viaFunction = await expectRejection(intent(order.order_id, 2));
    assert.match(viaFunction.message, /payment is already PENDING/);

    // And the index refuses even a direct insert that skips the function.
    const viaIndex = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
           values ($1, 'fake', 100, 'sneaky', 'PENDING')`,
          [order.order_id]
        )
      )
    );
    assert.match(viaIndex.message, /payments_one_pending_per_order/);
  });

  test('an order cannot be charged twice even across attempts', async () => {
    const order = await acceptedOrder();
    const payment = await intent(order.order_id);
    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn',
        payment.amount_pesewas,
      ])
    );

    // A second intent is refused because the order is no longer payable.
    const error = await expectRejection(intent(order.order_id, 2));
    assert.match(error.message, /payment is already PAID/);
  });
});
