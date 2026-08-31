import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
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
  vendorAccept,
  payOrder,
  vendorPrepare,
  vendorReady,
  getOrder,
  getSecrets,
  expectRejection,
  tryTransition,
  orderReadyForDispatch,
  partnerAccept,
} from './helpers/flow.js';

/**
 * The vendor module.
 *
 * The brief is narrow — a real vendor takes an order from arrival to READY — so
 * these check that path works, and that every way a vendor might reach past it
 * is refused by the database rather than by the screen.
 */
describe('vendor module', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const board = (userId, vendorId = VENDORS.one) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.vendor_order_board($1)', [vendorId])).rows
    );

  const detail = (userId, orderId) =>
    asUser(
      userId,
      async (c) =>
        (await c.query('select * from public.vendor_order_detail($1)', [orderId])).rows[0] ?? null
    );

  const pendingCount = (userId, vendorId = VENDORS.one) =>
    asUser(
      userId,
      async (c) =>
        (await c.query('select public.vendor_pending_count($1) as n', [vendorId])).rows[0].n
    );

  // =========================================================================
  // The whole point: SUBMITTED -> ACCEPTED -> PREPARING -> READY
  // =========================================================================
  test('a vendor takes an order from arrival to READY', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });

    let rows = await board(ACTORS.vendor1Staff);
    let card = rows.find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'NEW', 'it lands in the group that needs an answer');
    assert.equal(card.item_count, 1);
    assert.equal(card.total_pesewas, 7700);
    assert.ok(card.seconds_to_deadline > 0 && card.seconds_to_deadline <= 60);

    await vendorAccept(order.order_id);
    rows = await board(ACTORS.vendor1Staff);
    assert.equal(rows.find((r) => r.order_id === order.order_id).bucket, 'PREPARING');

    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);

    rows = await board(ACTORS.vendor1Staff);
    card = rows.find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'READY');

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'READY');
    assert.equal(stored.payment_status, 'PAID');
    assert.equal(stored.delivery_status, 'SEARCHING', 'dispatch opens only at READY');
  });

  test('a pickup order runs the same path and completes without any Partner', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);

    const beforeComplete = await getOrder(order.order_id);
    assert.equal(beforeComplete.delivery_status, 'NONE', 'dispatch never opens for pickup');

    const result = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_complete_pickup_order($1)',
      [order.order_id]
    );
    assert.equal(result.success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'COMPLETED');
  });

  test('the board groups every state into exactly one bucket', async () => {
    const submitted = await submitOrder();
    const accepted = await submitOrder({ customer: ACTORS.customerKwesi });
    await vendorAccept(accepted.order_id);
    const ready = await submitOrder({ customer: ACTORS.customerEfua });
    await vendorAccept(ready.order_id);
    await payOrder(ready.order_id);
    await vendorPrepare(ready.order_id);
    await vendorReady(ready.order_id);
    const rejected = await submitOrder();
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_reject_order($1, $2)', [
      rejected.order_id,
      'out of stock',
    ]);

    const rows = await board(ACTORS.vendor1Staff);
    const bucketOf = (id) => rows.find((r) => r.order_id === id)?.bucket;

    assert.equal(bucketOf(submitted.order_id), 'NEW');
    assert.equal(bucketOf(accepted.order_id), 'PREPARING');
    assert.equal(bucketOf(ready.order_id), 'READY');
    assert.equal(bucketOf(rejected.order_id), 'CLOSED');
  });

  test('live work is ordered oldest first, so the order nearest its deadline leads', async () => {
    const first = await submitOrder();
    const second = await submitOrder({ customer: ACTORS.customerKwesi });

    const rows = (await board(ACTORS.vendor1Staff)).filter((r) => r.bucket === 'NEW');
    assert.equal(rows[0].order_id, first.order_id);
    assert.equal(rows[1].order_id, second.order_id);
  });

  test('the pending count tracks orders still waiting for an answer', async () => {
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0);
    const order = await submitOrder();
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 1);
    await vendorAccept(order.order_id);
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0);
  });

  // =========================================================================
  // Isolation between vendors
  // =========================================================================
  test('a vendor sees only their own orders on the board', async () => {
    const mine = await submitOrder({ vendorId: VENDORS.one });
    const theirs = await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerKwesi,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });

    const rows = await board(ACTORS.vendor1Staff, VENDORS.one);
    assert.ok(rows.some((r) => r.order_id === mine.order_id));
    assert.ok(!rows.some((r) => r.order_id === theirs.order_id));
  });

  test("asking for another vendor's board returns nothing, not their orders", async () => {
    await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerKwesi,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });
    const rows = await board(ACTORS.vendor1Staff, VENDORS.two);
    assert.deepEqual(rows, [], 'the function checks staffing, it does not trust the id');
  });

  test("another vendor's order detail is invisible even with the exact order id", async () => {
    const theirs = await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerKwesi,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });
    assert.equal(await detail(ACTORS.vendor1Staff, theirs.order_id), null);
    assert.ok(await detail(ACTORS.vendor2Staff, theirs.order_id), 'their own vendor can see it');
  });

  test('another vendor cannot act on an order that is not theirs', async () => {
    const mine = await submitOrder({ vendorId: VENDORS.one });

    for (const sql of [
      'select public.vendor_accept_order($1)',
      'select public.vendor_reject_order($1, $2)',
      'select public.vendor_mark_preparing($1)',
      'select public.vendor_mark_ready($1)',
    ]) {
      const params = sql.includes('$2') ? [mine.order_id, 'not mine'] : [mine.order_id];
      const error = await expectRejection(asUser(ACTORS.vendor2Staff, (c) => c.query(sql, params)));
      assert.match(error.message, /not authorised for this order/);
    }

    assert.equal((await getOrder(mine.order_id)).order_status, 'SUBMITTED', 'untouched');
  });

  test('the pending count for a vendor you do not staff is zero', async () => {
    await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerKwesi,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });
    assert.equal(await pendingCount(ACTORS.vendor1Staff, VENDORS.two), 0);
  });

  test('a customer, a Partner and an anonymous visitor get nothing from the vendor board', async () => {
    await submitOrder();
    for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw]) {
      assert.deepEqual(await board(actor), [], 'not vendor staff');
    }
    const error = await expectRejection(
      asAnon((c) => c.query('select * from public.vendor_order_board($1)', [VENDORS.one]))
    );
    assert.match(error.message, /permission denied/i);
  });

  // =========================================================================
  // Multiple staff on one stall
  // =========================================================================
  test('two staff on the same stall both see and can act on its orders', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_add_vendor_user($1, $2, $3)', [
          VENDORS.one,
          '+233200000022',
          'second counter staff',
        ]),
      { commit: true }
    );

    const order = await submitOrder();
    const asFirst = await board(ACTORS.vendor1Staff);
    const asSecond = await board(ACTORS.customerKwesi);
    assert.ok(asFirst.some((r) => r.order_id === order.order_id));
    assert.ok(
      asSecond.some((r) => r.order_id === order.order_id),
      'the colleague sees it too'
    );

    // The second staff member accepts; the first sees the result.
    const accepted = await tryTransition(
      ACTORS.customerKwesi,
      'select public.vendor_accept_order($1)',
      [order.order_id]
    );
    assert.equal(accepted.success, true);
    const after = await board(ACTORS.vendor1Staff);
    assert.equal(after.find((r) => r.order_id === order.order_id).bucket, 'PREPARING');
  });

  test('removing a staff member cuts off the board immediately', async () => {
    const order = await submitOrder();
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_remove_vendor_user($1, $2, $3)', [
          VENDORS.one,
          ACTORS.vendor1Staff,
          'left the job',
        ]),
      { commit: true }
    );

    assert.deepEqual(await board(ACTORS.vendor1Staff), []);
    assert.equal(await detail(ACTORS.vendor1Staff, order.order_id), null);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_accept_order($1)', [order.order_id])
      )
    );
    assert.match(error.message, /not authorised/);
  });

  // =========================================================================
  // Concurrency between colleagues
  // =========================================================================
  test('two staff accepting the same order at once: one wins, the other is told plainly', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_add_vendor_user($1, $2, $3)', [
          VENDORS.one,
          '+233200000022',
          'second counter staff',
        ]),
      { commit: true }
    );
    const order = await submitOrder();

    const one = await dedicatedClient(ACTORS.vendor1Staff);
    const two = await dedicatedClient(ACTORS.customerKwesi);
    try {
      const results = await Promise.all([
        one.query('select * from public.vendor_accept_order($1)', [order.order_id]),
        two.query('select * from public.vendor_accept_order($1)', [order.order_id]),
      ]);
      const envelopes = results.map((r) => r.rows[0]);
      const won = envelopes.filter((e) => e.success);
      const lost = envelopes.filter((e) => !e.success);
      assert.equal(won.length, 1, 'exactly one accept succeeds');
      assert.equal(lost.length, 1);
      assert.match(lost[0].reason, /someone else already accepted this order/);
    } finally {
      await one.end();
      await two.end();
    }

    assert.equal((await getOrder(order.order_id)).order_status, 'ACCEPTED');

    const rejected = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.order_events where order_id = $1 and event = 'VENDOR_ACCEPT' and not accepted",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(rejected.length, 1, 'the losing attempt is logged');
  });

  test('accepting twice in sequence is refused the second time', async () => {
    const order = await submitOrder();
    assert.equal(
      (
        await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_accept_order($1)', [
          order.order_id,
        ])
      ).success,
      true
    );
    const second = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_accept_order($1)',
      [order.order_id]
    );
    assert.equal(second.success, false);
    assert.match(second.reason, /someone else already accepted this order/);
  });

  // =========================================================================
  // Invalid transitions
  // =========================================================================
  test('every out-of-order move is refused and changes nothing', async () => {
    const order = await submitOrder();

    for (const [sql, expected] of [
      ['select public.vendor_mark_preparing($1)', /cannot start preparing from state SUBMITTED/],
      ['select public.vendor_mark_ready($1)', /cannot be marked ready from state SUBMITTED/],
      ['select public.vendor_complete_pickup_order($1)', /not a ready pickup order/],
    ]) {
      const result = await tryTransition(ACTORS.vendor1Staff, sql, [order.order_id]);
      assert.equal(result.success, false);
      assert.match(result.reason, expected);
    }

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'SUBMITTED');
    assert.equal(stored.preparing_at, null);
    assert.equal(stored.ready_at, null);
  });

  test('a vendor cannot start cooking before the money is in', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const result = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_mark_preparing($1)',
      [order.order_id]
    );
    assert.equal(result.success, false);
    assert.match(result.reason, /payment must be PAID/);
    assert.equal((await getOrder(order.order_id)).order_status, 'ACCEPTED');
  });

  test('an order past its window says the window closed, not something nonsensical', async () => {
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
    // The row is still SUBMITTED until the sweep runs, so a naive message would
    // read "cannot be accepted from state SUBMITTED".
    assert.match(result.reason, /60-second answer window has closed/);
  });

  test('an order that has vanished reports that, rather than a state', async () => {
    const result = await tryTransition(ACTORS.admin, 'select public.vendor_accept_order($1)', [
      '00000000-0000-0000-0000-000000000000',
    ]);
    assert.equal(result.success, false);
    assert.match(result.reason, /no longer exists/);
  });

  test('a rejected order is closed and cannot be revived', async () => {
    const order = await submitOrder();
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_reject_order($1, $2)', [
      order.order_id,
      'no ingredients',
    ]);

    const rows = await board(ACTORS.vendor1Staff);
    const card = rows.find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'CLOSED');
    assert.equal(card.cancellation_reason, 'no ingredients');

    const revive = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_accept_order($1)',
      [order.order_id]
    );
    assert.equal(revive.success, false);
  });

  // =========================================================================
  // Things a vendor must never be able to do
  // =========================================================================
  test('a vendor cannot mark an order PAID', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const direct = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query("update public.orders set payment_status = 'PAID' where id = $1", [order.order_id])
      )
    );
    assert.match(direct.message, /permission denied/i);

    const viaFunction = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.confirm_payment($1, $2, $3)', [order.order_id, 'x', 1])
      )
    );
    assert.match(viaFunction.message, /permission denied/i);

    assert.equal((await getOrder(order.order_id)).payment_status, 'UNPAID');
  });

  test('a vendor cannot change the price of an order already submitted', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });

    const onOrder = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('update public.orders set total_pesewas = 99999 where id = $1', [order.order_id])
      )
    );
    assert.match(onOrder.message, /permission denied/i);

    const onLines = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('update public.order_items set unit_price_pesewas = 99999 where order_id = $1', [
          order.order_id,
        ])
      )
    );
    assert.match(onLines.message, /permission denied/i);

    assert.equal((await getOrder(order.order_id)).total_pesewas, 7700);
  });

  test('repricing the MENU does not move an order already submitted', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
          MENU.jollof,
          'price rise',
          9900,
        ]),
      { commit: true }
    );

    const view = await detail(ACTORS.vendor1Staff, order.order_id);
    assert.equal(view.total_pesewas, 7700);
    assert.equal(
      view.items[0].unit_price_pesewas,
      3500,
      'the vendor sees what the customer agreed to'
    );
  });

  test('a vendor cannot alter what the customer ordered', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });

    for (const sql of [
      'update public.order_items set quantity = 99 where order_id = $1',
      'delete from public.order_items where order_id = $1',
      "insert into public.order_items (order_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas) values ($1, 'Sneaky Extra', 5000, 1, 5000)",
    ]) {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) => c.query(sql, [order.order_id]))
      );
      assert.match(error.message, /permission denied/i);
    }

    const items = await asService(
      async (c) =>
        (await c.query('select * from public.order_items where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].quantity, 1);
  });

  test('a vendor cannot complete a delivery', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.partner_complete_delivery($1, $2)', [
          order.order_id,
          secrets.delivery_code,
        ])
      )
    );
    assert.match(error.message, /not carrying this delivery/);

    const direct = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query("update public.orders set delivery_status = 'DELIVERED' where id = $1", [
          order.order_id,
        ])
      )
    );
    assert.match(direct.message, /permission denied/i);
  });

  test('a vendor cannot assign a Partner', async () => {
    const order = await orderReadyForDispatch();

    const direct = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query(
          "update public.orders set partner_id = $1, delivery_status = 'ASSIGNED' where id = $2",
          [ACTORS.partnerYaw, order.order_id]
        )
      )
    );
    assert.match(direct.message, /permission denied/i);

    // partner_accept_delivery would assign the VENDOR, who is not an approved
    // Partner, so it refuses on those grounds.
    const viaFunction = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select * from public.partner_accept_delivery($1)', [order.order_id])
      )
    );
    assert.match(viaFunction.message, /not approved/);

    assert.equal((await getOrder(order.order_id)).partner_id, null);
  });

  test('a vendor cannot read pickup or delivery codes', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select * from public.order_secrets where order_id = $1', [order.order_id])
      )
    );
    assert.match(error.message, /permission denied/i);

    const viaFunction = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.get_my_pickup_code($1)', [order.order_id])
      )
    );
    assert.match(viaFunction.message, /no pickup code available/);
  });

  test('the board never carries the room number or the customer', async () => {
    const order = await submitOrder({ destination: LOCATIONS.room204 });
    const card = (await board(ACTORS.vendor1Staff)).find((r) => r.order_id === order.order_id);

    assert.equal(card.destination_zone, 'Hostel Block A', 'the zone is useful context');
    const serialised = JSON.stringify(card);
    assert.ok(!serialised.includes('Room 204'), 'the room is never sent to the vendor');
    assert.ok(!serialised.includes('+2332000000'), 'no phone number either');
    assert.ok(!('customer_id' in card));
    assert.ok(!('destination_location_id' in card));

    const view = await detail(ACTORS.vendor1Staff, order.order_id);
    const detailSerialised = JSON.stringify(view);
    assert.ok(!detailSerialised.includes('Room 204'));
    assert.ok(!detailSerialised.includes('+2332000000'));
  });

  test('a vendor cannot suspend themselves out of trouble or change their own status', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query("update public.vendors set status = 'ACTIVE' where id = $1", [VENDORS.one])
      )
    );
    assert.match(error.message, /permission denied/i);

    const viaAdmin = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_set_vendor_status($1, $2, $3)', [
          VENDORS.one,
          'ACTIVE',
          'self serve',
        ])
      )
    );
    assert.match(viaAdmin.message, /admin privileges required/);
  });

  // =========================================================================
  // Open / closed
  // =========================================================================
  test('a vendor can close and reopen their own stall', async () => {
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_accepting_orders($1, false)', [VENDORS.one]),
      { commit: true }
    );

    const closed = await expectRejection(submitOrder({ vendorId: VENDORS.one }));
    assert.match(closed.message, /not accepting orders/);

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_accepting_orders($1, true)', [VENDORS.one]),
      { commit: true }
    );

    const order = await submitOrder({ vendorId: VENDORS.one });
    assert.ok(order.order_id);
  });

  test('closing the stall does not disturb orders already in flight', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_accepting_orders($1, false)', [VENDORS.one]),
      { commit: true }
    );

    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);
    assert.equal(
      (await getOrder(order.order_id)).order_status,
      'READY',
      'the customer still gets fed'
    );
  });

  test('a vendor cannot open or close a stall they do not staff', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_set_accepting_orders($1, false)', [VENDORS.two])
      )
    );
    assert.match(error.message, /not authorised for this vendor/);
  });

  // =========================================================================
  // Audit
  // =========================================================================
  test('the whole vendor journey is reconstructable from the event log', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);

    const events = await asService(
      async (c) =>
        (
          await c.query(
            'select event, actor_role from public.order_events where order_id = $1 order by id',
            [order.order_id]
          )
        ).rows
    );
    assert.deepEqual(
      events.map((e) => e.event),
      [
        'ORDER_SUBMITTED',
        'VENDOR_ACCEPT',
        'PAYMENT_INTENT_CREATED',
        'PAYMENT_CONFIRMED',
        'VENDOR_PREPARING',
        'VENDOR_READY',
        'DISPATCH_OPENED',
      ]
    );
    assert.equal(events.find((e) => e.event === 'VENDOR_ACCEPT').actor_role, 'VENDOR');
  });
});
