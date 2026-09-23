import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
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
  orderReadyForDispatch,
  submitScanOrder,
  vendorRedeemScan,
} from './helpers/flow.js';

/**
 * The store's part of an order, and when it ends.
 *
 * THE BUG THIS EXISTS FOR. A store handed a bag to a Partner and the order
 * stayed on their board — in "Ready for collection", with a code on it —
 * until somebody across campus opened a door, because "the store is finished"
 * was being inferred from `order_status`, which does not reach COMPLETED until
 * the CUSTOMER has the food. On a collection the two coincide and nobody
 * noticed; on a Partner order they are minutes and a walk apart.
 *
 * `orders.vendor_completed_at` records the store's own completion instead. It
 * is NOT a fourth order state — order_status still means the whole order,
 * through to the customer, and the three dimensions of hard rule 2 are
 * untouched. It is one narrow fact with one reader: the board.
 */
describe('vendor fulfilment', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const board = (staff = ACTORS.vendor1Staff, vendorId = VENDORS.one) =>
    asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_order_board($1, 20)', [vendorId])).rows
    );

  const detail = (orderId, staff = ACTORS.vendor1Staff) =>
    asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_order_detail($1)', [orderId])).rows[0]
    );

  const pendingCount = (staff = ACTORS.vendor1Staff, vendorId = VENDORS.one) =>
    asUser(staff, async (c) =>
      Number((await c.query('select public.vendor_pending_count($1) as n', [vendorId])).rows[0].n)
    );

  // =========================================================================

  test('handing food to a Partner clears the store’s board, mid-delivery', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    let card = (await board()).find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'READY', 'still theirs — nobody has taken it');
    assert.equal(card.vendor_completed_at, null);
    assert.equal(card.awaiting_handoff, true, 'somebody is due at the counter');

    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);

    card = (await board()).find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'CLOSED', 'the store is finished the moment they hand it over');
    assert.ok(card.vendor_completed_at, 'and the moment is recorded, not inferred');
    assert.equal(card.awaiting_handoff, false);

    // THE ORDER IS NOT OVER, and the customer's screen still says so. This is
    // the whole point of keeping the two facts apart.
    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'READY', 'order_status has not moved');
    assert.equal(stored.delivery_status, 'PICKED_UP');
    assert.equal(stored.completed_at, null, 'nobody has received anything yet');
  });

  test('the customer stays in tracking until the Partner finishes', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);

    const stage = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [order.order_id])).rows[0]
          .stage
    );
    assert.equal(stage, 'ON_THE_WAY', 'the store being done is not the customer being served');

    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const after = await getOrder(order.order_id);
    assert.equal(after.order_status, 'COMPLETED');
    assert.equal(after.delivery_status, 'DELIVERED');
  });

  test('a collection ends both at once, because it genuinely does', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    let card = (await board()).find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'READY');
    assert.equal(card.awaiting_handoff, true);

    await customerCollect(order.order_id);

    const stored = await getOrder(order.order_id);
    assert.ok(stored.vendor_completed_at);
    assert.equal(stored.order_status, 'COMPLETED');

    card = (await board()).find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'CLOSED');
  });

  test('the pending count is what the store still has to do', async () => {
    const before = await pendingCount();

    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    assert.equal(await pendingCount(), before + 1, 'a paid order is work');

    await vendorReady(order.order_id);
    assert.equal(await pendingCount(), before, 'made, so no longer waiting to be made');
  });

  /**
   * THE STORE IS NOT TOLD WHO IS COLLECTING.
   *
   * `awaiting_handoff` replaced a pair of flags that named the recipient —
   * partner_waiting and awaiting_collection. A counter does the same work
   * either way: check the scan if there is one, read out four digits to whoever
   * is standing there. Naming the recipient invited stores to treat the two
   * differently, and it is the customer's business, not theirs.
   */
  test('the board says somebody is at the counter, never who', async () => {
    const collection = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(collection.order_id);
    await vendorReady(collection.order_id);

    const delivery = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(delivery.order_id, ACTORS.partnerYaw);

    const cards = await board();
    const one = cards.find((r) => r.order_id === collection.order_id);
    const two = cards.find((r) => r.order_id === delivery.order_id);

    assert.equal(one.awaiting_handoff, true);
    assert.equal(two.awaiting_handoff, true);

    // The two cards are indistinguishable on the question of who is collecting.
    for (const card of [one, two]) {
      for (const named of [
        'partner_waiting',
        'awaiting_collection',
        'partner_assigned',
        'partner_name',
        'customer_first_name',
      ]) {
        assert.equal(named in card, false, `${named} must not be on a store's board`);
      }
    }
  });

  test('a meal scan order closes the board at handoff too', async () => {
    const order = await submitScanOrder({ vendorId: VENDORS.wafflemania });
    await asService(async (c) => {
      const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        order.order_id,
        `scan:${order.order_id}`,
      ]);
      await c.query('select public.confirm_payment($1, $2, $3)', [
        rows[0].id,
        `txn_${rows[0].id}`,
        rows[0].amount_pesewas,
      ]);
    });
    // THE STORE APPROVES THE MEAL SCAN FIRST — that is what opens the search.
    await vendorRedeemScan(order.order_id, ACTORS.wafflemaniaStaff);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await vendorReady(order.order_id, ACTORS.wafflemaniaStaff);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);

    const card = (await board(ACTORS.wafflemaniaStaff, VENDORS.wafflemania)).find(
      (r) => r.order_id === order.order_id
    );
    assert.equal(card.bucket, 'CLOSED');
    assert.ok(card.vendor_completed_at);
  });

  /**
   * An administrator taking an order off a Partner puts it BACK on the board:
   * whoever comes next has to be handed the food, and a store that thinks it is
   * finished will not hand anybody anything.
   */
  test('reassigning a collected order returns it to the store', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);
    assert.ok((await getOrder(order.order_id)).vendor_completed_at);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select * from public.admin_reassign_delivery($1, $2)', [
          order.order_id,
          'partner unreachable',
        ]),
      { commit: true }
    );

    const stored = await getOrder(order.order_id);
    assert.equal(stored.vendor_completed_at, null, 'the store is back in it');

    const card = (await board()).find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'READY');
  });

  test('the handoff code is gone once the store has handed it over', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    assert.equal((await detail(order.order_id)).handoff_code_available, true);

    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);

    assert.equal(
      (await detail(order.order_id)).handoff_code_available,
      false,
      'there is nobody left at this counter to read it to'
    );
  });
});
