import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  dedicatedClient,
  resetTransactionalState,
  closePools,
  ACTORS,
} from './helpers/db.js';
import {
  orderReadyForDispatch,
  partnerAccept,
  getOrder,
  expectRejection,
  submitOrder,
  vendorAccept,
  completeDelivery,
} from './helpers/flow.js';

describe('concurrency and idempotency', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  // --- 1 -------------------------------------------------------------------
  test('two Partners accepting the same delivery: exactly one wins', async () => {
    const order = await orderReadyForDispatch();

    const yaw = await dedicatedClient(ACTORS.partnerYaw);
    const adjoa = await dedicatedClient(ACTORS.partnerAdjoa);

    try {
      // Fired without an enclosing transaction so both genuinely race to commit,
      // rather than one blocking on the other's open transaction.
      const results = await Promise.all([
        yaw.query('select * from public.partner_accept_delivery($1)', [order.order_id]),
        adjoa.query('select * from public.partner_accept_delivery($1)', [order.order_id]),
      ]);

      const envelopes = results.map((r) => r.rows[0]);
      const won = envelopes.filter((e) => e.success);
      const lost = envelopes.filter((e) => !e.success);

      assert.equal(won.length, 1, 'exactly one Partner should win the race');
      assert.equal(lost.length, 1, 'exactly one Partner should lose the race');
      assert.match(lost[0].reason, /already been taken/);
      assert.ok(won[0].pickup_code, 'the winner receives a pickup code');
      assert.equal(lost[0].pickup_code, null, 'the loser receives no pickup code');

      const stored = await getOrder(order.order_id);
      assert.equal(stored.delivery_status, 'ASSIGNED');
      assert.ok(stored.partner_id, 'the winner is recorded on the order');

      // The loss is evidence and is kept.
      const events = await asService(
        async (c) =>
          (
            await c.query(
              `select * from public.order_events
            where order_id = $1 and event = 'PARTNER_ACCEPT' and not accepted`,
              [order.order_id]
            )
          ).rows
      );
      assert.equal(events.length, 1, 'the rejected transition is logged');
    } finally {
      await yaw.end();
      await adjoa.end();
    }
  });

  // --- 5 -------------------------------------------------------------------
  test('a Partner cannot hold a second active delivery', async () => {
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();

    const won = await partnerAccept(first.order_id, ACTORS.partnerYaw);
    assert.equal(won.success, true);

    const blocked = await partnerAccept(second.order_id, ACTORS.partnerYaw);
    assert.equal(blocked.success, false, 'a second active delivery is refused');
    assert.match(blocked.reason, /already been taken/);

    const stored = await getOrder(second.order_id);
    assert.equal(stored.delivery_status, 'SEARCHING', 'the second order stays available');
    assert.equal(stored.partner_id, null);
  });

  test('the one-active-delivery rule holds at the database level, not just in the function', async () => {
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    await partnerAccept(first.order_id, ACTORS.partnerYaw);

    // Bypass every function and write the assignment directly as superuser. The
    // partial unique index must still refuse it.
    const error = await expectRejection(
      asService((c) =>
        c.query(
          `update public.orders
              set partner_id = $1, delivery_status = 'ASSIGNED', assigned_at = now()
            where id = $2`,
          [ACTORS.partnerYaw, second.order_id]
        )
      )
    );
    assert.match(error.message, /orders_one_active_delivery_per_partner/);
  });

  test('racing to accept two DIFFERENT deliveries still yields only one assignment', async () => {
    const a = await orderReadyForDispatch();
    const b = await orderReadyForDispatch();
    const yaw = await dedicatedClient(ACTORS.partnerYaw);

    try {
      const results = await Promise.all([
        yaw.query('select * from public.partner_accept_delivery($1)', [a.order_id]),
        yaw.query('select * from public.partner_accept_delivery($1)', [b.order_id]),
      ]);
      const succeeded = results.map((r) => r.rows[0]).filter((e) => e.success);
      assert.equal(succeeded.length, 1, 'one Partner, one delivery — even when racing themselves');
    } finally {
      await yaw.end();
    }
  });

  // --- 2 -------------------------------------------------------------------
  test('a repeated payment request with the same key creates exactly one payment', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const first = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            'retry-me',
          ])
        ).rows[0]
    );
    const second = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            'retry-me',
          ])
        ).rows[0]
    );

    assert.equal(second.id, first.id, 'the retry returns the SAME payment, not a second charge');

    const count = await asService(async (c) =>
      Number(
        (
          await c.query('select count(*) from public.payments where order_id = $1', [
            order.order_id,
          ])
        ).rows[0].count
      )
    );
    assert.equal(count, 1);
  });

  test('an idempotency key reused for a DIFFERENT order is rejected, not replayed', async () => {
    const a = await submitOrder();
    const b = await submitOrder({ customer: ACTORS.customerKwesi });
    await vendorAccept(a.order_id);
    await vendorAccept(b.order_id);

    await asService((c) =>
      c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        a.order_id,
        'shared-key',
      ])
    );

    const error = await expectRejection(
      asService((c) =>
        c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
          b.order_id,
          'shared-key',
        ])
      )
    );
    assert.match(error.message, /different order/);
  });

  test('only one live payment intent per order is possible', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await asService((c) =>
      c.query("select * from public.create_payment_intent($1, 'fake', $2)", [order.order_id, 'k1'])
    );

    // A second PENDING payment inserted directly must be refused by the index.
    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
           values ($1, 'fake', 100, 'k2', 'PENDING')`,
          [order.order_id]
        )
      )
    );
    assert.match(error.message, /payments_one_pending_per_order/);
  });

  // --- 3 -------------------------------------------------------------------
  test('the same webhook delivered repeatedly is processed once', async () => {
    const payload = JSON.stringify({ eventId: 'evt_dup_1', status: 'SUCCEEDED' });

    const deliveries = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        asService(
          async (c) =>
            (
              await c.query('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
                'fake',
                'evt_dup_1',
                payload,
                true,
              ])
            ).rows[0]
        )
      )
    );

    const fresh = deliveries.filter((d) => d.is_new);
    assert.equal(fresh.length, 1, 'exactly one delivery is treated as new');
    assert.equal(
      new Set(deliveries.map((d) => d.webhook_id)).size,
      1,
      'all five resolve to one row'
    );

    const count = await asService(async (c) =>
      Number(
        (await c.query("select count(*) from public.webhook_events where event_id = 'evt_dup_1'"))
          .rows[0].count
      )
    );
    assert.equal(count, 1);
  });

  test('a webhook with an invalid signature is stored but flagged, never silently trusted', async () => {
    const row = await asService(
      async (c) =>
        (
          await c.query('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
            'fake',
            'evt_bad_sig',
            JSON.stringify({ eventId: 'evt_bad_sig' }),
            false,
          ])
        ).rows[0]
    );

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.webhook_events where id = $1', [row.webhook_id]))
          .rows[0]
    );
    assert.equal(stored.status, 'INVALID_SIGNATURE');
    assert.equal(stored.signature_valid, false);
  });

  // --- 4 -------------------------------------------------------------------
  test('a repeated payout request cannot duplicate a transfer', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

    const runA = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('PARTNER', $1, $2)", period))
          .rows[0]
    );
    const runB = await asService(
      async (c) =>
        (await c.query("select * from public.create_settlement_run('PARTNER', $1, $2)", period))
          .rows[0]
    );

    assert.equal(runB.id, runA.id, 're-running the same period returns the SAME run');

    const payouts = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [runA.id])).rows
    );
    assert.equal(payouts.length, 1, 'one payout for the one Partner');

    // A duplicate payout inserted directly must be refused by the index.
    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
           values ($1, 'PARTNER', $2, 500, 'some-other-key')`,
          [runA.id, ACTORS.partnerYaw]
        )
      )
    );
    assert.match(error.message, /payouts_run_payee_unique/);
  });

  test('marking a payout paid twice is a no-op, not a second transfer', async () => {
    const order = await orderReadyForDispatch({ fulfilment: 'PICKUP', destination: null });
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

    const a = await asService(
      async (c) =>
        (
          await c.query("select * from public.mark_payout_paid($1, 'fake', 'transfer_1')", [
            payout.id,
          ])
        ).rows[0]
    );
    const b = await asService(
      async (c) =>
        (
          await c.query("select * from public.mark_payout_paid($1, 'fake', 'transfer_1')", [
            payout.id,
          ])
        ).rows[0]
    );

    assert.equal(
      a.mark_payout_paid,
      b.mark_payout_paid,
      'the replay returns the same payout unchanged'
    );
    assert.ok(order.order_id);
  });
});
