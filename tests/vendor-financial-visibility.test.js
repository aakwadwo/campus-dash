import { test, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatPesewas } from '../lib/util/money.js';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  MENU,
} from './helpers/db.js';
import {
  submitOrder,
  payOrder,
  vendorReady,
  getSecrets,
  orderReadyForDispatch,
  partnerAccept,
} from './helpers/flow.js';

/**
 * A vendor sees their own amount, and cannot reach anything else about the
 * money on an order — not through a screen, and not through the tables.
 *
 * The figures a store must never be able to retrieve are the customer's total,
 * the service fee, the delivery fee, and the Partner's earnings (Campus Dash's
 * revenue is the difference between them). Every query here runs as the
 * `authenticated` role with the vendor's own claims — exactly what PostgREST
 * does for a browser holding the publishable key and a session.
 *
 * See migrations 20260930000001 and 20260930000002.
 */
describe('vendor financial visibility', () => {
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const as = (userId, sql, params = []) =>
    asUser(userId, async (c) => (await c.query(sql, params)).rows);
  const service = (sql, params = []) => asService(async (c) => (await c.query(sql, params)).rows);

  const SENSITIVE = [
    'total_pesewas',
    'service_fee_pesewas',
    'delivery_fee_pesewas',
    'partner_earnings_pesewas',
    'subtotal_pesewas',
    'pack_fee_pesewas',
  ];

  // 2 × GH₵35 of food, delivered: the order carries every fee there is.
  async function paidDelivery() {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    await payOrder(order.order_id);
    return order;
  }

  // ===========================================================================
  // 1. The orders table
  // ===========================================================================
  test('a vendor cannot read their own orders from the table, fees or otherwise', async () => {
    const order = await paidDelivery();

    const rows = await as(
      ACTORS.vendor1Staff,
      `select ${SENSITIVE.join(', ')} from public.orders where id = $1`,
      [order.order_id]
    );
    assert.deepEqual(rows, [], 'no row, so no total, fee or Partner earning');
    assert.deepEqual(await as(ACTORS.vendor1Staff, 'select id from public.orders'), []);

    // The row does exist and does carry every figure: the empty result is RLS,
    // not an order without fees.
    const [stored] = await service(
      'select total_pesewas, service_fee_pesewas, delivery_fee_pesewas from public.orders where id = $1',
      [order.order_id]
    );
    assert.ok(stored.total_pesewas > 7000 && stored.delivery_fee_pesewas > 0);
  });

  // ===========================================================================
  // 2. The event log
  // ===========================================================================
  test('a vendor cannot read order event details that carry totals or fees', async () => {
    const order = await paidDelivery();

    // The log really does hold the customer's total.
    const withMoney = await service(
      "select event from public.order_events where order_id = $1 and details::text ~ 'pesewas'",
      [order.order_id]
    );
    assert.ok(
      withMoney.some((e) => e.event === 'ORDER_SUBMITTED'),
      'ORDER_SUBMITTED records the total'
    );
    assert.ok(withMoney.some((e) => e.event === 'PAYMENT_INTENT_CREATED'));

    assert.deepEqual(
      await as(
        ACTORS.vendor1Staff,
        'select event, details from public.order_events where order_id = $1',
        [order.order_id]
      ),
      []
    );
    assert.deepEqual(await as(ACTORS.vendor1Staff, 'select id from public.order_events'), []);
  });

  test('no vendor-callable read returns a sensitive column', async () => {
    const order = await paidDelivery();

    const board = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_board($1)', [
      VENDORS.one,
    ]);
    const [detail] = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_detail($1)', [
      order.order_id,
    ]);
    const onDay = await as(
      ACTORS.vendor1Staff,
      'select * from public.vendor_orders_on_day($1, (now() at time zone $2)::date)',
      [VENDORS.one, 'UTC']
    );

    for (const row of [...board, detail, ...onDay]) {
      for (const column of SENSITIVE) {
        assert.ok(!(column in row), `${column} must not be returned to a vendor`);
      }
    }
    assert.equal(detail.vendor_amount_pesewas, 7000, 'the food, and only the food');
    // The detail's item lines are the food too: they sum to the vendor amount.
    assert.equal(
      detail.items.reduce((sum, i) => sum + Number(i.line_total_pesewas), 0),
      7000
    );
  });

  // ===========================================================================
  // 3. Every vendor workflow still works
  // ===========================================================================
  test('the vendor board, detail, counts, ready and handoff all still work', async () => {
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(order.order_id);

    const [card] = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_board($1)', [
      VENDORS.one,
    ]);
    assert.equal(card.order_id, order.order_id);
    assert.equal(card.vendor_amount_pesewas, 7000);
    assert.equal(card.item_count, 1);

    const [{ n: pending }] = await as(
      ACTORS.vendor1Staff,
      'select public.vendor_pending_count($1) as n',
      [VENDORS.one]
    );
    assert.equal(pending, 1);

    const ready = await vendorReady(order.order_id);
    assert.equal(ready.success, true, 'Ready for pickup still goes through');

    const [detail] = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_detail($1)', [
      order.order_id,
    ]);
    assert.equal(detail.order_status, 'READY');
    assert.equal(detail.items.length, 1);
    assert.equal(detail.handoff_code_available, true);

    const [{ code }] = await as(
      ACTORS.vendor1Staff,
      'select public.vendor_handoff_code($1) as code',
      [order.order_id]
    );
    const secrets = await getSecrets(order.order_id);
    assert.match(String(code), /^\d{4}$/);
    assert.equal(String(code), String(secrets.pickup_code), 'the code the store reads out');

    const [{ n: active }] = await as(
      ACTORS.vendor1Staff,
      'select public.vendor_active_count($1) as n',
      [VENDORS.one]
    );
    assert.equal(active, 1);

    const days = await as(ACTORS.vendor1Staff, 'select * from public.vendor_daily_sales($1, 7)', [
      VENDORS.one,
    ]);
    assert.equal(days[0].order_count, 1);
    assert.equal(Number(days[0].sales_pesewas), 7000);

    // The money that IS the vendor's is still readable directly.
    const allocations = await as(
      ACTORS.vendor1Staff,
      'select payee_type, amount_pesewas from public.allocations where order_id = $1',
      [order.order_id]
    );
    assert.deepEqual(
      allocations.map((a) => [a.payee_type, Number(a.amount_pesewas)]),
      [['VENDOR', 7000]],
      'their own allocation only — never the platform row'
    );
  });

  /**
   * THE DASHBOARD CRASHED ON ITS FIRST PAID ORDER. The hosted database was
   * still on the vendor_order_board() that returned total_pesewas, the screen
   * read vendor_amount_pesewas, and formatPesewas(undefined) threw while
   * rendering the row. An empty board rendered, so nothing failed until a
   * store actually had an order.
   *
   * So the fields each vendor screen reads are taken FROM THE SCREEN'S SOURCE
   * and checked against what the function returns for a paid Self Pickup order.
   * A screen and a function that stop agreeing fail here, not at the counter.
   */
  test('every field the vendor screens read is returned for a paid self-pickup order', async () => {
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(order.order_id);

    const fieldsReadBy = (path, names) => {
      const source = readFileSync(new URL(`../app/vendor/${path}`, import.meta.url), 'utf8');
      const pattern = new RegExp(`\\b(?:${names.join('|')})\\.([a-z_]+)`, 'g');
      return [...new Set([...source.matchAll(pattern)].map((m) => m[1]))];
    };

    const board = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_board($1, 5)', [
      VENDORS.one,
    ]);
    const [detail] = await as(ACTORS.vendor1Staff, 'select * from public.vendor_order_detail($1)', [
      order.order_id,
    ]);
    const onDay = await as(
      ACTORS.vendor1Staff,
      'select * from public.vendor_orders_on_day($1, (now() at time zone $2)::date)',
      [VENDORS.one, 'UTC']
    );
    const days = await as(ACTORS.vendor1Staff, 'select * from public.vendor_daily_sales($1, 1)', [
      VENDORS.one,
    ]);

    const screens = [
      ['[vendorId]/order-board.js', ['order'], board],
      ['[vendorId]/orders/[orderId]/page.js', ['order'], [detail]],
      ['history/[day]/page.js', ['order', 'o'], onDay],
      // `placeholder` is set by the page itself on days with no sales row.
      ['history/page.js', ['d', 'day'], days, ['placeholder']],
    ];

    for (const [path, names, rows, local = []] of screens) {
      assert.equal(rows.length, 1, `${path}: the paid pickup order is there to render`);
      const fields = fieldsReadBy(path, names).filter((f) => !local.includes(f));
      assert.ok(fields.length > 0, `${path}: found the fields it reads`);
      for (const field of fields) {
        assert.ok(field in rows[0], `${path} reads ${field}, which the function does not return`);
      }
    }

    // The exact call that threw, on every row a screen formats.
    for (const row of [...board, detail, ...onDay]) {
      assert.equal(formatPesewas(row.vendor_amount_pesewas), 'GH₵70.00');
    }
    assert.equal(formatPesewas(Number(days[0].sales_pesewas)), 'GH₵70.00');
    assert.equal(board[0].fulfilment_type, 'PICKUP');
    assert.equal(board[0].bucket, 'NEW');
  });

  // ===========================================================================
  // 4. Another vendor
  // ===========================================================================
  test("another vendor reaches none of this vendor's orders, events or sales", async () => {
    const order = await paidDelivery();
    const other = ACTORS.vendor2Staff;

    assert.deepEqual(
      await as(other, 'select id from public.orders where id = $1', [order.order_id]),
      []
    );
    assert.deepEqual(
      await as(other, 'select id from public.order_events where order_id = $1', [order.order_id]),
      []
    );
    assert.deepEqual(
      await as(other, 'select id from public.order_items where order_id = $1', [order.order_id]),
      []
    );
    assert.deepEqual(
      await as(other, 'select * from public.vendor_order_board($1)', [VENDORS.one]),
      []
    );
    assert.deepEqual(
      await as(other, 'select * from public.vendor_order_detail($1)', [order.order_id]),
      []
    );
    assert.deepEqual(
      await as(other, 'select * from public.vendor_daily_sales($1, 7)', [VENDORS.one]),
      []
    );
    assert.deepEqual(
      await as(
        other,
        'select * from public.vendor_orders_on_day($1, (now() at time zone $2)::date)',
        [VENDORS.one, 'UTC']
      ),
      []
    );
    assert.deepEqual(
      await as(other, 'select id from public.allocations where order_id = $1', [order.order_id]),
      []
    );
  });

  // ===========================================================================
  // 5. Admin
  // ===========================================================================
  test('an administrator still reads the whole order, its events and the vendor reads', async () => {
    const order = await paidDelivery();

    const [row] = await as(
      ACTORS.admin,
      `select ${SENSITIVE.join(', ')} from public.orders where id = $1`,
      [order.order_id]
    );
    assert.equal(row.subtotal_pesewas, 7000);
    assert.ok(row.total_pesewas > row.subtotal_pesewas);
    assert.ok(row.delivery_fee_pesewas > 0);

    const events = await as(
      ACTORS.admin,
      "select details from public.order_events where order_id = $1 and event = 'ORDER_SUBMITTED'",
      [order.order_id]
    );
    assert.equal(events[0].details.total_pesewas, row.total_pesewas);

    assert.equal(
      (
        await as(ACTORS.admin, 'select id from public.order_items where order_id = $1', [
          order.order_id,
        ])
      ).length,
      1
    );
    assert.equal(
      (await as(ACTORS.admin, 'select * from public.vendor_order_board($1)', [VENDORS.one])).length,
      1
    );
    assert.equal(
      (await as(ACTORS.admin, 'select * from public.vendor_daily_sales($1, 7)', [VENDORS.one]))[0]
        .order_count,
      1
    );
    assert.equal(
      (await as(ACTORS.admin, 'select * from public.admin_order_money($1)', [order.order_id]))
        .length >= 1,
      true
    );
  });

  // ===========================================================================
  // 6. Customer and Partner
  // ===========================================================================
  test('the customer still reads their own order, its items and its event log', async () => {
    const order = await paidDelivery();

    const [row] = await as(
      ACTORS.customerAma,
      'select total_pesewas, service_fee_pesewas, delivery_fee_pesewas from public.orders where id = $1',
      [order.order_id]
    );
    assert.ok(row.total_pesewas > 7000);
    assert.equal(
      (
        await as(ACTORS.customerAma, 'select id from public.order_items where order_id = $1', [
          order.order_id,
        ])
      ).length,
      1
    );
    const events = await as(
      ACTORS.customerAma,
      "select details from public.order_events where order_id = $1 and event = 'ORDER_SUBMITTED'",
      [order.order_id]
    );
    assert.equal(events[0].details.total_pesewas, row.total_pesewas);
    assert.equal(
      (
        await as(ACTORS.customerAma, 'select * from public.customer_order_detail($1)', [
          order.order_id,
        ])
      ).length,
      1
    );

    // Somebody else's order stays invisible to a different customer.
    assert.deepEqual(
      await as(ACTORS.customerKwesi, 'select id from public.orders where id = $1', [
        order.order_id,
      ]),
      []
    );
  });

  test('the assigned Partner still reads the order, its items and their earning', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const [row] = await as(
      ACTORS.partnerYaw,
      'select partner_earnings_pesewas from public.orders where id = $1',
      [order.order_id]
    );
    assert.ok(row.partner_earnings_pesewas > 0);
    assert.equal(
      (
        await as(ACTORS.partnerYaw, 'select id from public.order_items where order_id = $1', [
          order.order_id,
        ])
      ).length >= 1,
      true
    );
    assert.equal(
      (await as(ACTORS.partnerYaw, 'select * from public.partner_active_delivery()')).length,
      1
    );
  });

  // ===========================================================================
  // 7. Refunds
  // ===========================================================================
  /**
   * Moves an order to REFUND_PENDING, the way each settlement channel can.
   *
   * TRANSFER: admin_cancel_order(), the real refund path. It cancels the
   * vendor's ELIGIBLE allocation along with the platform row.
   *
   * SPLIT: the vendor's allocation was SETTLED at the charge. admin_cancel_order
   * cannot be used on such an order today — it cancels the platform row but not
   * the SETTLED vendor row, and check_allocations_balance() refuses the result.
   * That is existing settlement behaviour and deliberately not changed here. So
   * the order's refund STATE is set directly, leaving the ledger exactly as the
   * split wrote it, which is the case the vendor's sales figures must handle.
   */
  async function refund(orderId, { split }) {
    if (split) {
      await service(
        "update public.allocations set status = 'SETTLED', settlement_channel = 'SPLIT', settled_at = now() where order_id = $1 and payee_type = 'VENDOR'",
        [orderId]
      );
      await service("update public.orders set payment_status = 'REFUND_PENDING' where id = $1", [
        orderId,
      ]);
      return;
    }
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [orderId, 'refund test']),
      { commit: true }
    );
  }

  async function markRefunded(orderId, { split }) {
    if (split) {
      await service("update public.orders set payment_status = 'REFUNDED' where id = $1", [
        orderId,
      ]);
      return;
    }
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_mark_refunded($1, $2)', [orderId, 'refund test']),
      { commit: true }
    );
  }

  for (const split of [true, false]) {
    test(`a ${split ? 'split-settled' : 'transfer'} refund is listed, labelled and not a sale`, async () => {
      const kept = await paidDelivery();
      const refunded = await paidDelivery();

      await refund(refunded.order_id, { split });

      const pending = await as(
        ACTORS.vendor1Staff,
        'select order_id, payment_status, counts_as_sale from public.vendor_orders_on_day($1, (now() at time zone $2)::date)',
        [VENDORS.one, 'UTC']
      );
      const pendingRow = pending.find((o) => o.order_id === refunded.order_id);
      assert.equal(pendingRow.payment_status, 'REFUND_PENDING');
      assert.equal(pendingRow.counts_as_sale, false, 'a refund owed is not a sale');

      await markRefunded(refunded.order_id, { split });

      const onDay = await as(
        ACTORS.vendor1Staff,
        'select order_id, payment_status, counts_as_sale from public.vendor_orders_on_day($1, (now() at time zone $2)::date)',
        [VENDORS.one, 'UTC']
      );
      assert.equal(onDay.length, 2, 'the refunded order is still listed');
      const byId = Object.fromEntries(onDay.map((o) => [o.order_id, o]));
      assert.equal(
        byId[refunded.order_id].payment_status,
        'REFUNDED',
        'what History labels Refunded'
      );
      assert.equal(byId[refunded.order_id].counts_as_sale, false);
      assert.equal(byId[kept.order_id].counts_as_sale, true);

      const [day] = await as(
        ACTORS.vendor1Staff,
        'select * from public.vendor_daily_sales($1, 7)',
        [VENDORS.one]
      );
      assert.equal(day.order_count, 1, 'only the order that was not refunded');
      assert.equal(Number(day.sales_pesewas), 7000);

      // THE LEDGER IS UNTOUCHED. A split allocation stays SETTLED; a transfer
      // allocation is cancelled by the refund path exactly as before.
      const [allocation] = await service(
        "select status from public.allocations where order_id = $1 and payee_type = 'VENDOR'",
        [refunded.order_id]
      );
      assert.equal(allocation.status, split ? 'SETTLED' : 'CANCELLED');
    });
  }

  test('a day whose only order was refunded is still returned, at zero sales', async () => {
    const order = await paidDelivery();
    await refund(order.order_id, { split: true });
    await markRefunded(order.order_id, { split: true });

    const days = await as(ACTORS.vendor1Staff, 'select * from public.vendor_daily_sales($1, 7)', [
      VENDORS.one,
    ]);
    assert.equal(days.length, 1, 'the day stays reachable from History');
    assert.equal(days[0].order_count, 0);
    assert.equal(Number(days[0].sales_pesewas), 0);
  });
});
