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
import {
  submitOrder,
  payOrder,
  vendorReady,
  partnerAccept,
  partnerConfirmPickup,
  customerCollect,
  completeDelivery,
  getOrder,
  getSecrets,
  getAllocations,
  tryTransition,
  submitScanOrder,
  expectRejection,
} from './helpers/flow.js';

/**
 * PAID-FIRST ORDERING, as one story.
 *
 * The other suites test each piece where it lives. This one exists because the
 * change is a change of SHAPE, and the shape is only visible end to end: a
 * store never sees an order it has not been paid for, a Partner is found while
 * the food cooks, and the person who takes the food is the one who types in a
 * code somebody else read out.
 */
describe('paid-first ordering', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const offers = (partner) =>
    asUser(
      partner,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );

  const activeFor = (partner) =>
    asUser(
      partner,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0] ?? null
    );

  const handoffCode = (orderId) =>
    asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as code', [orderId])).rows[0].code
    );

  // =========================================================================
  // THE DELIVERY STORY
  // =========================================================================
  test('a delivery: pay, then a Partner while it cooks, then two codes', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });

    // 1. PRICED IN FULL AT THE CHECKOUT. GH₵35 + 5% + GH₵5.
    assert.equal(order.total_pesewas, 4243);
    assert.equal((await getOrder(order.order_id)).order_status, 'ACCEPTED');

    // 2. Nobody has been offered anything: it has not been paid for.
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0);

    // 3. PAYING IS THE EVENT. It reaches the kitchen and opens the pool at once.
    await payOrder(order.order_id);
    const paid = await getOrder(order.order_id);
    assert.equal(paid.order_status, 'PREPARING');
    assert.equal(paid.delivery_status, 'SEARCHING');

    // 4. The offer is live, and honest about the kitchen.
    const offer = (await offers(ACTORS.partnerYaw)).find((o) => o.order_id === order.order_id);
    assert.ok(offer);
    assert.equal(offer.food_is_ready, false);
    assert.equal(Number(offer.earnings_pesewas), 500);

    // 5. A Partner takes it while it is still cooking, and immediately gets the
    //    exact destination and a number to ring — not at pickup, now.
    assert.equal((await partnerAccept(order.order_id, ACTORS.partnerYaw)).success, true);
    const job = await activeFor(ACTORS.partnerYaw);
    assert.match(job.destination, /Room 204/);
    assert.equal(job.customer_phone, '+233200000021');
    assert.equal(job.food_is_ready, false, 'and is told to wait');

    // 6. COLLECTING EARLY IS REFUSED, and costs no attempt: there is nothing at
    //    the counter to collect.
    const early = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, '0000');
    assert.equal(early.success, false);
    assert.match(early.reason, /not ready yet/);
    assert.equal((await getSecrets(order.order_id)).pickup_attempts, 0);

    // 7. The store presses Ready. Its only button.
    await vendorReady(order.order_id);
    assert.equal((await activeFor(ACTORS.partnerYaw)).food_is_ready, true);

    // 8. The store reads the code out; the Partner types it in.
    const code = await handoffCode(order.order_id);
    assert.equal(
      (await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, code)).success,
      true
    );

    // 9. The customer reads their code out; the Partner types that in too.
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const done = await getOrder(order.order_id);
    assert.equal(done.order_status, 'COMPLETED');
    assert.equal(done.delivery_status, 'DELIVERED');

    // 10. GH₵5 in the LEDGER. Not sent anywhere — the weekly run does that.
    const partner = (await getAllocations(order.order_id)).find((a) => a.payee_type === 'PARTNER');
    assert.equal(partner.amount_pesewas, 500);
    assert.equal(partner.status, 'ELIGIBLE', 'owed, not yet paid');
  });

  test('a collection: pay, make it, and the customer types in the code', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    assert.equal(order.total_pesewas, 3743, 'no delivery fee');

    await payOrder(order.order_id);
    const paid = await getOrder(order.order_id);
    assert.equal(paid.order_status, 'PREPARING');
    assert.equal(paid.delivery_status, 'NONE', 'no Partner is ever involved');

    // No code exists for food nobody has made.
    assert.equal((await getSecrets(order.order_id)).pickup_code, null);
    const tooEarly = await customerCollect(order.order_id, ACTORS.customerAma, '0000');
    assert.equal(tooEarly.success, false);
    assert.match(tooEarly.reason, /not ready for collection/);

    await vendorReady(order.order_id);
    const code = await handoffCode(order.order_id);
    assert.match(code, /^\d{4}$/);

    assert.equal((await customerCollect(order.order_id, ACTORS.customerAma, code)).success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'COMPLETED');
  });

  test('only the customer who placed it can collect it', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);
    const code = await handoffCode(order.order_id);

    // AUTHORISATION FAILS LOUDLY, and it is checked before the code, so a
    // stranger with the right four digits cannot even spend an attempt against
    // somebody else's order.
    const stranger = await expectRejection(
      asUser(ACTORS.customerKwesi, (c) =>
        c.query('select public.customer_complete_pickup($1, $2)', [order.order_id, code])
      )
    );
    assert.match(stranger.message, /not your order/);
    assert.equal((await getSecrets(order.order_id)).pickup_attempts, 0);
    assert.equal((await getOrder(order.order_id)).order_status, 'READY');
  });

  /**
   * NOBODY TOOK IT, SO THE CUSTOMER FETCHES IT.
   *
   * `customer_collect_instead()` returns delivery_status to NONE on an order
   * whose fulfilment_type is still DELIVERY. The handoff therefore keys on
   * "nobody is bringing it" rather than on what was chosen at the checkout —
   * keying on fulfilment_type would leave the code unreadable by the store and
   * the order impossible to finish.
   */
  test('a delivery nobody took can still be collected, with the same handoff', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    await tryTransition(ACTORS.customerAma, 'select public.customer_collect_instead($1)', [
      order.order_id,
    ]);

    const taken = await getOrder(order.order_id);
    assert.equal(taken.delivery_status, 'NONE');
    assert.equal(taken.fulfilment_type, 'DELIVERY', 'the order never changed what it was');

    // The store can read a code for it, and the customer types it in.
    const code = await handoffCode(order.order_id);
    assert.match(code, /^\d{4}$/);

    const wrong = await customerCollect(order.order_id, ACTORS.customerAma, '0000');
    assert.equal(wrong.success, false);

    assert.equal((await customerCollect(order.order_id, ACTORS.customerAma, code)).success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'COMPLETED');
  });

  // =========================================================================
  // WHAT A STORE CAN AND CANNOT DO
  // =========================================================================
  test('there is no accept, no reject and no start-preparing left in the product', async () => {
    const order = await submitOrder();

    for (const sql of [
      'select public.vendor_accept_order($1)',
      'select public.vendor_mark_preparing($1)',
    ]) {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) => c.query(sql, [order.order_id]))
      );
      assert.match(error.message, /permission denied/i, sql);
    }

    // The order is untouched by any of that, and still payable.
    assert.equal((await getOrder(order.order_id)).order_status, 'ACCEPTED');
    await payOrder(order.order_id);
    assert.equal((await getOrder(order.order_id)).order_status, 'PREPARING');
  });

  // =========================================================================
  // A PARTNER WHO WALKS AWAY
  // =========================================================================
  test('a cancellation puts the order straight back in the pool, mid-cook', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const firstCode = (await getSecrets(order.order_id)).pickup_code;

    await tryTransition(ACTORS.partnerYaw, 'select public.partner_cancel_delivery($1, $2)', [
      order.order_id,
      'something came up',
    ]);

    // Back in the pool, still cooking, still paid for, same order.
    const released = await getOrder(order.order_id);
    assert.equal(released.delivery_status, 'SEARCHING');
    assert.equal(released.partner_id, null);
    assert.equal(released.order_status, 'PREPARING');
    assert.equal(released.payment_status, 'PAID');

    // The first Partner has nothing: no job, no destination, no phone number.
    assert.equal(await activeFor(ACTORS.partnerYaw), null);

    // Somebody else can take it, and gets a fresh code.
    assert.equal((await partnerAccept(order.order_id, ACTORS.partnerAdjoa)).success, true);
    assert.notEqual((await getSecrets(order.order_id)).pickup_code, firstCode);

    const second = await activeFor(ACTORS.partnerAdjoa);
    assert.match(second.destination, /Room 204/);
    assert.ok(second.customer_phone);
  });

  test('a second Partner cannot take a delivery that is already claimed', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const late = await partnerAccept(order.order_id, ACTORS.partnerAdjoa);
    assert.equal(late.success, false);
    assert.match(late.reason, /already been taken/);
    assert.equal((await getOrder(order.order_id)).partner_id, ACTORS.partnerYaw);
    assert.equal(await activeFor(ACTORS.partnerAdjoa), null);
  });

  test('two Partners racing on the same order produce exactly one winner', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    const clients = await Promise.all(
      [ACTORS.partnerYaw, ACTORS.partnerAdjoa].map((id) => dedicatedClient(id))
    );
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query('select * from public.partner_accept_delivery($1)', [order.order_id])
        )
      );
      const envelopes = results.map((r) => r.rows[0]);
      assert.equal(envelopes.filter((e) => e.success).length, 1);
      assert.match(envelopes.find((e) => !e.success).reason, /already been taken/);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  // =========================================================================
  // THE CUSTOMER'S OWN VIEW
  // =========================================================================
  test('the order list carries what a receipt needs, and names the Partner while they carry it', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const list = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.customer_order_list()')).rows
    );
    const row = list.find((r) => r.order_id === order.order_id);

    assert.equal(row.vendor_order_no, 1, 'the number the store called out');
    assert.equal(row.vendor_name, 'Test Kitchen One');
    assert.equal(row.fulfilment_type, 'DELIVERY');
    assert.equal(row.item_count, 1);
    assert.equal(Number(row.total_pesewas), 4243);
    assert.ok(row.submitted_at);
    assert.equal(row.stage, 'PREPARING_PARTNER_ASSIGNED');

    // FIRST NAME ONLY, ever. Never a surname, in either direction.
    assert.equal(row.partner_first_name, 'Yaw');
    assert.ok(!JSON.stringify(row).includes('Boateng'), 'never a surname');

    await vendorReady(order.order_id);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const after = (
      await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.customer_order_list()')).rows
      )
    ).find((r) => r.order_id === order.order_id);
    assert.equal(after.stage, 'COMPLETED');
    // AND IT STAYS. "Kwame brought this" is what somebody remembers about an
    // order; a history row that names nobody is a record of a transaction
    // rather than of something that happened. The PHONE NUMBER is the thing
    // that ends with the delivery, and the list never carried one.
    assert.equal(after.partner_first_name, 'Yaw');
    assert.ok(!JSON.stringify(after).includes('+233'), 'and never a number');
    assert.ok(after.completed_at);
  });

  test('the account summary counts what the list shows', async () => {
    const summary = () =>
      asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.my_order_summary()')).rows[0]
      );

    assert.deepEqual(await summary(), {
      total_orders: 0,
      completed_orders: 0,
      active_orders: 0,
    });

    const first = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    assert.equal(Number((await summary()).active_orders), 1, 'unpaid but real');

    await payOrder(first.order_id);
    await vendorReady(first.order_id);
    await customerCollect(first.order_id, ACTORS.customerAma);

    const second = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(second.order_id);

    const now = await summary();
    assert.equal(Number(now.total_orders), 2);
    assert.equal(Number(now.completed_orders), 1);
    assert.equal(Number(now.active_orders), 1);

    // Another customer's orders are not in anybody else's count.
    const theirs = await asUser(
      ACTORS.customerKwesi,
      async (c) => (await c.query('select * from public.my_order_summary()')).rows[0]
    );
    assert.equal(Number(theirs.total_orders), 0);
  });

  // =========================================================================
  // THE QUEUE NUMBER
  // =========================================================================
  test('a meal scan order takes a queue number, like everything else on the board', async () => {
    const errand = await submitScanOrder({ vendorId: VENDORS.wafflemania });

    const stored = await getOrder(errand.order_id);
    // THE CORRECTION. A scan order used to take no queue number, because no
    // store ever saw one. The store IS the redemption point now: it has the
    // order on its board and calls the number out like any other.
    assert.equal(stored.vendor_order_no, 1, 'the first scan order of the day at this store');
    assert.match(stored.order_number, /^CD-\d{5}$/, 'the internal reference survives underneath');

    // And it is per store per day, so an order at a different store is its own
    // 001 rather than continuing somebody else's count.
    const food = await submitOrder({ vendorId: VENDORS.one });
    assert.equal(food.vendor_order_no, 1);

    // A second scan order at the same store continues that store's count.
    const second = await submitScanOrder({
      vendorId: VENDORS.wafflemania,
      customer: ACTORS.customerKwesi,
    });
    assert.equal((await getOrder(second.order_id)).vendor_order_no, 2);
  });
});
