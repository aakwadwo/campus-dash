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
  LOCATIONS,
} from './helpers/db.js';
import {
  submitOrder,
  vendorAccept,
  payOrder,
  vendorPrepare,
  vendorReady,
  orderReadyForDispatch,
  partnerAccept,
  getOrder,
  getSecrets,
  expectRejection,
  tryTransition,
  completeDelivery,
} from './helpers/flow.js';

describe('state transitions', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  // --- 13 ------------------------------------------------------------------
  test('an invalid transition is refused and the order is untouched', async () => {
    const order = await submitOrder();

    // READY without ever being accepted, paid or prepared.
    const result = await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_mark_ready($1)', [
      order.order_id,
    ]);
    assert.equal(result.success, false);
    assert.match(result.reason, /cannot be marked ready from state SUBMITTED/);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'SUBMITTED');
    assert.equal(stored.ready_at, null);
  });

  test('a rejected transition is written to the append-only log', async () => {
    const order = await submitOrder();
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_mark_ready($1)', [
      order.order_id,
    ]);

    const events = await asService(
      async (c) =>
        (
          await c.query('select * from public.order_events where order_id = $1 and not accepted', [
            order.order_id,
          ])
        ).rows
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'VENDOR_READY');
    assert.equal(events[0].from_state, 'SUBMITTED');
    assert.equal(events[0].to_state, 'READY');
    assert.match(events[0].reason, /not PREPARING/);
  });

  test('the vendor cannot start preparing before the money is in', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const result = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_mark_preparing($1)',
      [order.order_id]
    );
    assert.equal(result.success, false);
    assert.match(result.reason, /payment must be PAID/);
  });

  test('the happy path walks all the way to COMPLETED', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'COMPLETED');
    assert.equal(stored.payment_status, 'PAID');
    assert.equal(stored.delivery_status, 'DELIVERED');
  });

  // --- 14 ------------------------------------------------------------------
  test('vendor timeout expires the order and takes no payment', async () => {
    const order = await submitOrder();

    // Wind the deadline into the past rather than waiting 60 real seconds.
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );

    const expired = await asService(
      async (c) => (await c.query('select public.expire_stale_orders() as n')).rows[0].n
    );
    assert.equal(expired, 1);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'EXPIRED');
    assert.equal(stored.payment_status, 'UNPAID', 'NO payment is taken for an auto-rejected order');

    const payments = await asService(
      async (c) =>
        (await c.query('select * from public.payments where order_id = $1', [order.order_id])).rows
    );
    assert.equal(payments.length, 0);
  });

  test('a vendor cannot accept after the window has elapsed', async () => {
    const order = await submitOrder();
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );

    const result = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_accept_order($1)',
      [order.order_id]
    );
    assert.equal(result.success, false);
  });

  test('an expired order cannot then be paid', async () => {
    const order = await submitOrder();
    await asService((c) =>
      c.query("update public.orders set order_status = 'EXPIRED' where id = $1", [order.order_id])
    );
    const error = await expectRejection(payOrder(order.order_id));
    assert.match(error.message, /must be ACCEPTED before payment/);
  });

  // --- 15 ------------------------------------------------------------------
  test('a failed delivery does NOT destroy the food order', async () => {
    const order = await orderReadyForDispatch();

    await asService((c) =>
      c.query(
        "update public.orders set search_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );
    const failed = await asService(
      async (c) => (await c.query('select public.expire_partner_search() as n')).rows[0].n
    );
    assert.equal(failed, 1);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'FAILED_NO_PARTNER');
    // The food still exists and is still paid for.
    assert.equal(stored.order_status, 'READY', 'the food order survives the delivery failure');
    assert.equal(stored.payment_status, 'PAID', 'the payment survives too');
  });

  test('dispatch can be reopened after a failure without recreating the order', async () => {
    const order = await orderReadyForDispatch();
    await asService((c) =>
      c.query(
        "update public.orders set search_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    // The admin puts it back in the pool. Same order, same payment, same food.
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_reassign_delivery($1, $2)', [
          order.order_id,
          'customer chose to keep waiting',
        ]),
      { commit: true }
    );

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'SEARCHING');
    assert.equal(stored.order_status, 'READY');
    assert.equal(stored.payment_status, 'PAID');

    // And a Partner can now take it.
    const accepted = await partnerAccept(order.order_id, ACTORS.partnerYaw);
    assert.equal(accepted.success, true);
  });

  // NOTE: the customer-facing fallback for FAILED_NO_PARTNER — "collect it
  // yourself and get the delivery fee back" versus "keep waiting" versus
  // "cancel" — is deliberately NOT implemented. Converting a paid delivery
  // order to pickup means refunding part of a captured payment, and the refund
  // mechanics depend on the unresolved Hubtel/Paystack question. See
  // docs/OPEN-QUESTIONS.md. The schema supports every option; the business rule
  // is not ours to invent.

  // --- 9 -------------------------------------------------------------------
  test('a pickup code is dead the moment the Partner cancels', async () => {
    const order = await orderReadyForDispatch();
    const accepted = await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const oldCode = accepted.pickup_code;
    assert.match(oldCode, /^\d{4}$/);

    const cancel = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_cancel_delivery($1, $2)',
      [order.order_id, 'changed my mind']
    );
    assert.equal(cancel.success, true);

    // THE SAME ORDER survives, back in the pool.
    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'SEARCHING');
    assert.equal(stored.partner_id, null);
    assert.equal(stored.order_status, 'READY', 'vendor preparation is untouched');
    assert.equal(stored.payment_status, 'PAID', 'payment is untouched');

    // The old code no longer opens the handoff.
    const confirm = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, oldCode]
    );
    assert.equal(confirm.success, false);
    assert.match(confirm.reason, /pickup code does not match/);
  });

  // --- 10 ------------------------------------------------------------------
  test('reassignment rotates the pickup code and the old one stops working', async () => {
    const order = await orderReadyForDispatch();
    const first = await partnerAccept(order.order_id, ACTORS.partnerYaw);

    await tryTransition(ACTORS.partnerYaw, 'select public.partner_cancel_delivery($1, $2)', [
      order.order_id,
      'cancelled',
    ]);
    const second = await partnerAccept(order.order_id, ACTORS.partnerAdjoa);
    assert.equal(second.success, true);

    const secrets = await getSecrets(order.order_id);
    assert.equal(secrets.pickup_code, second.pickup_code);
    assert.equal(secrets.pickup_code_version, 3, 'version bumped on issue, cancel and re-issue');

    // Old Partner's code is worthless.
    const stale = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, first.pickup_code]
    );
    assert.equal(stale.success, false);

    // The new Partner's code works.
    const fresh = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, second.pickup_code]
    );
    assert.equal(fresh.success, true);
  });

  test('admin reassignment also rotates the code', async () => {
    const order = await orderReadyForDispatch();
    const accepted = await partnerAccept(order.order_id, ACTORS.partnerYaw);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_reassign_delivery($1, $2)', [
          order.order_id,
          'partner unreachable',
        ]),
      { commit: true }
    );

    const stale = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, accepted.pickup_code]
    );
    assert.equal(stale.success, false, "the removed Partner's code is dead");

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'SEARCHING');
    assert.equal(stored.partner_id, null);
  });

  test("a Partner cannot declare delivery without the customer's code", async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const wrong = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_complete_delivery($1, $2)',
      [order.order_id, '0000']
    );
    assert.equal(wrong.success, false);
    assert.match(wrong.reason, /delivery code does not match/);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'PICKED_UP', 'still undelivered');
  });

  // --- 11 ------------------------------------------------------------------
  test('a price change after submission does not alter the existing order', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    // 2 x GH₵35 + GH₵2 + GH₵5 = GH₵77
    assert.equal(order.total_pesewas, 7700);

    // The vendor raises the price from GH₵35.00 to GH₵50.00.
    await asService((c) =>
      c.query('update public.menu_items set price_pesewas = 5000 where id = $1', [MENU.jollof])
    );

    const stored = await getOrder(order.order_id);
    assert.equal(stored.subtotal_pesewas, 7000, 'the snapshot holds');
    assert.equal(stored.total_pesewas, 7700);

    const items = await asService(
      async (c) =>
        (await c.query('select * from public.order_items where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(items[0].unit_price_pesewas, 3500, 'the ORIGINAL price is preserved');
    assert.equal(items[0].name_snapshot, 'Jollof Rice with Chicken');

    // A NEW order picks up the new price.
    const later = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    assert.equal(later.total_pesewas, 10700, 'the new order uses the new price');
  });

  test('an unavailable menu item cannot be ordered', async () => {
    const error = await expectRejection(
      submitOrder({ items: [{ menu_item_id: MENU.kelewele, quantity: 1 }] })
    );
    assert.match(error.message, /unavailable/);
  });

  test('items from another vendor cannot be smuggled into an order', async () => {
    const error = await expectRejection(
      submitOrder({ vendorId: VENDORS.one, items: [{ menu_item_id: MENU.shawarma, quantity: 1 }] })
    );
    assert.match(error.message, /unavailable/);
  });

  test('a closed vendor cannot receive new orders', async () => {
    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = false where id = $1', [VENDORS.one])
    );
    const error = await expectRejection(submitOrder({ vendorId: VENDORS.one }));
    assert.match(error.message, /not accepting orders/);
  });

  test('a non-deliverable location cannot be a destination', async () => {
    const error = await expectRejection(submitOrder({ destination: LOCATIONS.floor2 }));
    assert.match(error.message, /not a valid delivery location/);
  });

  // --- pickup is first-class ----------------------------------------------
  test('a pickup order needs no Partner and keeps delivery_status NONE throughout', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    assert.equal(order.total_pesewas, 3700, 'no delivery fee on a pickup order');

    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);

    let stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'NONE', 'dispatch never opens for pickup');

    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_complete_pickup_order($1)', [
      order.order_id,
    ]);
    stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'COMPLETED');
    assert.equal(stored.delivery_status, 'NONE');
    assert.equal(stored.partner_id, null);
  });

  test('a pickup order never appears in the Partner offer list', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(!offers.some((o) => o.order_id === order.order_id));
  });

  test('an unapproved applicant sees no offers and cannot accept', async () => {
    const order = await orderReadyForDispatch();

    const offers = await asUser(
      ACTORS.applicantKofi,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.equal(offers.length, 0);

    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.applicantKofi));
    assert.match(error.message, /not approved/);
  });

  test('an unavailable Partner sees no offers', async () => {
    await orderReadyForDispatch();
    await asService((c) =>
      c.query('update public.partner_profiles set is_available = false where user_id = $1', [
        ACTORS.partnerYaw,
      ])
    );
    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.equal(offers.length, 0);
  });

  test('the offer shows earnings, vendor and walking estimate before acceptance', async () => {
    const order = await orderReadyForDispatch();
    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    const offer = offers.find((o) => o.order_id === order.order_id);

    assert.equal(offer.earnings_pesewas, 500, 'GH₵5.00 to the Partner');
    assert.equal(offer.vendor_name, 'Test Kitchen One');
    assert.equal(offer.destination_zone, 'Hostel Block A');
    assert.equal(offer.walk_minutes, 9, 'vendor 4 min + block 5 min');
    assert.equal(offer.food_is_ready, true);
  });
});
