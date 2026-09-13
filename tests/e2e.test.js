import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  dedicatedClient,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  MENU,
  LOCATIONS,
} from './helpers/db.js';
import { expectRejection, setPartnerPayoutThreshold } from './helpers/flow.js';

/**
 * One realistic Campus Dash order, end to end, plus every way it can go wrong.
 *
 * Every step goes through the same function the application calls. Nothing is
 * forced with a hand-written UPDATE, so if a step passes here it is reachable
 * in production — and if it fails, the product is broken, not the test.
 */
describe('end to end', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  // --- the cast ------------------------------------------------------------
  const customer = ACTORS.customerAma;
  const vendorStaff = ACTORS.vendor1Staff;
  const partnerA = ACTORS.partnerYaw;
  const partnerB = ACTORS.partnerAdjoa;

  const act = (userId, sql, params) =>
    asUser(userId, async (c) => (await c.query(sql, params)).rows[0], { commit: true });

  const envelope = (row) => {
    const value = Object.values(row)[0];
    if (typeof value === 'string') return { success: value.startsWith('(t'), raw: value };
    return value;
  };

  const orderRow = (orderId) =>
    asService(
      async (c) => (await c.query('select * from public.orders where id = $1', [orderId])).rows[0]
    );

  const secrets = (orderId) =>
    asService(
      async (c) =>
        (await c.query('select * from public.order_secrets where order_id = $1', [orderId])).rows[0]
    );

  const BASKET = JSON.stringify([
    { menu_item_id: MENU.jollof, quantity: 2 },
    { menu_item_id: MENU.water, quantity: 1 },
  ]);

  /**
   * Steps 1–4: the customer picks a store, some food, and how they want it.
   *
   * ALL OF IT AT THE CHECKOUT. There is no vendor to wait on, so there is
   * nothing to put the fulfilment question after — the price the customer is
   * quoted is the price they are about to pay, delivery fee included.
   */
  async function customerOrders({ fulfilment = 'DELIVERY', note = 'Blue door on the left' } = {}) {
    const quote = await asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.quote_order($1, $2::jsonb, $3)', [
            VENDORS.one,
            BASKET,
            fulfilment,
          ])
        ).rows[0]
    );

    const order = await asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.submit_order($1, $2::jsonb, $3, $4, $5)', [
            VENDORS.one,
            BASKET,
            fulfilment,
            fulfilment === 'DELIVERY' ? LOCATIONS.room204 : null,
            fulfilment === 'DELIVERY' ? note : null,
          ])
        ).rows[0],
      { commit: true }
    );

    return { quote, order };
  }

  /** Changing the choice, which is only possible while nothing has been paid. */
  const choosePickup = (orderId) =>
    act(customer, 'select public.customer_choose_fulfilment($1, $2, null, null)', [
      orderId,
      'PICKUP',
    ]);

  /** Steps 9–10: the provider takes the money. */
  async function customerPays(orderId) {
    return asService(async (c) => {
      const payment = (
        await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
          orderId,
          `order:${orderId}:attempt:1`,
        ])
      ).rows[0];
      await c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        `fake_txn_${payment.id}`,
        payment.amount_pesewas,
      ]);
      return payment;
    });
  }

  // =========================================================================
  // THE HAPPY PATH
  // =========================================================================
  test('a complete order: customer → payment → store → Partner → delivered → settled', async () => {
    // 1–4. Customer picks a store, food, delivery and a room, and is quoted the
    // FINAL price: 2×GH₵35 + GH₵3 food, +5% (GH₵3.65), + GH₵5 delivery.
    const { quote, order } = await customerOrders();
    assert.equal(quote.total_pesewas, 8307);
    assert.equal(order.total_pesewas, quote.total_pesewas, 'quoted and submitted agree');
    assert.equal(order.vendor_order_no, 1, 'the number the store will call out');

    // 5. THE STORE SEES NOTHING YET. An unpaid order is not a ticket.
    const beforePaying = await asUser(
      vendorStaff,
      async (c) =>
        (await c.query('select * from public.vendor_order_board($1)', [VENDORS.one])).rows
    );
    assert.deepEqual(beforePaying, []);

    // 6–7. The customer pays; the provider confirms. That is what reaches the
    // kitchen AND what opens the search for a Partner.
    await customerPays(order.order_id);
    const paid = await orderRow(order.order_id);
    assert.equal(paid.payment_status, 'PAID');
    assert.equal(paid.order_status, 'PREPARING');
    assert.equal(paid.delivery_status, 'SEARCHING');
    assert.equal(paid.delivery_fee_pesewas, 500);

    // 8. Now it is on the board, paid, with the queue number on it.
    const board = await asUser(
      vendorStaff,
      async (c) =>
        (await c.query('select * from public.vendor_order_board($1)', [VENDORS.one])).rows
    );
    const card = board.find((b) => b.order_id === order.order_id);
    assert.equal(card.bucket, 'NEW');
    assert.equal(card.payment_status, 'PAID');
    assert.equal(card.vendor_order_no, 1);
    assert.equal(card.fulfilment_type, 'DELIVERY');

    // 9–10. Both Partners see the offer — WHILE THE FOOD IS STILL COOKING.
    for (const partner of [partnerA, partnerB]) {
      const offers = await asUser(
        partner,
        async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
      );
      const offer = offers.find((o) => o.order_id === order.order_id);
      assert.ok(offer, 'the pool opens at payment');
      assert.equal(offer.food_is_ready, false, 'and says plainly that it is not ready yet');
    }

    // 11. The store makes it and presses Ready. That is the store's only button.
    await act(vendorStaff, 'select public.vendor_mark_ready($1)', [order.order_id]);
    assert.equal((await orderRow(order.order_id)).order_status, 'READY');

    // 13–14. Both Partners see the offer.
    for (const partner of [partnerA, partnerB]) {
      const offers = await asUser(
        partner,
        async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
      );
      assert.ok(
        offers.some((o) => o.order_id === order.order_id),
        'both are offered the job'
      );
    }

    // 15–16. They race; exactly one wins, atomically.
    const clients = await Promise.all([partnerA, partnerB].map((id) => dedicatedClient(id)));
    let winner;
    let loser;
    try {
      const results = await Promise.all(
        clients.map((client) =>
          client.query('select * from public.partner_accept_delivery($1)', [order.order_id])
        )
      );
      const envelopes = results.map((r) => r.rows[0]);
      winner = envelopes.find((e) => e.success);
      loser = envelopes.find((e) => !e.success);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    assert.ok(winner, 'somebody won');
    assert.ok(loser, 'somebody lost');
    assert.match(loser.reason, /already been taken/);

    // 17. The winner is told which job is theirs — and NOT the pickup code.
    // That belongs to the vendor now, who reads it out at the counter.
    assert.ok(winner.order_number);
    assert.ok(!('pickup_code' in winner));
    const assigned = await orderRow(order.order_id);
    const winnerId = assigned.partner_id;
    const loserId = winnerId === partnerA ? partnerB : partnerA;

    // 18. From the moment it is theirs, the assigned Partner has the room and
    // the customer's number — before they are holding food that is going cold.
    const before = await asUser(
      winnerId,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0]
    );
    assert.match(before.destination, /Room 204/);
    assert.ok(before.customer_phone, 'and somebody to ring on arrival');

    // 19. The VENDOR reads the code off their own screen; the PARTNER types it
    // in. Neither half of that is available to the other.
    const handoffCode = await asUser(
      vendorStaff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.match(handoffCode, /^\d{4}$/);

    assert.equal(
      envelope(
        await act(winnerId, 'select public.partner_confirm_pickup($1, $2)', [
          order.order_id,
          handoffCode,
        ])
      ).success,
      true
    );

    // 20. The Partner is carrying the food.
    const after = await asUser(
      winnerId,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0]
    );
    assert.match(after.destination, /Room 204/);
    assert.equal(after.destination_note, 'Blue door on the left');
    assert.equal(after.customer_phone, '+233200000021');

    // 21–23. The customer reads out their code; the delivery completes.
    const code = await asUser(
      customer,
      async (c) =>
        (await c.query('select public.get_my_delivery_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.equal(
      envelope(
        await act(winnerId, 'select public.partner_complete_delivery($1, $2)', [
          order.order_id,
          code,
        ])
      ).success,
      true
    );

    const done = await orderRow(order.order_id);
    assert.equal(done.order_status, 'COMPLETED');
    assert.equal(done.payment_status, 'PAID');
    assert.equal(done.delivery_status, 'DELIVERED');

    // 24. The money is allocated, and it adds up.
    const money = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_order_money($1)', [order.order_id])).rows[0]
    );
    assert.equal(money.vendor_allocation, 7300, 'the food');
    assert.equal(money.partner_allocation, 500, 'the delivery fee');
    assert.equal(money.platform_allocation, 507, 'the service fee');
    assert.equal(money.allocated_pesewas, 8307);
    assert.equal(money.balances, true);

    // 25–26. Vendor daily, Partner weekly.
    //
    // One delivery earns GH₵5 and the weekly Partner floor is GH₵20, so the
    // floor is lifted here: this walk-through is about the whole order reaching
    // settlement, not about how many weeks a Partner waits. The floor and its
    // rollover have their own suite.
    await setPartnerPayoutThreshold(1);
    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
    const vendorRun = await asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            'VENDOR',
            ...period,
          ])
        ).rows[0]
    );
    const partnerRun = await asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            'PARTNER',
            ...period,
          ])
        ).rows[0]
    );
    assert.equal(vendorRun.total_pesewas, 7300);
    assert.equal(partnerRun.total_pesewas, 500);

    const partnerPayout = await asService(
      async (c) =>
        (
          await c.query('select * from public.payouts where settlement_run_id = $1', [
            partnerRun.id,
          ])
        ).rows[0]
    );
    assert.equal(partnerPayout.payee_id, winnerId, 'the Partner who actually did it');

    // 27. And the admin can reconcile the whole thing.
    const issues = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_reconciliation()')).rows
    );
    assert.deepEqual(issues, [], 'nothing to investigate');

    // The loser never gained anything.
    const loserEarnings = await asUser(
      loserId,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(loserEarnings.earned_pesewas, 0);
  });

  // =========================================================================
  // FAILURE VARIANTS
  // =========================================================================
  async function readyForDispatch() {
    const { order } = await customerOrders();
    await customerPays(order.order_id);
    await act(vendorStaff, 'select public.vendor_mark_ready($1)', [order.order_id]);
    return order;
  }

  test('variant: the customer never pays, and nothing is charged', async () => {
    const { order } = await customerOrders();
    await asService((c) =>
      c.query("update public.orders set accept_deadline_at = now() - interval '1s' where id = $1", [
        order.order_id,
      ])
    );
    await asService((c) => c.query('select public.expire_stale_orders()'));

    const stored = await orderRow(order.order_id);
    assert.equal(stored.order_status, 'CANCELLED');
    assert.equal(stored.payment_status, 'UNPAID');

    const payments = await asService(
      async (c) =>
        (await c.query('select * from public.payments where order_id = $1', [order.order_id])).rows
    );
    assert.equal(payments.length, 0, 'no charge was ever created');
  });

  test('variant: an administrator cancels, and the customer is told why', async () => {
    const { order } = await customerOrders();
    await act(ACTORS.admin, 'select public.admin_cancel_order($1, $2)', [
      order.order_id,
      'store ran out of jollof',
    ]);

    const view = await asUser(
      customer,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [order.order_id])).rows[0]
    );
    assert.equal(view.stage, 'CANCELLED');
    assert.equal(view.cancellation_reason, 'store ran out of jollof');
    assert.equal(view.payment_status, 'UNPAID');
  });

  test('variant: Partner A cancels, Partner B takes it, and the vendor does nothing', async () => {
    const order = await readyForDispatch();
    const first = await asUser(
      partnerA,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );

    const codeBefore = (await secrets(order.order_id)).pickup_code;

    await act(partnerA, 'select public.partner_cancel_delivery($1, $2)', [
      order.order_id,
      'bike broke',
    ]);

    const second = await asUser(
      partnerB,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );
    assert.equal(second.success, true);
    // The code lives on the order for the VENDOR to read out, and a fresh
    // assignment mints a fresh one.
    const codeAfter = (await secrets(order.order_id)).pickup_code;
    assert.notEqual(codeAfter, codeBefore, 'a fresh code');

    // The order never changed identity, and the vendor was never asked to act.
    const stored = await orderRow(order.order_id);
    assert.equal(stored.order_number, order.order_number, 'the SAME order throughout');
    assert.equal(stored.order_status, 'READY');
    assert.equal(stored.payment_status, 'PAID');

    // Partner A's code is worthless — checked from Partner B's hand, because
    // Partner A is no longer authorised to try at all. That refusal is an
    // AUTHORISATION failure and raises; "the number is wrong" is a different
    // fact and returns.
    assert.equal(
      envelope(
        await act(partnerB, 'select public.partner_confirm_pickup($1, $2)', [
          order.order_id,
          codeBefore,
        ])
      ).success,
      false
    );
    // Partner B's works — and it is Partner B who types it, because Partner A
    // is no longer carrying anything.
    assert.equal(
      envelope(
        await act(partnerB, 'select public.partner_confirm_pickup($1, $2)', [
          order.order_id,
          codeAfter,
        ])
      ).success,
      true
    );
  });

  test('variant: nobody accepts — the food order survives and the customer chooses', async () => {
    const order = await readyForDispatch();
    await asService((c) =>
      c.query("update public.orders set search_deadline_at = now() - interval '1s' where id = $1", [
        order.order_id,
      ])
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    let stored = await orderRow(order.order_id);
    assert.equal(stored.delivery_status, 'FAILED_NO_PARTNER');
    assert.equal(stored.order_status, 'READY', 'the food is untouched');
    assert.equal(stored.payment_status, 'PAID');

    const view = await asUser(
      customer,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [order.order_id])).rows[0]
    );
    assert.equal(view.stage, 'NO_PARTNER');

    // Option one: keep waiting.
    assert.equal(
      envelope(await act(customer, 'select public.customer_keep_waiting($1)', [order.order_id]))
        .success,
      true
    );
    assert.equal((await orderRow(order.order_id)).delivery_status, 'SEARCHING');

    // Option two: collect it themselves.
    assert.equal(
      envelope(await act(customer, 'select public.customer_collect_instead($1)', [order.order_id]))
        .success,
      true
    );
    stored = await orderRow(order.order_id);
    assert.equal(stored.delivery_status, 'NONE');
    assert.equal(stored.order_status, 'READY', 'still theirs to collect');
  });

  test('variant: the customer is absent', async () => {
    const order = await readyForDispatch();
    const claim = await asUser(
      partnerA,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );
    await act(partnerA, 'select public.partner_confirm_pickup($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).pickup_code,
    ]);

    await act(partnerA, 'select public.partner_report_customer_absent($1)', [order.order_id]);
    await asService((c) =>
      c.query(
        "update public.orders set customer_absent_reported_at = now() - interval '1 hour' where id = $1",
        [order.order_id]
      )
    );
    assert.equal(
      envelope(
        await act(partnerA, 'select public.partner_confirm_customer_absent($1)', [order.order_id])
      ).success,
      true
    );

    const stored = await orderRow(order.order_id);
    assert.equal(stored.delivery_status, 'FAILED_CUSTOMER_ABSENT');
    assert.equal(stored.order_status, 'READY', 'the delivery failed, not the order');
    assert.equal(stored.partner_id, partnerA, 'the Partner stays attached so they can be paid');

    const earnings = await asUser(
      partnerA,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(earnings.earned_pesewas, 500, 'they collected and travelled');

    // The admin sees it at the top of the board.
    const board = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_order_board()')).rows
    );
    assert.equal(board[0].order_id, order.order_id);
    assert.equal(board[0].attention, 'CUSTOMER_ABSENT');
  });

  test('variant: wrong and stale codes are refused at both gates', async () => {
    const order = await readyForDispatch();
    const claim = await asUser(
      partnerA,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );

    // Wrong pickup code.
    assert.equal(
      envelope(
        await act(partnerA, 'select public.partner_confirm_pickup($1, $2)', [
          order.order_id,
          '0000',
        ])
      ).success,
      false
    );

    await act(partnerA, 'select public.partner_confirm_pickup($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).pickup_code,
    ]);

    // Wrong delivery code.
    assert.equal(
      envelope(
        await act(partnerA, 'select public.partner_complete_delivery($1, $2)', [
          order.order_id,
          '0000',
        ])
      ).success,
      false
    );
    assert.equal((await orderRow(order.order_id)).delivery_status, 'PICKED_UP');

    // The real one works.
    const real = (await secrets(order.order_id)).delivery_code;
    assert.equal(
      envelope(
        await act(partnerA, 'select public.partner_complete_delivery($1, $2)', [
          order.order_id,
          real,
        ])
      ).success,
      true
    );
  });

  test('variant: a duplicate webhook moves money once', async () => {
    const { order } = await customerOrders();

    const payment = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            `order:${order.order_id}:attempt:1`,
          ])
        ).rows[0]
    );

    const deliveries = await Promise.all(
      [1, 2, 3].map(() =>
        asService(
          async (c) =>
            (
              await c.query('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
                'fake',
                'evt_e2e_dup',
                JSON.stringify({ eventId: 'evt_e2e_dup' }),
                true,
              ])
            ).rows[0]
        )
      )
    );
    assert.equal(deliveries.filter((d) => d.is_new).length, 1, 'one delivery is new');

    // Confirming twice is a no-op, not a second PAID.
    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn',
        payment.amount_pesewas,
      ])
    );
    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        'txn',
        payment.amount_pesewas,
      ])
    );

    const allocations = await asService(
      async (c) =>
        (await c.query('select * from public.allocations where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(allocations.length, 2, 'the ledger is written once');
    assert.equal(
      allocations.reduce((sum, a) => sum + a.amount_pesewas, 0),
      8307
    );
  });

  test('variant: a duplicate payout is impossible', async () => {
    const order = await readyForDispatch();
    const claim = await asUser(
      partnerA,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );
    await act(partnerA, 'select public.partner_confirm_pickup($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).pickup_code,
    ]);
    await act(partnerA, 'select public.partner_complete_delivery($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).delivery_code,
    ]);

    // Idempotency of the RUN, not the weekly threshold: one delivery is GH₵5
    // and the floor is GH₵20, so it is lifted here on purpose.
    await setPartnerPayoutThreshold(1);

    const period = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
    const first = await asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            'PARTNER',
            ...period,
          ])
        ).rows[0]
    );
    const again = await asService(
      async (c) =>
        (
          await c.query('select * from public.create_settlement_run($1, $2, $3)', [
            'PARTNER',
            ...period,
          ])
        ).rows[0]
    );
    assert.equal(again.id, first.id);

    const payouts = await asService(
      async (c) => (await c.query('select * from public.payouts')).rows
    );
    assert.equal(payouts.length, 1, 'one payout, however many times it is run');

    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
           values ($1, 'PARTNER', $2, 500, 'forged')`,
          [first.id, partnerA]
        )
      )
    );
    assert.match(error.message, /payouts_run_payee_unique/);
  });

  test('variant: a customer disputes, and nothing moves until an admin looks', async () => {
    const order = await readyForDispatch();
    const claim = await asUser(
      partnerA,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [order.order_id]))
          .rows[0],
      { commit: true }
    );
    await act(partnerA, 'select public.partner_confirm_pickup($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).pickup_code,
    ]);
    await act(partnerA, 'select public.partner_complete_delivery($1, $2)', [
      order.order_id,
      (await secrets(order.order_id)).delivery_code,
    ]);

    const beforeDispute = await orderRow(order.order_id);

    assert.equal(
      envelope(
        await act(customer, 'select public.customer_dispute_delivery($1, $2)', [
          order.order_id,
          'the drink was missing',
        ])
      ).success,
      true
    );

    const disputed = await orderRow(order.order_id);
    assert.ok(disputed.disputed_at);
    assert.equal(disputed.payment_status, beforeDispute.payment_status, 'no money moved');
    assert.equal(disputed.delivery_status, beforeDispute.delivery_status, 'no state changed');

    // It surfaces at the top of the admin board.
    const board = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_order_board()')).rows
    );
    assert.equal(board[0].attention, 'DISPUTED');

    // And an admin closes it, with a reason, on the record.
    await act(ACTORS.admin, 'select public.admin_resolve_dispute($1, $2, $3)', [
      order.order_id,
      'spoke to both; refunded the drink separately',
      'resolved by phone',
    ]);
    assert.ok((await orderRow(order.order_id)).dispute_resolved_at);

    const audit = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.admin_actions where action = 'DISPUTE_RESOLVE' and target_id = $1",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(audit.length, 1);
    assert.match(audit[0].reason, /spoke to both/);
  });
});
