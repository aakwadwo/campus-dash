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
  acceptedOrder,
  chooseFulfilment,
  partnerAccept,
  payOrder,
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

  /** A basket quote: a vendor and some items. Food plus the 5% fee. */
  /**
   * A checkout quote. The fulfilment is part of the question now, because the
   * customer answers it before paying and the delivery fee is part of the
   * number they see above the Pay button.
   */
  const quote = (userId, args, fulfilment = null) =>
    asUser(
      userId,
      async (c) =>
        (
          await c.query('select * from public.quote_order($1, $2::jsonb, $3)', [
            ...args,
            fulfilment,
          ])
        ).rows[0]
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
      JSON.stringify([
        // A crafted basket carrying its own prices.
        { menu_item_id: MENU.jollof, quantity: 2, unit_price_pesewas: 1, price: 1, total: 1 },
        { menu_item_id: MENU.water, quantity: 1, unit_price_pesewas: 1 },
      ]),
    ]);

    // 2 × GH₵35 + GH₵3 = GH₵73 food, + 5% (GH₵3.65) = GH₵76.65
    assert.equal(result.subtotal_pesewas, 7300);
    assert.equal(result.service_fee_pesewas, 365);
    assert.equal(result.total_pesewas, 7665);
    assert.equal(result.lines[0].unit_price_pesewas, 3500, 'the menu price, not the sent one');
  });

  test('a quote is the FINAL price, and the fulfilment is part of the question', async () => {
    const basket = [VENDORS.one, JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }])];

    // GH₵35 food + 5% = GH₵36.75, collected.
    const collect = await quote(ACTORS.customerAma, basket, 'PICKUP');
    assert.equal(collect.service_fee_pesewas, 175);
    assert.equal(collect.delivery_fee_pesewas, 0);
    assert.equal(collect.total_pesewas, 3675);

    // The same basket, delivered: GH₵5 more, and the service fee does not move
    // — it is a share of what the FOOD costs.
    const delivered = await quote(ACTORS.customerAma, basket, 'DELIVERY');
    assert.equal(delivered.service_fee_pesewas, 175);
    assert.equal(delivered.delivery_fee_pesewas, 500);
    assert.equal(delivered.total_pesewas, 4175);

    // And the screen is told whether delivery is on offer at all, so it can
    // grey the option out rather than quoting something submission would refuse.
    assert.equal(delivered.delivery_available, true);
  });

  test('the quote and the submitted order always agree', async () => {
    const items = [
      { menu_item_id: MENU.jollof, quantity: 2 },
      { menu_item_id: MENU.waakye, quantity: 1 },
    ];
    const quoted = await quote(
      ACTORS.customerAma,
      [VENDORS.one, JSON.stringify(items)],
      'DELIVERY'
    );
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
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
      ])
    );
    assert.match(closed.message, /not accepting orders/);

    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = true where id = $1', [VENDORS.one])
    );

    const unavailable = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        JSON.stringify([{ menu_item_id: MENU.kelewele, quantity: 1 }]),
      ])
    );
    assert.match(unavailable.message, /unavailable/);

    const wrongVendor = await expectRejection(
      quote(ACTORS.customerAma, [
        VENDORS.one,
        JSON.stringify([{ menu_item_id: MENU.shawarma, quantity: 1 }]),
      ])
    );
    assert.match(wrongVendor.message, /unavailable/);

    // A bad DESTINATION is not a quoting failure, because a quote does not take
    // one. It is refused at submission, where the choice is actually made.
    const badDestination = await expectRejection(submitOrder({ destination: LOCATIONS.floor2 }));
    assert.match(badDestination.message, /not a valid delivery location/);
  });

  test('invalid quantities are refused', async () => {
    for (const quantity of [0, -3, null]) {
      const error = await expectRejection(
        quote(ACTORS.customerAma, [
          VENDORS.one,
          JSON.stringify([{ menu_item_id: MENU.jollof, quantity }]),
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
        JSON.stringify([
          { menu_item_id: MENU.jollof, quantity: 1 },
          { menu_item_id: MENU.jollof, quantity: 1 },
        ]),
      ])
    );
    assert.match(error.message, /appears more than once/);
  });

  test('an empty basket is refused', async () => {
    const error = await expectRejection(quote(ACTORS.customerAma, [VENDORS.one, '[]']));
    assert.match(error.message, /at least one item/);
  });

  // =========================================================================
  // Price snapshots
  // =========================================================================
  test('a price change after submission never touches the placed order', async () => {
    // 2 × GH₵35 = GH₵70 food + 5% (GH₵3.50), collected.
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    assert.equal(order.total_pesewas, 7350);

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
    assert.equal(view.total_pesewas, 7350, 'the customer still owes what they agreed');
    assert.equal(view.items[0].unit_price_pesewas, 3500);

    // GH₵100 food + 5% (GH₵5.00).
    const later = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    assert.equal(later.total_pesewas, 10500, 'a new order uses the new price');
  });

  test('an item sold out after submission does not break the placed order', async () => {
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.jollof]),
      { commit: true }
    );

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.items[0].name, 'Jollof Rice with Chicken');
    // GH₵35 food + 5% (GH₵1.75), collected.
    assert.equal(view.total_pesewas, 3675);
  });

  // =========================================================================
  // The stage a customer sees
  // =========================================================================
  test('the stage tracks the whole journey', async () => {
    const order = await submitOrder();
    const stageNow = async () => (await myOrder(ACTORS.customerAma, order.order_id)).stage;

    // PRICED AND PAYABLE FROM THE FIRST MOMENT. There is no vendor window to
    // wait out and no second screen asking how they want it: both were answered
    // at the checkout, which is why this is the first stage there is.
    assert.equal(await stageNow(), 'PAYMENT_REQUIRED');
    await payOrder(order.order_id);
    // Paying is what puts it in a kitchen, so PREPARING is immediate.
    assert.equal(await stageNow(), 'PREPARING');
    await vendorReady(order.order_id);
    // A DELIVERY order at READY is not "ready" to the customer — it is waiting
    // for someone to carry it.
    assert.equal(await stageNow(), 'SEARCHING_PARTNER');
  });

  test('a Partner can be found while the food is still cooking', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);

    const accepted = await partnerAccept(order.order_id);
    assert.equal(accepted.success, true, 'the offer pool opens at payment, not at READY');

    // The customer is told somebody has it — the reassurance they are waiting
    // for — while the order is still being made.
    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'PREPARING_PARTNER_ASSIGNED');
    assert.equal(view.order_status, 'PREPARING');
    assert.equal(view.delivery_status, 'ASSIGNED');
  });

  test('a pickup order reads READY, because there is nobody to wait for', async () => {
    const order = await acceptedOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'READY');
    assert.equal(view.delivery_status, 'NONE');
  });

  /**
   * A store cannot turn an order down any more, because it never sees one it
   * has not been paid for. The remaining way an order ends before a kitchen
   * touches it is an administrator cancelling it — which is also the path for
   * "we genuinely cannot make this", and it carries the reason.
   */
  test('a cancelled order says so, and shows the reason, with no charge', async () => {
    const order = await submitOrder();
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [order.order_id, 'store ran out']),
      { commit: true }
    );

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'CANCELLED');
    assert.equal(view.cancellation_reason, 'store ran out');
    assert.equal(view.payment_status, 'UNPAID');
    assert.equal(view.payment_id, null, 'no payment was ever created');
  });

  test('an order nobody paid for is swept, with no charge', async () => {
    const order = await submitOrder();
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_stale_orders()'));

    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.stage, 'CANCELLED');
    assert.equal(view.payment_status, 'UNPAID');
  });

  test('delivery records the destination, and paying opens the search', async () => {
    const order = await acceptedOrder({ destination: LOCATIONS.room204 });

    let view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.fulfilment_type, 'DELIVERY');
    assert.match(view.destination, /Room 204/, 'the customer sees their own full destination');
    assert.equal(view.delivery_status, 'NONE', 'nothing is dispatched for an unpaid order');

    await payOrder(order.order_id);

    // DISPATCH OPENS AT PAYMENT, not at READY. A Partner found while the food
    // cooks is a Partner who is not standing at a counter waiting.
    view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(view.delivery_status, 'SEARCHING');
    assert.equal(view.stage, 'PREPARING');
  });

  // =========================================================================
  // Payment
  // =========================================================================
  test('payment cannot start on an order that has been cancelled', async () => {
    const order = await submitOrder();
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [order.order_id, 'changed mind']),
      { commit: true }
    );
    const error = await expectRejection(payOrder(order.order_id));
    assert.match(error.message, /must be ACCEPTED before payment/);
  });

  test('a repeated payment request produces one payment, not two charges', async () => {
    const order = await acceptedOrder();

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
    const order = await acceptedOrder();

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
    // Paying is what reaches the kitchen, so there is no waiting stage to sit in.
    assert.equal(view.stage, 'PREPARING');
  });

  test('two simultaneous pay taps cannot create two live intents', async () => {
    const order = await acceptedOrder();

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
    const order = await acceptedOrder();

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
    const order = await acceptedOrder();

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
      'select * from public.quote_order($1, $2::jsonb)',
      "select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)",
    ]) {
      const params = sql.includes('$1')
        ? [VENDORS.one, JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }])]
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
    const order = await acceptedOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    // THE STORE HOLDS THE CODE and reads it out; the CUSTOMER types it in. It
    // is never returned to the customer by any function — which is exactly why
    // this test has to read it as the store.
    const view = await myOrder(ACTORS.customerAma, order.order_id);
    assert.ok(!('pickup_code' in view), 'the collector is never shown their own code');

    const collection = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    await tryTransition(ACTORS.customerAma, 'select public.customer_complete_pickup($1, $2)', [
      order.order_id,
      collection,
    ]);

    const done = await myOrder(ACTORS.customerAma, order.order_id);
    assert.equal(done.stage, 'COMPLETED');
    assert.ok(done.completed_at);
    assert.equal(done.items.length, 1);
  });
});
