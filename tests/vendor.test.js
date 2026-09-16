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
  acceptedOrder,
  chooseFulfilment,
  payOrder,
  vendorReady,
  getOrder,
  getSecrets,
  expectRejection,
  tryTransition,
  orderReadyForDispatch,
  partnerAccept,
  parseComposite,
} from './helpers/flow.js';

/**
 * The vendor module.
 *
 * The brief is narrower than it was: a store receives an order that has ALREADY
 * BEEN PAID FOR, makes it, and presses Ready. There is no accept, no reject and
 * no separate "start preparing" — so these check that path works, that an
 * unpaid order never reaches a counter at all, and that every way a vendor
 * might reach past their part is refused by the database rather than by the
 * screen.
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
  // Daily totals: the vendor's own amount, by day
  // =========================================================================
  test('daily sales count paid orders and sum only the vendor amount', async () => {
    const unpaid = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    const first = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    const second = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(first.order_id);
    await payOrder(second.order_id);

    const days = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.vendor_daily_sales($1, 7)', [VENDORS.one])).rows
    );
    assert.equal(days.length, 1, 'one day of trading');
    assert.equal(days[0].order_count, 2, 'the unpaid basket is not a sale');
    // 3 × GH₵35 of food. Neither the service fee nor the GH₵5 delivery is in it.
    assert.equal(Number(days[0].sales_pesewas), 10500);

    const orders = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (
          await c.query('select * from public.vendor_orders_on_day($1, $2)', [
            VENDORS.one,
            days[0].order_day,
          ])
        ).rows
    );
    assert.deepEqual(
      orders.map((o) => o.order_id).sort(),
      [first.order_id, second.order_id].sort()
    );
    assert.ok(!orders.some((o) => o.order_id === unpaid.order_id));
    assert.ok(orders.every((o) => !('total_pesewas' in o)));

    // Another store's figures are not readable, and nor are anybody's to anon.
    const otherStore = await asUser(
      ACTORS.vendor2Staff,
      async (c) =>
        (await c.query('select * from public.vendor_daily_sales($1, 7)', [VENDORS.one])).rows
    );
    assert.deepEqual(otherStore, []);
    await expectRejection(
      asAnon((c) => c.query('select * from public.vendor_daily_sales($1, 7)', [VENDORS.one]))
    );
  });

  // =========================================================================
  // The whole point: PAID -> PREPARING -> READY
  // =========================================================================
  test('an unpaid order never reaches the counter', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });

    assert.deepEqual(
      await board(ACTORS.vendor1Staff),
      [],
      'a basket abandoned at a checkout is not a ticket'
    );
    assert.equal(await detail(ACTORS.vendor1Staff, order.order_id), null);
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0);
  });

  test('a vendor takes a paid order to READY', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    await payOrder(order.order_id);

    let rows = await board(ACTORS.vendor1Staff);
    let card = rows.find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'NEW', 'it lands in the group that needs making');
    assert.equal(card.item_count, 1);
    // THE VENDOR'S AMOUNT: 2 × GH₵35 of food. The customer's total, the service
    // fee and the delivery fee are not the store's business and are not returned.
    assert.equal(card.vendor_amount_pesewas, 7000);
    for (const hidden of ['total_pesewas', 'service_fee_pesewas', 'delivery_fee_pesewas']) {
      assert.ok(!(hidden in card), `the board must not return ${hidden}`);
    }
    assert.equal(card.payment_status, 'PAID');

    // A QUEUE NUMBER, not a database key. It restarts at 1 each morning.
    assert.ok(Number.isInteger(card.vendor_order_no) && card.vendor_order_no >= 1);

    // Paying is what put it in the kitchen, and it opened dispatch on the way.
    let stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'PREPARING');
    assert.equal(stored.delivery_status, 'SEARCHING');

    await vendorReady(order.order_id);

    rows = await board(ACTORS.vendor1Staff);
    card = rows.find((r) => r.order_id === order.order_id);
    assert.equal(card.bucket, 'READY');

    stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'READY');
    assert.equal(stored.payment_status, 'PAID');
  });

  test('a pickup order runs the same path and completes without any Partner', async () => {
    const order = await acceptedOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);

    // NO CODE EXISTS YET. One is minted when the food is, so a code can never
    // be read out for something nobody has made.
    assert.equal((await getSecrets(order.order_id)).pickup_code, null);

    await vendorReady(order.order_id);

    const beforeComplete = await getOrder(order.order_id);
    assert.equal(beforeComplete.delivery_status, 'NONE', 'dispatch never opens for pickup');

    // THE STORE HOLDS THE CODE and reads it out; the CUSTOMER types it in. The
    // rule is unchanged — the person who holds the secret is never the person
    // who performs the act — and here that puts the store on the holding side,
    // exactly as it is for a Partner handoff. Reading the value from
    // order_secrets stands in for the conversation at the counter; no client
    // role can select that table.
    const code = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.match(code, /^\d{4}$/);

    const wrong = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_complete_pickup($1, $2)',
      [order.order_id, '0000']
    );
    assert.equal(wrong.success, false, 'a made-up code completes nothing');
    assert.equal((await getOrder(order.order_id)).order_status, 'READY');

    const result = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_complete_pickup($1, $2)',
      [order.order_id, code]
    );
    assert.equal(result.success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'COMPLETED');
  });

  test('the board groups every state into exactly one bucket', async () => {
    const unpaid = await submitOrder();

    const preparing = await acceptedOrder({ customer: ACTORS.customerKwesi });
    await payOrder(preparing.order_id);

    const ready = await acceptedOrder({ customer: ACTORS.customerEfua });
    await payOrder(ready.order_id);
    await vendorReady(ready.order_id);

    const done = await acceptedOrder({
      customer: ACTORS.customerAbena,
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(done.order_id);
    await vendorReady(done.order_id);
    await tryTransition(ACTORS.admin, 'select public.admin_complete_order($1, $2)', [
      done.order_id,
      'collected in person',
    ]);

    const rows = await board(ACTORS.vendor1Staff);
    const bucketOf = (id) => rows.find((r) => r.order_id === id)?.bucket;

    assert.equal(bucketOf(unpaid.order_id), undefined, 'an unpaid order is not on the board');
    assert.equal(bucketOf(preparing.order_id), 'NEW');
    assert.equal(bucketOf(ready.order_id), 'READY');
    assert.equal(bucketOf(done.order_id), 'CLOSED');
  });

  test('live work is ordered oldest first, so the order waiting longest leads', async () => {
    const first = await submitOrder();
    await payOrder(first.order_id);
    const second = await submitOrder({ customer: ACTORS.customerKwesi });
    await payOrder(second.order_id);

    const rows = (await board(ACTORS.vendor1Staff)).filter((r) => r.bucket === 'NEW');
    assert.equal(rows[0].order_id, first.order_id);
    assert.equal(rows[1].order_id, second.order_id);
  });

  test('the pending count tracks PAID orders still to be made', async () => {
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0);

    const order = await submitOrder();
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0, 'unpaid is not pending work');

    await payOrder(order.order_id);
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 1);

    await vendorReady(order.order_id);
    assert.equal(await pendingCount(ACTORS.vendor1Staff), 0);
  });

  // =========================================================================
  // Daily, per-store queue numbers
  // =========================================================================
  test('queue numbers start at 1 each day and are per store', async () => {
    const first = await submitOrder();
    const second = await submitOrder({ customer: ACTORS.customerKwesi });
    const otherStore = await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerEfua,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });

    assert.equal(first.vendor_order_no, 1);
    assert.equal(second.vendor_order_no, 2);
    assert.equal(otherStore.vendor_order_no, 1, 'each store counts on its own');

    // The internal reference still exists underneath, and is still unique
    // across the whole platform — payments, allocations and payouts key off it.
    assert.notEqual(first.order_number, otherStore.order_number);
  });

  test('yesterday does not carry into today', async () => {
    const yesterday = await submitOrder();
    assert.equal(yesterday.vendor_order_no, 1);

    // Age the counter and the order it produced by a day, which is what a new
    // morning looks like to next_vendor_order_no().
    await asService(async (c) => {
      await c.query(
        'update public.vendor_order_counters set order_day = order_day - 1 where vendor_id = $1',
        [VENDORS.one]
      );
      await c.query('update public.orders set order_day = order_day - 1 where id = $1', [
        yesterday.order_id,
      ]);
    });

    const today = await submitOrder({ customer: ACTORS.customerKwesi });
    assert.equal(today.vendor_order_no, 1, 'a new day starts at 001 again');
  });

  test('simultaneous orders never share a queue number', async () => {
    const customers = [ACTORS.customerAma, ACTORS.customerKwesi, ACTORS.customerEfua];
    const clients = await Promise.all(customers.map((id) => dedicatedClient(id)));
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query("select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)", [
            VENDORS.one,
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
          ])
        )
      );
      const numbers = results.map((r) => r.rows[0].vendor_order_no).sort();
      assert.deepEqual(numbers, [1, 2, 3], 'the counter row serialises the allocation');
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });

  // =========================================================================
  // Isolation between vendors
  // =========================================================================
  test('a vendor sees only their own orders on the board', async () => {
    const mine = await submitOrder({ vendorId: VENDORS.one });
    await payOrder(mine.order_id);
    const theirs = await submitOrder({
      vendorId: VENDORS.two,
      customer: ACTORS.customerKwesi,
      items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
    });
    await payOrder(theirs.order_id);

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
    await payOrder(theirs.order_id);
    assert.equal(await detail(ACTORS.vendor1Staff, theirs.order_id), null);
    assert.ok(await detail(ACTORS.vendor2Staff, theirs.order_id), 'their own vendor can see it');
  });

  test('another vendor cannot act on an order that is not theirs', async () => {
    const mine = await submitOrder({ vendorId: VENDORS.one });
    await payOrder(mine.order_id);

    for (const sql of [
      'select public.vendor_mark_ready($1)',
      'select public.vendor_handoff_code($1)',
    ]) {
      const error = await expectRejection(
        asUser(ACTORS.vendor2Staff, (c) => c.query(sql, [mine.order_id]))
      );
      assert.match(error.message, /not authorised for this order/);
    }

    assert.equal((await getOrder(mine.order_id)).order_status, 'PREPARING', 'untouched');
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
  // Ownership
  // =========================================================================
  // ONE ACCOUNT, ONE STORE. The staff join table is gone: "who may operate this
  // business" is a single column on vendors, so there is no second person to
  // add and no colleague to race. What replaced the old multi-staff tests is
  // the question that actually matters — losing the store cuts off the board.
  test('the owner sees the board, and nobody else does', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    assert.ok((await board(ACTORS.vendor1Staff)).some((r) => r.order_id === order.order_id));

    for (const stranger of [ACTORS.vendor2Staff, ACTORS.customerKwesi, ACTORS.partnerYaw]) {
      assert.deepEqual(await board(stranger), [], 'a stranger sees nothing');
      assert.equal(await detail(stranger, order.order_id), null);
    }
  });

  test('losing the store cuts off the board immediately', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await asService((c) =>
      c.query('update public.vendors set owner_user_id = null where id = $1', [VENDORS.one])
    );

    assert.deepEqual(await board(ACTORS.vendor1Staff), []);
    assert.equal(await detail(ACTORS.vendor1Staff, order.order_id), null);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_mark_ready($1)', [order.order_id])
      )
    );
    assert.match(error.message, /not authorised/);
  });

  // =========================================================================
  // Concurrency
  // =========================================================================
  // ONE OWNER, TWO DEVICES. A phone and a tablet on the same counter, both
  // pressing Ready. There is nothing to accept any more, so this is the only
  // race a store can still have with itself — and it is the same guarantee:
  // one conditional UPDATE wins, the loser is told plainly and logged.
  test('the same owner marking ready twice at once: one wins, the other is told plainly', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    const one = await dedicatedClient(ACTORS.vendor1Staff);
    const two = await dedicatedClient(ACTORS.vendor1Staff);
    try {
      const results = await Promise.all([
        one.query('select public.vendor_mark_ready($1) as r', [order.order_id]),
        two.query('select public.vendor_mark_ready($1) as r', [order.order_id]),
      ]);
      const envelopes = results.map((res) => parseComposite(res.rows[0].r));
      assert.equal(envelopes.filter((e) => e.success).length, 1, 'exactly one succeeds');
      assert.equal(envelopes.filter((e) => !e.success).length, 1);
    } finally {
      await one.end();
      await two.end();
    }

    assert.equal((await getOrder(order.order_id)).order_status, 'READY');

    const rejected = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.order_events where order_id = $1 and event = 'VENDOR_READY' and not accepted",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(rejected.length, 1, 'the losing attempt is logged');
  });

  // =========================================================================
  // Invalid transitions
  // =========================================================================
  test('a vendor cannot mark an unpaid order ready', async () => {
    const order = await submitOrder();

    const result = await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_mark_ready($1)', [
      order.order_id,
    ]);
    assert.equal(result.success, false);
    assert.match(result.reason, /cannot be marked ready from state ACCEPTED/);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'ACCEPTED');
    assert.equal(stored.ready_at, null);
  });

  test('marking ready twice in sequence is refused the second time', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    assert.equal(
      (
        await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_mark_ready($1)', [
          order.order_id,
        ])
      ).success,
      true
    );
    const second = await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_mark_ready($1)', [
      order.order_id,
    ]);
    assert.equal(second.success, false);
    assert.match(second.reason, /cannot be marked ready from state READY/);
  });

  test('an order that has vanished reports that, rather than a state', async () => {
    const result = await tryTransition(ACTORS.admin, 'select public.vendor_mark_ready($1)', [
      '00000000-0000-0000-0000-000000000000',
    ]);
    assert.equal(result.success, false);
    assert.match(result.reason, /no longer exists/);
  });

  /**
   * THERE IS NO ACCEPT AND NO REJECT ANY MORE, and the functions that performed
   * them are unreachable rather than merely unused. They still exist, because
   * order_events on real orders point at them, but a browser cannot call one.
   */
  test('the acceptance workflow is not reachable by any client', async () => {
    for (const sql of [
      'select public.vendor_accept_order($1)',
      'select public.vendor_mark_preparing($1)',
      'select public.vendor_complete_pickup_order($1, $2)',
      'select public.get_my_pickup_code($1)',
      'select public.vendor_pickup_code($1)',
    ]) {
      const params = sql.includes('$2')
        ? ['00000000-0000-0000-0000-000000000000', '0000']
        : ['00000000-0000-0000-0000-000000000000'];
      const error = await expectRejection(asUser(ACTORS.vendor1Staff, (c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i, sql);
    }

    const reject = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_reject_order($1, $2)', [
          '00000000-0000-0000-0000-000000000000',
          'no',
        ])
      )
    );
    assert.match(reject.message, /permission denied/i);
  });

  // =========================================================================
  // Things a vendor must never be able to do
  // =========================================================================
  test('a vendor cannot mark an order PAID', async () => {
    const order = await acceptedOrder();

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
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });

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

    assert.equal((await getOrder(order.order_id)).total_pesewas, 7487);
  });

  test('repricing the MENU does not move an order already submitted', async () => {
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(order.order_id);

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
    assert.equal(view.vendor_amount_pesewas, 7000, 'the food the customer agreed to');
    for (const hidden of [
      'total_pesewas',
      'subtotal_pesewas',
      'service_fee_pesewas',
      'delivery_fee_pesewas',
    ]) {
      assert.ok(!(hidden in view), `the detail must not return ${hidden}`);
    }
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

  test('a vendor reads the handoff code and nothing else', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select * from public.order_secrets where order_id = $1', [order.order_id])
      )
    );
    assert.match(error.message, /permission denied/i);

    // What a vendor CAN read is the code for whoever is standing at their
    // counter — and only while somebody actually is.
    const handoff = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.match(handoff, /^\d{4}$/);

    // The delivery code stays out of reach: it is the customer's, and a vendor
    // who held it could record a delivery that never happened.
    assert.ok(
      !JSON.stringify(await detail(ACTORS.vendor1Staff, order.order_id)).includes('delivery_code')
    );
  });

  test('there is no handoff code before somebody is due to collect', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    const tooEarly = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_handoff_code($1)', [order.order_id])
      )
    );
    assert.match(tooEarly.message, /no handoff code on this order right now/);
  });

  /**
   * THE STORE IS NEVER TOLD WHERE IT IS GOING.
   *
   * The board used to carry the destination ZONE — "Hostel Block A" — as useful
   * context. It is not: a store hands food across a counter to whoever reads
   * back four digits, and it never travels anywhere. The zone was a customer's
   * whereabouts shown to a room, and it bought the store nothing, so it went
   * with the room number and the phone number rather than being narrowed again.
   */
  test('the board never carries the destination, the room number or the customer', async () => {
    const order = await acceptedOrder({ destination: LOCATIONS.room204 });
    await payOrder(order.order_id);
    const card = (await board(ACTORS.vendor1Staff)).find((r) => r.order_id === order.order_id);

    const serialised = JSON.stringify(card);
    assert.ok(!serialised.includes('Hostel Block A'), 'not even the block');
    assert.ok(!serialised.includes('Room 204'), 'the room is never sent to the vendor');
    assert.ok(!serialised.includes('+2332000000'), 'no phone number either');
    assert.ok(!('customer_id' in card));
    assert.ok(!('destination_zone' in card));
    assert.ok(!('destination_location_id' in card));

    const view = await detail(ACTORS.vendor1Staff, order.order_id);
    const detailSerialised = JSON.stringify(view);
    assert.ok(!detailSerialised.includes('Hostel Block A'));
    assert.ok(!detailSerialised.includes('Room 204'));
    assert.ok(!detailSerialised.includes('+2332000000'));
    assert.ok(!('destination_zone' in view));
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
    const order = await acceptedOrder();
    await payOrder(order.order_id);

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_accepting_orders($1, false)', [VENDORS.one]),
      { commit: true }
    );

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
  // Item availability — a vendor decision, unlike price
  // =========================================================================
  test('a vendor can mark their own item unavailable, and it stops being orderable', async () => {
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.jollof]),
      { commit: true }
    );

    const error = await expectRejection(
      submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] })
    );
    assert.match(error.message, /unavailable/);

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, true)', [MENU.jollof]),
      { commit: true }
    );

    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    assert.ok(order.order_id, 'and orderable again once it is back');
  });

  test('toggling availability cannot change the price', async () => {
    const before = await asService(
      async (c) =>
        (await c.query('select * from public.menu_items where id = $1', [MENU.jollof])).rows[0]
    );
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.jollof]),
      { commit: true }
    );

    const after = await asService(
      async (c) =>
        (await c.query('select * from public.menu_items where id = $1', [MENU.jollof])).rows[0]
    );
    assert.equal(after.price_pesewas, before.price_pesewas);
    assert.equal(after.name, before.name);
    assert.equal(after.sort_order, before.sort_order);
    assert.equal(after.is_available, false, 'only availability moved');
  });

  test('a vendor still cannot change a price by any route', async () => {
    const viaAdmin = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
          MENU.jollof,
          'raising my price',
          9900,
        ])
      )
    );
    assert.match(viaAdmin.message, /admin privileges required/);

    const direct = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('update public.menu_items set price_pesewas = 9900 where id = $1', [MENU.jollof])
      )
    );
    assert.match(direct.message, /permission denied/i);
  });

  test("a vendor cannot toggle another vendor's item", async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.shawarma])
      )
    );
    assert.match(error.message, /not authorised for this menu item/);

    const stored = await asService(
      async (c) =>
        (await c.query('select is_available from public.menu_items where id = $1', [MENU.shawarma]))
          .rows[0]
    );
    assert.equal(stored.is_available, true);
  });

  test('a customer cannot toggle availability at all', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.jollof])
      )
    );
    assert.match(error.message, /not authorised for this menu item/);
  });

  // =========================================================================
  // Privacy: the customer's phone number
  // =========================================================================
  test('a vendor cannot read the customer behind a live order', async () => {
    await acceptedOrder({ customer: ACTORS.customerAma });

    const rows = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(rows.length, 0, 'V1 keeps the customer anonymous to the vendor');
  });

  // =========================================================================
  // Audit
  // =========================================================================
  test('the whole vendor journey is reconstructable from the event log', async () => {
    const order = await acceptedOrder();
    await payOrder(order.order_id);
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
        'PAYMENT_INTENT_CREATED',
        'PAYMENT_CONFIRMED',
        // Paying is what puts an order in a kitchen and what opens dispatch.
        // Both are recorded as SYSTEM: nobody pressed anything.
        'VENDOR_PREPARING',
        'DISPATCH_OPENED',
        'VENDOR_READY',
      ]
    );
    assert.equal(events.find((e) => e.event === 'VENDOR_PREPARING').actor_role, 'SYSTEM');
    assert.equal(events.find((e) => e.event === 'VENDOR_READY').actor_role, 'VENDOR');
  });
});
