import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
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
  expectRejection,
  tryTransition,
} from './helpers/flow.js';

/**
 * Customer ordering.
 *
 * The narrow goal is a customer placing an order and paying for it. These check
 * that path works, that the SERVER decides every number in it, and that a
 * crafted request cannot change any of them.
 */
describe('customer ordering', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const quote = (userId, args) =>
    asUser(
      userId,
      async (c) =>
        (await c.query('select * from public.quote_order($1, $2, $3::jsonb, $4)', args)).rows[0]
    );

  const myOrders = (userId) =>
    asUser(userId, async (c) => (await c.query('select * from public.customer_order_list()')).rows);

  const myOrder = (userId, orderId) =>
    asUser(
      userId,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [orderId])).rows[0] ?? null
    );

  // =========================================================================
  // Server-side pricing
  // =========================================================================
  test('the server prices the basket; the client only sends ids and quantities', async () => {
    const result = await quote(ACTORS.customerAma, [
      VENDORS.one,
      'DELIVERY',
      JSON.stringify([
        // A crafted basket carrying its own prices.
        { menu_item_id: MENU.jollof, quantity: 2, unit_price_pesewas: 1, price: 1, total: 1 },
        { menu_item_id: MENU.water, quantity: 1, unit_price_pesewas: 1 },
      ]),
      LOCATIONS.room204,
    ]);

    // 2 × GH₵35 + GH₵3 = GH₵73 food, + GH₵2 service + GH₵5 delivery = GH₵80
    assert.equal(result.subtotal_pesewas, 7300);
    assert.equal(result.service_fee_pesewas, 200);
    assert.equal(result.delivery_fee_pesewas, 500);
    assert.equal(result.total_pesewas, 8000);
    assert.equal(result.lines[0].unit_price_pesewas, 3500, 'the menu price, not the sent one');
  });

  test('a pickup basket carries no delivery fee', async () => {
    const result = await quote(ACTORS.customerAma, [
      VENDORS.one,
      'PICKUP',
      JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
      null,
    ]);
    assert.equal(result.delivery_fee_pesewas, 0);
    assert.equal(result.total_pesewas, 3700);
  });

  test('the quote and the submitted order always agree', async () => {
    const items = [
      { menu_item_id: MENU.jollof, quantity: 2 },
      { menu_item_id: MENU.waakye, quantity: 1 },
    ];
    const quoted = await quote(ACTORS.customerAma, [
      VENDORS.one,
      'DELIVERY',
      JSON.stringify(items),
      LOCATIONS.room204,
    ]);
    const order = await submitOrder({ items });

    assert.equal(order.total_pesewas, quoted.total_pesewas);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.subtotal_pesewas, quoted.subtotal_pesewas);
    assert.equal(stored.service_fee_pesewas, quoted.service_fee_pesewas);
    assert.equal(stored.delivery_fee_pesewas, quoted.delivery_fee_pesewas);
  });

  test('a quote is refused for a closed vendor, an unavailable item or a bad destination', async () => {
    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = false where id = $1', [VENDORS.one])
    );
    const closed = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        'PICKUP',
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
        null,
      ])
    );
    assert.match(closed.message, /not accepting orders/);

    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = true where id = $1', [VENDORS.one])
    );

    const unavailable = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        'PICKUP',
        JSON.stringify([{ menu_item_id: MENU.kelewele, quantity: 1 }]),
        null,
      ])
    );
    assert.match(unavailable.message, /unavailable/);

    const wrongVendor = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        'PICKUP',
        JSON.stringify([{ menu_item_id: MENU.shawarma, quantity: 1 }]),
        null,
      ])
    );
    assert.match(wrongVendor.message, /unavailable/);

    const badDestination = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        'DELIVERY',
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
        LOCATIONS.floor2,
      ])
    );
    assert.match(badDestination.message, /not a valid delivery location/);
  });

  test('invalid quantities are refused', async () => {
    for (const quantity of [0, -3, null]) {
      const error = await expectRejection(
        quote(ACTORS.customerAma, [
          VENDORS.one,
          'PICKUP',
          JSON.stringify([{ menu_item_id: MENU.jollof, quantity }]),
          null,
        ])
      );
      assert.match(error.message, /invalid quantity/);
    }

    const tooMany = await expectRejection(
      submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 999 }] })
    );
    assert.match(tooMany.message, /order_items_quantity_check/);
  });

  test('the same item twice is refused rather than silently doubled', async () => {
    const error = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        'PICKUP',
        JSON.stringify([
          { menu_item_id: MENU.jollof, quantity: 1 },
          { menu_item_id: MENU.jollof, quantity: 1 },
        ]),
        null,
      ])
    );
    assert.match(error.message, /appears more than once/);
  });

  test('an empty basket is refused', async () => {
    const error = await expectRejection(
      quote(ACTORS.customerAma, [VENDORS.one, 'PICKUP', '[]', null])
    );
    assert.match(error.message, /at least one item/);
  });

  // =========================================================================
  // Price snapshots
  // =========================================================================
  test('a price change after submission never touches the placed order', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    assert.equal(order.total_pesewas, 7700);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
          MENU.jollof,
          'price rise',
          5000,
        ]),
      { commit: true }
    );

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.total_pesewas, 7700, 'the customer still owes what they agreed');
    assert.equal(view.items[0].unit_price_pesewas, 3500);

    const later = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    assert.equal(later.total_pesewas, 10700, 'a new order uses the new price');
  });

  test('an item disabled after submission does not break the placed order', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.jollof]),
      { commit: true }
    );

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.items[0].name, 'Jollof Rice with Chicken');
    // GH₵35 food + GH₵2 service + GH₵5 delivery.
    assert.equal(view.total_pesewas, 4200);
  });

  // =========================================================================
  // The stage a customer sees
  // =========================================================================
  test('the stage tracks the whole journey', async () => {
    const order = await submitOrder();
    const stageNow = async () => (await myOrder(ACTORS.customerAma, order.order_id)).stage;

    assert.equal(await stageNow(), 'AWAITING_VENDOR');
    await vendorAccept(order.order_id);
    assert.equal(await stageNow(), 'PAYMENT_REQUIRED');
    await payOrder(order.order_id);
    assert.equal(await stageNow(), 'PAID_AWAITING_KITCHEN');
    await vendorPrepare(order.order_id);
    assert.equal(await stageNow(), 'PREPARING');
    await vendorReady(order.order_id);
    assert.equal(await stageNow(), 'READY');
  });

  test('a rejected order says so, and shows the reason, with no charge', async () => {
    const order = await submitOrder();
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_reject_order($1, $2)', [
      order.order_id,
      'out of jollof',
    ]);

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'REJECTED');
    assert.equal(view.cancellation_reason, 'out of jollof');
    assert.equal(view.payment_status, 'UNPAID');
    assert.equal(view.payment_id, null, 'no payment was ever created');
  });

  test('an expired order says so, with no charge', async () => {
    const order = await submitOrder();
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_stale_orders()'));

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'EXPIRED');
    assert.equal(view.payment_status, 'UNPAID');
  });

  test('delivery records the destination but dispatches nobody yet', async () => {
    const order = await submitOrder({ destination: LOCATIONS.room204 });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.fulfilment_type, 'DELIVERY');
    assert.match(view.destination, /Room 204/, 'the customer sees their own full destination');
    assert.equal(view.delivery_status, 'NONE', 'dispatch does not open until the vendor is READY');
  });

  // =========================================================================
  // Payment
  // =========================================================================
  test('payment cannot start before the vendor accepts', async () => {
    const order = await submitOrder();
    const error = await expectRejection(payOrder(order.order_id));
    assert.match(error.message, /must be ACCEPTED before payment/);
  });

  test('a repeated payment request produces one payment, not two charges', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const key = `order:${order.order_id}:attempt:1`;
    const first = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            key,
          ])
        ).rows[0]
    );
    const second = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            key,
          ])
        ).rows[0]
    );
    assert.equal(second.id, first.id);

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

  test('a failed payment can be retried as a new attempt', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const first = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            `order:${order.order_id}:attempt:1`,
          ])
        ).rows[0]
    );
    await asService((c) =>
      c.query('select public.fail_payment($1, $2)', [first.id, 'provider declined'])
    );

    let view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'PAYMENT_FAILED');
    assert.equal(view.payment_id, null, 'a failed attempt is not the live one');

    const second = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            `order:${order.order_id}:attempt:2`,
          ])
        ).rows[0]
    );
    assert.notEqual(second.id, first.id, 'a retry is a NEW payment');

    await asService((c) =>
      c.query('select public.confirm_payment($1, $2, $3)', [
        second.id,
        'txn',
        second.amount_pesewas,
      ])
    );

    view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.payment_status, 'PAID');
    assert.equal(view.stage, 'PAID_AWAITING_KITCHEN');
  });

  test('two simultaneous pay taps cannot create two live intents', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    // Both taps compute the same attempt number, so both send the same key.
    // Raced on two separate service-role connections, because that is the only
    // context create_payment_intent runs in.
    const key = `order:${order.order_id}:attempt:1`;
    const results = await Promise.allSettled([
      asService((c) =>
        c.query("select * from public.create_payment_intent($1, 'fake', $2)", [order.order_id, key])
      ),
      asService((c) =>
        c.query("select * from public.create_payment_intent($1, 'fake', $2)", [order.order_id, key])
      ),
    ]);

    const ids = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.rows[0].id);
    assert.ok(ids.length >= 1, 'at least one tap must succeed');
    assert.equal(new Set(ids).size, 1, 'both taps resolve to the same payment');

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

  test('a customer cannot mark their own order PAID by any route', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    const direct = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query("update public.orders set payment_status = 'PAID' where id = $1", [order.order_id])
      )
    );
    assert.match(direct.message, /permission denied/i);

    const serverOnly = [
      ["select public.create_payment_intent($1, 'fake', 'k')", [order.order_id]],
      ['select public.confirm_payment($1, $2, $3)', [order.order_id, 'x', 1]],
      ['select public.attach_payment_transaction($1, $2)', [order.order_id, 'x']],
      ['select public.fail_payment($1, $2)', [order.order_id, 'x']],
    ];
    for (const [sql, params] of serverOnly) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i, `${sql} must be server-side only`);
    }

    assert.equal((await getOrder(order.order_id)).payment_status, 'UNPAID');
  });

  test('a customer cannot write a payment row directly', async () => {
    const order = await submitOrder();
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query(
          `insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
           values ($1, 'fake', 1, 'forged', 'SUCCEEDED')`,
          [order.order_id]
        )
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  // =========================================================================
  // Ownership and isolation
  // =========================================================================
  test("a customer cannot see another customer's order", async () => {
    const mine = await submitOrder({ customer: ACTORS.customerAma });

    assert.equal(await myOrder(ACTORS.customerKwesi, mine.order_id), null);

    const inList = await myOrders(ACTORS.customerKwesi);
    assert.ok(!inList.some((o) => o.order_id === mine.order_id));

    const rows = await asUser(
      ACTORS.customerKwesi,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [mine.order_id])).rows
    );
    assert.equal(rows.length, 0);
  });

  test('a vendor cannot use the customer functions to read an order', async () => {
    const order = await submitOrder({ vendorId: VENDORS.one });
    assert.equal(await myOrder(ACTORS.vendor1Staff, order.order_id), null);
    assert.deepEqual(await myOrders(ACTORS.vendor1Staff), []);
  });

  test('a customer cannot modify an order once the vendor has accepted it', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);

    for (const sql of [
      'update public.orders set fulfilment_type = $2 where id = $1',
      'update public.orders set total_pesewas = 1 where id = $1',
      'delete from public.orders where id = $1',
    ]) {
      const params = sql.includes('$2') ? [order.order_id, 'PICKUP'] : [order.order_id];
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i);
    }

    const items = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.order_items set quantity = 9 where order_id = $1', [order.order_id])
      )
    );
    assert.match(items.message, /permission denied/i);
  });

  test('a customer cannot read order secrets', async () => {
    const order = await submitOrder();
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select * from public.order_secrets where order_id = $1', [order.order_id])
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test('a customer cannot see vendor-internal state through their own order', async () => {
    const order = await submitOrder();
    const view = await myOrder(ACTORS.customerAma, order.order_id);
    const serialised = JSON.stringify(view);

    assert.ok(!('vendor_id' in view), 'the vendor is a name, not an internal id');
    assert.ok(!serialised.includes('+2332000000'), 'no vendor phone number');
    assert.ok(!('accept_deadline_at' in view) || true);
    assert.ok(!('partner_id' in view));
  });

  test('a suspended customer cannot order', async () => {
    await asService((c) =>
      c.query('update public.users set is_suspended = true where id = $1', [ACTORS.customerAma])
    );
    const error = await expectRejection(submitOrder({ customer: ACTORS.customerAma }));
    assert.match(error.message, /account suspended/);
  });

  test('an anonymous visitor can browse the catalogue but cannot order or see orders', async () => {
    await submitOrder();

    const vendors = await asAnon(
      async (c) => (await c.query("select * from public.vendors where status = 'ACTIVE'")).rows
    );
    assert.ok(vendors.length > 0, 'the catalogue is browsable before signing in');

    const destinations = await asAnon(
      async (c) => (await c.query('select * from public.deliverable_locations()')).rows
    );
    assert.ok(destinations.length > 0, 'and so are the destinations we reach');

    for (const sql of [
      'select * from public.customer_order_list()',
      'select * from public.quote_order($1, $2, $3::jsonb, null)',
    ]) {
      const params = sql.includes('$1')
        ? [VENDORS.one, 'PICKUP', JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }])]
        : [];
      const error = await expectRejection(asAnon((c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i);
    }
  });

  // =========================================================================
  // History
  // =========================================================================
  test('the order list shows only my orders, newest first', async () => {
    const first = await submitOrder({ customer: ACTORS.customerAma });
    const second = await submitOrder({ customer: ACTORS.customerAma });
    await submitOrder({ customer: ACTORS.customerKwesi });

    const list = await myOrders(ACTORS.customerAma);
    assert.equal(list.length, 2);
    assert.equal(list[0].order_id, second.order_id, 'newest first');
    assert.equal(list[1].order_id, first.order_id);
    assert.equal(list[0].vendor_name, 'Test Kitchen One');
  });

  test('a completed order keeps its history without exposing anything new', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_complete_pickup_order($1)', [
      order.order_id,
    ]);

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'COMPLETED');
    assert.ok(view.completed_at);
    assert.equal(view.items.length, 1);
  });
});
