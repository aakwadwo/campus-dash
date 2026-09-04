import { test, describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  LOCATIONS,
  MENU,
} from './helpers/db.js';
import {
  submitOrder,
  vendorAccept,
  payOrder,
  vendorPrepare,
  vendorReady,
  partnerAccept,
  completeDelivery,
  orderReadyForDispatch,
  expectRejection,
} from './helpers/flow.js';

/**
 * The Admin Operating System.
 *
 * These read models are how the business is run without a SQL client, so they
 * are held to the same standard as the write path:
 *
 *   1. THE NUMBERS ARE TRUE. A dashboard that rounds, estimates or double-counts
 *      is worse than no dashboard, because somebody will act on it.
 *   2. THE BOUNDARY IS THE DATABASE. Every function re-checks is_admin(). A
 *      non-admin who calls one directly — bypassing every screen — gets nothing.
 *   3. PRIVATE THINGS STAY PRIVATE. No document path is ever returned by an
 *      admin read model, only whether a document exists.
 */
describe('the admin console', () => {
  const SCAN_FEE = 200; // GH₵2.00 flat
  const DELIVERY_FEE = 500; // GH₵5.00
  const JOLLOF = 3500; // GH₵35.00
  const FOOD_FEE = 175; // 5% of the food

  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(`
        update public.pricing_config
           set service_fee_bps = 500, delivery_fee_pesewas = 500,
               scan_service_fee_pesewas = 200, partner_share_of_delivery_bps = 10000,
               partner_search_seconds = 600
         where id
      `)
    );
    await asService((c) =>
      c.query('update public.vendors set can_accept_scans = (id = any($1::uuid[]))', [
        [VENDORS.wafflemania, VENDORS.yellowBar],
      ])
    );
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  /** Runs a query as the seeded administrator. */
  const asAdmin = (fn) => asUser(ACTORS.admin, fn);

  const rowsAsAdmin = (sql, params = []) => asAdmin(async (c) => (await c.query(sql, params)).rows);

  const oneAsAdmin = async (sql, params = []) => (await rowsAsAdmin(sql, params))[0] ?? null;

  // --- fixtures -------------------------------------------------------------

  /** A FOOD order carried all the way to COMPLETED, with a full ledger. */
  async function completedFoodOrder() {
    const order = await submitOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      destination: LOCATIONS.room204,
    });
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);
    await vendorPrepare(order.order_id);
    await vendorReady(order.order_id);
    await partnerAccept(order.order_id);
    // completeDelivery reads both codes itself: the vendor releases the food
    // against the pickup code, the customer releases the delivery against theirs.
    await completeDelivery(order.order_id);
    return order.order_id;
  }

  async function scanOrder({ customer = ACTORS.customerAma, vendorId = VENDORS.wafflemania } = {}) {
    const row = await asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.submit_scan_order($1, $2, $3, $4, $5, $6)', [
            vendorId,
            LOCATIONS.room204,
            `${customer}/scans/scan-1.jpg`,
            'image/jpeg',
            120000,
            null,
          ])
        ).rows[0],
      { commit: true }
    );
    return row.order_id;
  }

  async function payScan(orderId) {
    return asService(async (c) => {
      const p = (
        await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
          orderId,
          `scan:${orderId}`,
        ])
      ).rows[0];
      await c.query('select public.confirm_payment($1, $2, $3)', [
        p.id,
        `txn_${orderId}`,
        p.amount_pesewas,
      ]);
      return p;
    });
  }

  // =========================================================================
  // THE BOUNDARY — every read model refuses a non-admin
  // =========================================================================
  describe('authorisation', () => {
    // Called DIRECTLY, bypassing every screen. This is the boundary that
    // matters: route protection is a convenience, is_admin() is the control.
    const READ_MODELS = [
      ['admin_dashboard', 'select public.admin_dashboard() v'],
      ['admin_order_board', 'select * from public.admin_order_board()'],
      ['admin_order_board_summary', 'select * from public.admin_order_board_summary()'],
      ['admin_customers', 'select * from public.admin_customers()'],
      ['admin_partners', 'select * from public.admin_partners()'],
      ['admin_ledger', 'select * from public.admin_ledger()'],
      ['admin_ledger_totals', 'select public.admin_ledger_totals() v'],
      ['admin_exceptions', 'select * from public.admin_exceptions()'],
      ['admin_vendors', 'select * from public.admin_vendors()'],
    ];

    for (const [name, sql] of READ_MODELS) {
      test(`${name} gives a customer nothing`, async () => {
        const rows = await asUser(ACTORS.customerAma, async (c) => (await c.query(sql)).rows);
        const empty = rows.length === 0 || Object.values(rows[0])[0] === null;
        assert.ok(empty, `${name} leaked data to a customer`);
      });

      test(`${name} gives an approved Partner nothing`, async () => {
        const rows = await asUser(ACTORS.partnerYaw, async (c) => (await c.query(sql)).rows);
        const empty = rows.length === 0 || Object.values(rows[0])[0] === null;
        assert.ok(empty, `${name} leaked data to a Partner`);
      });

      test(`${name} gives vendor staff nothing`, async () => {
        const rows = await asUser(ACTORS.vendor1Staff, async (c) => (await c.query(sql)).rows);
        const empty = rows.length === 0 || Object.values(rows[0])[0] === null;
        assert.ok(empty, `${name} leaked data to vendor staff`);
      });

      test(`${name} is not reachable by anon at all`, async () => {
        const error = await expectRejection(asAnon((c) => c.query(sql)));
        assert.match(error.message, /permission denied|does not exist/i);
      });
    }

    /**
     * A SUSPENDED ADMIN IS NOT AN ADMIN.
     *
     * is_admin() requires `not is_suspended`, so suspension revokes the whole
     * console in one column — there is no separate "admin disabled" flag to
     * forget to check.
     */
    test('a suspended administrator loses every read model', async () => {
      await asService((c) =>
        c.query('update public.users set is_suspended = true where id = $1', [ACTORS.admin])
      );
      try {
        for (const [name, sql] of READ_MODELS) {
          const rows = await asAdmin(async (c) => (await c.query(sql)).rows);
          const empty = rows.length === 0 || Object.values(rows[0])[0] === null;
          assert.ok(empty, `${name} still answered a suspended admin`);
        }
      } finally {
        await asService((c) =>
          c.query('update public.users set is_suspended = false where id = $1', [ACTORS.admin])
        );
      }
    });

    test('a suspended administrator cannot write either', async () => {
      await asService((c) =>
        c.query('update public.users set is_suspended = true where id = $1', [ACTORS.admin])
      );
      try {
        const error = await expectRejection(
          asUser(ACTORS.admin, (c) =>
            c.query('select * from public.admin_set_vendor_scans($1, true, $2)', [
              VENDORS.one,
              'should never apply',
            ])
          )
        );
        assert.match(error.message, /admin privileges required/i);
      } finally {
        await asService((c) =>
          c.query('update public.users set is_suspended = false where id = $1', [ACTORS.admin])
        );
      }
    });
  });

  // =========================================================================
  // DASHBOARD
  // =========================================================================
  describe('dashboard', () => {
    test('an empty pilot reports zeros, not nulls', async () => {
      const d = (await oneAsAdmin('select public.admin_dashboard() v')).v;

      assert.equal(d.operations.orders_today, 0);
      assert.equal(d.operations.active_food, 0);
      assert.equal(d.operations.active_scan, 0);
      assert.equal(d.operations.needs_attention, 0);
      assert.equal(d.money.collected_pesewas, 0);
      assert.equal(d.money.vendor_owed, 0);
      assert.equal(d.people.vendors, 4, 'the seeded catalogue');
      assert.equal(d.people.vendors_scan, 2, 'only the two scan restaurants');
      assert.equal(d.system.scan_fee_configured, true);
    });

    test('the numbers move with reality, and money is counted from the ledger', async () => {
      await completedFoodOrder();
      const scanId = await scanOrder();
      await payScan(scanId);

      const d = (await oneAsAdmin('select public.admin_dashboard() v')).v;

      assert.equal(d.operations.orders_today, 2);
      assert.equal(d.operations.active_scan, 1, 'the scan errand is in flight');
      assert.equal(d.operations.searching, 1, 'and it is looking for a Partner');

      // Two orders paid: GH₵40.75 of food + GH₵7.00 of errand.
      const foodGross = JOLLOF + FOOD_FEE + DELIVERY_FEE;
      const scanGross = SCAN_FEE + DELIVERY_FEE;
      assert.equal(Number(d.money.collected_pesewas), foodGross + scanGross);
      assert.equal(Number(d.money.payments_count), 2);

      // The vendor is owed the FOOD only. The scan contributes nothing.
      assert.equal(Number(d.money.vendor_owed), JOLLOF);
      // The Partner earned the completed food delivery.
      assert.equal(Number(d.money.partner_owed), DELIVERY_FEE);
    });

    test('a non-admin gets null rather than a zeroed dashboard', async () => {
      const row = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select public.admin_dashboard() v')).rows[0]
      );
      assert.equal(row.v, null, 'null is "you may not ask", which is not the same as zero');
    });
  });

  // =========================================================================
  // ORDERS
  // =========================================================================
  describe('orders', () => {
    test('the board shows both order types and labels them', async () => {
      await completedFoodOrder();
      const scanId = await scanOrder();
      await payScan(scanId);

      const rows = await rowsAsAdmin('select * from public.admin_order_board()');
      assert.equal(rows.length, 2);
      assert.deepEqual(new Set(rows.map((r) => r.order_type)), new Set(['FOOD', 'SCAN']));

      const scan = rows.find((r) => r.order_type === 'SCAN');
      assert.equal(scan.scan_status, 'UPLOADED');
      assert.equal(scan.attention, 'SEARCHING_PARTNER');

      const food = rows.find((r) => r.order_type === 'FOOD');
      assert.equal(food.scan_status, null, 'a food order has no scan dimension');
      assert.equal(food.attention, 'DONE');
    });

    test('filters narrow in the database', async () => {
      await completedFoodOrder();
      const scanId = await scanOrder();
      await payScan(scanId);

      const scanOnly = await rowsAsAdmin("select * from public.admin_order_board(null,100,'SCAN')");
      assert.equal(scanOnly.length, 1);
      assert.equal(scanOnly[0].order_type, 'SCAN');

      const foodOnly = await rowsAsAdmin("select * from public.admin_order_board(null,100,'FOOD')");
      assert.equal(foodOnly.length, 1);

      const completed = await rowsAsAdmin(
        "select * from public.admin_order_board(null,100,null,'COMPLETED')"
      );
      assert.equal(completed.length, 1);
      assert.equal(completed[0].order_status, 'COMPLETED');

      const paid = await rowsAsAdmin(
        "select * from public.admin_order_board(null,100,null,null,'PAID')"
      );
      assert.equal(paid.length, 2, 'both are paid');

      const unassigned = await rowsAsAdmin(
        "select * from public.admin_order_board(null,100,null,null,null,'UNASSIGNED')"
      );
      assert.equal(unassigned.length, 1, 'the scan errand has no Partner yet');

      const byVendor = await rowsAsAdmin(
        'select * from public.admin_order_board(null,100,null,null,null,null,$1)',
        [VENDORS.wafflemania]
      );
      assert.equal(byVendor.length, 1);
      assert.equal(byVendor[0].order_type, 'SCAN');
    });

    test('search matches an order number and a customer name, and nothing else', async () => {
      const foodId = await completedFoodOrder();
      const number = (
        await asService(
          async (c) =>
            (await c.query('select order_number from public.orders where id = $1', [foodId])).rows
        )
      )[0].order_number;

      const byNumber = await rowsAsAdmin(
        'select * from public.admin_order_board(null,100,null,null,null,null,null,null,null,$1)',
        [number]
      );
      assert.equal(byNumber.length, 1);

      const byName = await rowsAsAdmin(
        'select * from public.admin_order_board(null,100,null,null,null,null,null,null,null,$1)',
        ['Ama']
      );
      assert.equal(byName.length, 1);

      const nonsense = await rowsAsAdmin(
        'select * from public.admin_order_board(null,100,null,null,null,null,null,null,null,$1)',
        ['no-such-order-zzz']
      );
      assert.equal(nonsense.length, 0);
    });

    test('a FOOD order detail carries the full ledger', async () => {
      const orderId = await completedFoodOrder();
      const m = await oneAsAdmin('select * from public.admin_order_money($1)', [orderId]);

      assert.equal(Number(m.total_pesewas), JOLLOF + FOOD_FEE + DELIVERY_FEE);
      assert.equal(Number(m.paid_pesewas), JOLLOF + FOOD_FEE + DELIVERY_FEE);
      assert.equal(Number(m.vendor_allocation), JOLLOF, 'the vendor is owed the food');
      assert.equal(Number(m.partner_allocation), DELIVERY_FEE);
      assert.equal(Number(m.platform_allocation), FOOD_FEE);
      assert.equal(m.balances, true);
    });

    test('a SCAN order detail shows no vendor liability at all', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);
      const m = await oneAsAdmin('select * from public.admin_order_money($1)', [orderId]);

      assert.equal(Number(m.total_pesewas), SCAN_FEE + DELIVERY_FEE);
      assert.equal(Number(m.vendor_allocation), 0, 'no vendor row exists to report');
      assert.equal(m.balances, true);

      const s = await oneAsAdmin('select * from public.admin_scan_order($1)', [orderId]);
      assert.equal(s.scan_status, 'UPLOADED');
      assert.equal(s.has_scan_image, true);
      assert.equal(Number(s.service_fee_pesewas), SCAN_FEE);
      assert.equal(Object.hasOwn(s, 'image_path'), false, 'the path is never returned');
    });
  });

  // =========================================================================
  // SCAN IMAGE AUTHORISATION
  // =========================================================================
  describe('scan viewing', () => {
    test('an admin can resolve the scan path; a stranger cannot', async () => {
      const orderId = await scanOrder();

      const asAdminPath = await asAdmin(
        async (c) => (await c.query('select public.scan_image_path($1) p', [orderId])).rows[0].p
      );
      assert.equal(asAdminPath, `${ACTORS.customerAma}/scans/scan-1.jpg`);

      const asOther = await asUser(
        ACTORS.customerKwesi,
        async (c) => (await c.query('select public.scan_image_path($1) p', [orderId])).rows[0].p
      );
      assert.equal(asOther, null, 'another customer gets nothing');

      const asPartner = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select public.scan_image_path($1) p', [orderId])).rows[0].p
      );
      assert.equal(asPartner, null, 'an unassigned Partner gets nothing');
    });

    test('a suspended admin cannot resolve a scan path', async () => {
      const orderId = await scanOrder();
      await asService((c) =>
        c.query('update public.users set is_suspended = true where id = $1', [ACTORS.admin])
      );
      try {
        const path = await asAdmin(
          async (c) => (await c.query('select public.scan_image_path($1) p', [orderId])).rows[0].p
        );
        assert.equal(path, null);
      } finally {
        await asService((c) =>
          c.query('update public.users set is_suspended = false where id = $1', [ACTORS.admin])
        );
      }
    });
  });

  // =========================================================================
  // PEOPLE
  // =========================================================================
  describe('people', () => {
    test('customers are listed with their capabilities, and never a document path', async () => {
      const rows = await rowsAsAdmin('select * from public.admin_customers()');
      assert.ok(rows.length >= 9, 'the seeded students');

      const ama = rows.find((r) => r.user_id === ACTORS.customerAma);
      assert.equal(ama.student_id_number, 'TEST-STU-0021');
      assert.equal(ama.partner_status, 'NOT_APPLIED');
      assert.equal(ama.is_suspended, false);
      assert.equal(Object.hasOwn(ama, 'student_id_image_path'), false);

      const yaw = rows.find((r) => r.user_id === ACTORS.partnerYaw);
      assert.equal(yaw.partner_status, 'APPROVED', 'a Partner is also a customer');
    });

    test('customer search narrows by name, phone and student ID', async () => {
      const byName = await rowsAsAdmin('select * from public.admin_customers($1)', ['Ama']);
      assert.equal(byName.length, 1);
      const byStudentId = await rowsAsAdmin('select * from public.admin_customers($1)', [
        'TEST-STU-0022',
      ]);
      assert.equal(byStudentId.length, 1);
      const none = await rowsAsAdmin('select * from public.admin_customers($1)', ['zzzz']);
      assert.equal(none.length, 0);
    });

    test('customer detail reports document EXISTENCE, not the path', async () => {
      await completedFoodOrder();
      const c = await oneAsAdmin('select * from public.admin_customer_detail($1)', [
        ACTORS.customerAma,
      ]);

      assert.equal(c.full_name, 'Ama Test-Customer');
      assert.equal(c.has_student_id, true);
      assert.equal(Object.hasOwn(c, 'student_id_image_path'), false);
      assert.equal(Number(c.order_count), 1);
      assert.equal(Number(c.completed_count), 1);
      assert.equal(Number(c.spent_pesewas), JOLLOF + FOOD_FEE + DELIVERY_FEE);
      assert.equal(c.recent_orders.length, 1);
    });

    test('partner detail reports activity and money, and no document path', async () => {
      await completedFoodOrder();
      const p = await oneAsAdmin('select * from public.admin_partner_detail($1)', [
        ACTORS.partnerYaw,
      ]);

      assert.equal(p.status, 'APPROVED');
      assert.equal(p.has_face_image, true);
      assert.equal(p.has_student_id, true);
      assert.equal(Object.hasOwn(p, 'face_image_path'), false);
      assert.equal(Number(p.deliveries_completed), 1);
      assert.equal(Number(p.earned_pesewas), DELIVERY_FEE);
      assert.equal(Number(p.owed_pesewas), DELIVERY_FEE, 'earned but not yet settled');
      assert.equal(Number(p.paid_pesewas), 0);
    });

    test('the Partner roster is the whole roster, not only the review queue', async () => {
      const all = await rowsAsAdmin('select * from public.admin_partners()');
      assert.ok(all.length >= 5);
      const pending = await rowsAsAdmin('select * from public.admin_partners($1)', [
        'PENDING_REVIEW',
      ]);
      assert.ok(pending.every((p) => p.status === 'PENDING_REVIEW'));
      assert.ok(pending.length < all.length);
    });

    test('vendors are listed with the operational facts', async () => {
      const rows = await rowsAsAdmin('select * from public.admin_vendors()');
      assert.equal(rows.length, 4);

      const waffle = rows.find((v) => v.vendor_id === VENDORS.wafflemania);
      assert.equal(waffle.can_accept_scans, true);
      const kitchen = rows.find((v) => v.vendor_id === VENDORS.one);
      assert.equal(kitchen.can_accept_scans, false);
      assert.equal(Number(kitchen.staff_count), 1);
      assert.ok(Number(kitchen.menu_count) >= 4);
    });
  });

  // =========================================================================
  // FINANCE
  // =========================================================================
  describe('finance', () => {
    test('the ledger has one row per payee and the three sum to the gross', async () => {
      const orderId = await completedFoodOrder();
      const rows = await rowsAsAdmin('select * from public.admin_ledger()');

      const forOrder = rows.filter((r) => r.order_id === orderId);
      assert.equal(forOrder.length, 3, 'vendor, partner, platform');

      const byPayee = Object.fromEntries(
        forOrder.map((r) => [r.payee_type, Number(r.amount_pesewas)])
      );
      assert.equal(byPayee.VENDOR, JOLLOF);
      assert.equal(byPayee.PARTNER, DELIVERY_FEE);
      assert.equal(byPayee.PLATFORM, FOOD_FEE);
      assert.equal(
        Object.values(byPayee).reduce((a, b) => a + b, 0),
        JOLLOF + FOOD_FEE + DELIVERY_FEE
      );

      assert.equal(forOrder[0].payee_name != null, true, 'payees are named');
    });

    test('a scan order produces exactly two ledger rows, and no vendor row', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);

      const rows = (await rowsAsAdmin('select * from public.admin_ledger($1)', ['SCAN'])).filter(
        (r) => r.order_id === orderId
      );
      assert.equal(rows.length, 1, 'only PLATFORM before a Partner earns anything');
      assert.equal(rows[0].payee_type, 'PLATFORM');
      assert.equal(
        rows.some((r) => r.payee_type === 'VENDOR'),
        false,
        'Campus Dash owes the restaurant nothing for a scan'
      );
      assert.equal(Number(rows[0].order_subtotal_pesewas), 0);
      assert.equal(Number(rows[0].order_service_fee_pesewas), SCAN_FEE);
    });

    test('ledger totals count gross once per order, not once per allocation', async () => {
      await completedFoodOrder();
      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;

      // Three allocation rows, ONE order. A naive sum would report the gross
      // three times.
      assert.equal(Number(t.orders), 1);
      assert.equal(Number(t.gross_pesewas), JOLLOF + FOOD_FEE + DELIVERY_FEE);
      assert.equal(Number(t.vendor_pesewas), JOLLOF);
      assert.equal(Number(t.partner_pesewas), DELIVERY_FEE);
      assert.equal(Number(t.platform_pesewas), FOOD_FEE);
      assert.equal(Number(t.allocated_pesewas), Number(t.gross_pesewas), 'the ledger balances');
    });

    test('totals can be narrowed to one order type', async () => {
      await completedFoodOrder();
      const scanId = await scanOrder();
      await payScan(scanId);

      const scan = (await oneAsAdmin('select public.admin_ledger_totals($1) v', ['SCAN'])).v;
      assert.equal(Number(scan.orders), 1);
      assert.equal(Number(scan.gross_pesewas), SCAN_FEE + DELIVERY_FEE);
      assert.equal(Number(scan.vendor_pesewas), 0);
      // The ledger row still holds both — that is correct and unchanged — but
      // the REPORTED platform revenue is the errand fee alone. The delivery fee
      // is owed to whoever completes the errand and is reported as such.
      assert.equal(Number(scan.platform_pesewas), SCAN_FEE, 'errand fee only, before delivery');
      assert.equal(Number(scan.delivery_fees_held_pesewas), DELIVERY_FEE, 'held for a Partner');
      assert.equal(
        Number(scan.platform_allocated_pesewas),
        SCAN_FEE + DELIVERY_FEE,
        'the underlying allocation row is untouched'
      );

      const food = (await oneAsAdmin('select public.admin_ledger_totals($1) v', ['FOOD'])).v;
      assert.equal(Number(food.vendor_pesewas), JOLLOF);
    });

    test('ledger filters by payee', async () => {
      await completedFoodOrder();
      const partnerRows = await rowsAsAdmin('select * from public.admin_ledger(null, $1)', [
        'PARTNER',
      ]);
      assert.ok(partnerRows.length >= 1);
      assert.ok(partnerRows.every((r) => r.payee_type === 'PARTNER'));
    });

    test('payments are visible with their provider state', async () => {
      await completedFoodOrder();
      const rows = await rowsAsAdmin('select * from public.admin_payments(100)');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'SUCCEEDED');
      assert.equal(Number(rows[0].amount_pesewas), JOLLOF + FOOD_FEE + DELIVERY_FEE);
    });

    test('pending settlement shows who is owed', async () => {
      await completedFoodOrder();
      const vendorOwed = await rowsAsAdmin(
        "select * from public.admin_pending_settlement('VENDOR')"
      );
      assert.equal(vendorOwed.length, 1);
      assert.equal(Number(vendorOwed[0].owed_pesewas), JOLLOF);

      const partnerOwed = await rowsAsAdmin(
        "select * from public.admin_pending_settlement('PARTNER')"
      );
      assert.equal(Number(partnerOwed[0].owed_pesewas), DELIVERY_FEE);
    });
  });

  // =========================================================================
  // PLATFORM REVENUE — what is ours, and what we are merely holding
  // =========================================================================
  /**
   * THE LEDGER IS RIGHT; THE LABEL WAS WRONG.
   *
   * At payment time no Partner exists, so `create_order_allocations` puts
   * everything that is not the food on the PLATFORM row — service fee AND
   * delivery fee — and `settle_partner_earnings` carves the Partner's share out
   * of it on delivery. Two rows that always sum to the total.
   *
   * The console then reported that whole row as "Platform earned / Service
   * fees", which on a paid but undelivered order overstates platform revenue by
   * the entire delivery fee. These tests hold the reporting to the truth
   * WITHOUT changing a single allocation.
   */
  describe('platform revenue is not the platform allocation', () => {
    /** A paid FOOD order that has NOT been delivered: still searching. */
    async function paidUndeliveredOrder() {
      const order = await submitOrder({
        items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
        destination: LOCATIONS.room204,
      });
      await vendorAccept(order.order_id);
      await payOrder(order.order_id);
      await vendorPrepare(order.order_id);
      await vendorReady(order.order_id);
      return order.order_id;
    }

    test('a paid, undelivered order earns the platform the service fee ONLY', async () => {
      const orderId = await paidUndeliveredOrder();

      const d = (await oneAsAdmin('select public.admin_dashboard() v')).v;
      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;

      assert.equal(
        Number(d.money.platform_earned),
        FOOD_FEE,
        'the delivery fee is not ours until somebody delivers'
      );
      assert.equal(Number(t.platform_pesewas), FOOD_FEE);
      assert.equal(Number(t.platform_service_fee_pesewas), FOOD_FEE);
      assert.equal(
        Number(t.platform_delivery_margin_pesewas),
        0,
        'nothing retained: no Partner has been settled'
      );

      // And the ledger itself is untouched — the PLATFORM row still carries
      // both, exactly as create_order_allocations wrote it.
      const alloc = await asService(
        async (c) =>
          (
            await c.query(
              "select amount_pesewas from public.allocations where order_id = $1 and payee_type = 'PLATFORM'",
              [orderId]
            )
          ).rows[0]
      );
      assert.equal(
        Number(alloc.amount_pesewas),
        FOOD_FEE + DELIVERY_FEE,
        'the ledger semantics did not change'
      );
    });

    test('the undelivered delivery fee is separately identifiable as a Partner liability', async () => {
      await paidUndeliveredOrder();

      const d = (await oneAsAdmin('select public.admin_dashboard() v')).v;
      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;

      assert.equal(Number(d.money.delivery_fees_held), DELIVERY_FEE);
      assert.equal(Number(t.delivery_fees_held_pesewas), DELIVERY_FEE);

      // It is NOT double-counted as something already owed to a named Partner:
      // there is no PARTNER allocation yet, so partner_owed is still zero.
      assert.equal(
        Number(d.money.partner_owed),
        0,
        'held is not the same as allocated to a person'
      );
    });

    test('after delivery the delivery fee becomes the Partner entitlement, and platform revenue does not move', async () => {
      const orderId = await paidUndeliveredOrder();

      const before = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;
      assert.equal(Number(before.platform_pesewas), FOOD_FEE);
      assert.equal(Number(before.delivery_fees_held_pesewas), DELIVERY_FEE);

      await partnerAccept(orderId);
      await completeDelivery(orderId);

      const after = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;
      const d = (await oneAsAdmin('select public.admin_dashboard() v')).v;

      assert.equal(
        Number(after.platform_pesewas),
        FOOD_FEE,
        'settling a Partner does not change what the platform earned'
      );
      assert.equal(
        Number(after.partner_pesewas),
        DELIVERY_FEE,
        'the delivery fee is now allocated to the person who walked it'
      );
      assert.equal(Number(after.delivery_fees_held_pesewas), 0, 'nothing is being held any more');
      assert.equal(Number(d.money.platform_earned), FOOD_FEE);
      assert.equal(Number(d.money.delivery_fees_held), 0);
      assert.equal(Number(d.money.partner_owed), DELIVERY_FEE);
    });

    test('the three parts always sum back to the raw platform allocation', async () => {
      // One order in flight and one delivered, so both branches contribute.
      await paidUndeliveredOrder();
      await completedFoodOrder();

      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;

      assert.equal(
        Number(t.platform_service_fee_pesewas) +
          Number(t.platform_delivery_margin_pesewas) +
          Number(t.delivery_fees_held_pesewas),
        Number(t.platform_allocated_pesewas),
        'the split is a partition of the allocation, not a new number'
      );
      assert.equal(
        Number(t.platform_pesewas),
        Number(t.platform_service_fee_pesewas) + Number(t.platform_delivery_margin_pesewas),
        'revenue is the two earned parts'
      );
    });

    test('the existing ledger totals still balance against gross', async () => {
      await paidUndeliveredOrder();
      await completedFoodOrder();
      const scanId = await scanOrder();
      await payScan(scanId);

      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;

      assert.equal(Number(t.orders), 3);
      assert.equal(
        Number(t.allocated_pesewas),
        Number(t.gross_pesewas),
        'allocated = gross, exactly as before'
      );
      assert.equal(
        Number(t.vendor_pesewas) + Number(t.partner_pesewas) + Number(t.platform_allocated_pesewas),
        Number(t.allocated_pesewas),
        'the three payees still account for every cedi'
      );
      // Two food orders' fees, one scan errand fee.
      assert.equal(Number(t.platform_service_fee_pesewas), FOOD_FEE * 2 + SCAN_FEE);
      // Two undelivered deliveries: one food in flight, one scan searching.
      assert.equal(Number(t.delivery_fees_held_pesewas), DELIVERY_FEE * 2);
    });

    test('the platform keeps its margin when the Partner share is less than the whole fee', async () => {
      // The pilot runs at 100%, so the margin is normally zero. Prove the
      // reporting is arithmetic rather than an assumption about the config.
      await asService((c) =>
        c.query('update public.pricing_config set partner_share_of_delivery_bps = 6000 where id')
      );
      const partnerShare = (DELIVERY_FEE * 6000) / 10000; // 300
      const margin = DELIVERY_FEE - partnerShare; // 200

      const orderId = await paidUndeliveredOrder();

      const before = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;
      assert.equal(
        Number(before.platform_pesewas),
        FOOD_FEE,
        'unearned until the delivery resolves, margin included'
      );
      assert.equal(Number(before.delivery_fees_held_pesewas), DELIVERY_FEE);

      await partnerAccept(orderId);
      await completeDelivery(orderId);

      const after = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;
      assert.equal(Number(after.partner_pesewas), partnerShare);
      assert.equal(Number(after.platform_delivery_margin_pesewas), margin);
      assert.equal(Number(after.platform_pesewas), FOOD_FEE + margin);
      assert.equal(Number(after.delivery_fees_held_pesewas), 0);
      assert.equal(Number(after.allocated_pesewas), Number(after.gross_pesewas), 'still balances');
    });

    test('a pickup order holds no delivery money at all', async () => {
      const order = await submitOrder({
        items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
        fulfilment: 'PICKUP',
      });
      await vendorAccept(order.order_id);
      await payOrder(order.order_id);

      const t = (await oneAsAdmin('select public.admin_ledger_totals() v')).v;
      assert.equal(Number(t.platform_pesewas), FOOD_FEE);
      assert.equal(Number(t.delivery_fees_held_pesewas), 0, 'there is no delivery to owe for');
      assert.equal(Number(t.platform_allocated_pesewas), FOOD_FEE);
    });

    test('a non-admin still gets null, split or not', async () => {
      const row = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select public.admin_ledger_totals() v')).rows[0]
      );
      assert.equal(row.v, null);
    });
  });

  // =========================================================================
  // EXCEPTIONS
  // =========================================================================
  describe('the exceptions queue', () => {
    test('a clean system has an empty queue', async () => {
      const rows = await rowsAsAdmin('select * from public.admin_exceptions()');
      assert.deepEqual(rows, []);
    });

    test('a refused scan appears, and is flagged as needing a decision', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);
      await partnerAccept(orderId);
      await asUser(
        ACTORS.partnerYaw,
        (c) =>
          c.query('select * from public.partner_report_scan_refused($1, $2)', [
            orderId,
            'the counter said it was already used',
          ]),
        { commit: true }
      );

      const rows = await rowsAsAdmin('select * from public.admin_exceptions()');
      const refused = rows.find((r) => r.kind === 'SCAN_REFUSED');

      assert.ok(refused, 'a refused scan is an exception');
      assert.equal(refused.order_id, orderId);
      assert.equal(refused.requires_decision, true, 'no policy exists — a person decides');
      assert.match(refused.detail, /No refund policy exists/i);
      assert.equal(Number(refused.amount_pesewas), SCAN_FEE + DELIVERY_FEE);
    });

    test('a refused scan is classified SCAN_REFUSED on the board, not IN_PROGRESS', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);
      await partnerAccept(orderId);
      await asUser(
        ACTORS.partnerYaw,
        (c) => c.query('select * from public.partner_report_scan_refused($1, $2)', [orderId, 'no']),
        { commit: true }
      );

      const rows = await rowsAsAdmin('select * from public.admin_order_board()');
      const order = rows.find((r) => r.order_id === orderId);
      assert.equal(order.attention, 'SCAN_REFUSED');
      assert.equal(order.scan_status, 'REFUSED');
    });

    test('an order with no Partner appears but does not claim to need a money decision', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);
      await asService((c) =>
        c.query(
          "update public.orders set search_deadline_at = now() - interval '1 minute' where id = $1",
          [orderId]
        )
      );
      await asService((c) => c.query('select public.expire_partner_search()'));

      const rows = await rowsAsAdmin('select * from public.admin_exceptions()');
      const noPartner = rows.find((r) => r.kind === 'NO_PARTNER');
      assert.ok(noPartner);
      assert.equal(noPartner.requires_decision, false, 'the existing flow handles this one');
    });
  });

  // =========================================================================
  // CONFIGURATION
  // =========================================================================
  describe('configuration', () => {
    test('the scan fee and the food fee move independently', async () => {
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query(
            'select * from public.admin_update_config($1, $2, null, null, null, null, null, null, null, null, null, null, null, $3)',
            ['testing the split', 900, 250]
          ),
        { commit: true }
      );

      const cfg = await asService(
        async (c) => (await c.query('select * from public.pricing_config')).rows[0]
      );
      assert.equal(cfg.service_fee_bps, 900, 'food fee changed');
      assert.equal(Number(cfg.scan_service_fee_pesewas), 250, 'scan fee changed');

      // And changing only the food fee leaves the scan fee alone.
      await asUser(
        ACTORS.admin,
        (c) => c.query('select * from public.admin_update_config($1, $2)', ['food only', 500]),
        { commit: true }
      );
      const after = await asService(
        async (c) => (await c.query('select * from public.pricing_config')).rows[0]
      );
      assert.equal(after.service_fee_bps, 500);
      assert.equal(Number(after.scan_service_fee_pesewas), 250, 'the scan fee did not follow');
    });

    test('a config change is audited with who, what and why', async () => {
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query(
            'select * from public.admin_update_config($1, null, null, null, null, null, null, null, null, null, null, null, null, $2)',
            ['pilot pricing review', 300]
          ),
        { commit: true }
      );

      const actions = await rowsAsAdmin('select * from public.admin_list_actions(10)');
      const entry = actions.find((a) => a.action === 'CONFIG_UPDATE');
      assert.ok(entry, 'the change is on the record');
      assert.equal(entry.reason, 'pilot pricing review');
      assert.equal(entry.admin_user_id, ACTORS.admin, 'the actor is recorded');
    });

    test('changing the scan fee does not touch an order already placed', async () => {
      const orderId = await scanOrder();
      await payScan(orderId);

      await asUser(
        ACTORS.admin,
        (c) =>
          c.query(
            'select * from public.admin_update_config($1, null, null, null, null, null, null, null, null, null, null, null, null, $2)',
            ['raising the errand fee', 900]
          ),
        { commit: true }
      );

      const order = await asService(
        async (c) => (await c.query('select * from public.orders where id = $1', [orderId])).rows[0]
      );
      assert.equal(
        Number(order.service_fee_pesewas),
        SCAN_FEE,
        'the order keeps the price it was quoted'
      );
      assert.equal(Number(order.total_pesewas), SCAN_FEE + DELIVERY_FEE);
    });

    test('a non-admin cannot change configuration', async () => {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.admin_update_config($1, $2)', ['nope', 1])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });
  });

  // =========================================================================
  // VENDOR MANAGEMENT
  // =========================================================================
  describe('vendor management', () => {
    test('scan acceptance is toggled through the audited admin function', async () => {
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_set_vendor_scans($1, true, $2)', [
            VENDORS.one,
            'confirmed with the manager',
          ]),
        { commit: true }
      );

      const v = await asService(
        async (c) =>
          (
            await c.query('select can_accept_scans from public.vendors where id = $1', [
              VENDORS.one,
            ])
          ).rows[0]
      );
      assert.equal(v.can_accept_scans, true);

      const actions = await rowsAsAdmin('select * from public.admin_list_actions(10)');
      const entry = actions.find((a) => a.action === 'VENDOR_SCANS_SET');
      assert.ok(entry);
      assert.equal(entry.reason, 'confirmed with the manager');
    });

    test('a customer cannot enable scans on a vendor', async () => {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.admin_set_vendor_scans($1, true, $2)', [
            VENDORS.one,
            'let me',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });
  });

  // =========================================================================
  // ACCOUNT SUSPENSION
  // =========================================================================
  /**
   * SUSPENSION IS OF THE PERSON, NOT OF A ROLE.
   *
   * `users.is_suspended` is the one column is_admin(), is_customer(),
   * is_approved_partner() and my_vendor_ids() all consult, so suspending an
   * account removes every capability it holds at once. That is a property worth
   * testing rather than assuming: it is exactly the kind of thing that decays
   * when a new capability is added and forgets to check the column.
   */
  describe('account suspension', () => {
    const suspend = (userId, reason = 'under investigation') =>
      asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_set_user_suspended($1, true, $2)', [userId, reason]),
        { commit: true }
      );

    const reinstate = (userId, reason = 'investigation closed') =>
      asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_set_user_suspended($1, false, $2)', [userId, reason]),
        { commit: true }
      );

    // The suite shares one database, and this block flips a column no other
    // block resets. Put every account back however the test ended.
    const RESET = [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.admin, ACTORS.vendor1Staff];
    afterEach(async () => {
      await asService((c) =>
        c.query('update public.users set is_suspended = false where id = any($1::uuid[])', [RESET])
      );
      await asService((c) =>
        c.query('update public.partner_profiles set is_available = true where user_id = $1', [
          ACTORS.partnerYaw,
        ])
      );
    });

    test('suspending a customer removes the CUSTOMER capability', async () => {
      assert.equal(
        await asService(
          async (c) =>
            (await c.query('select public.is_customer($1) v', [ACTORS.customerAma])).rows[0].v
        ),
        true,
        'they hold it to begin with'
      );

      await suspend(ACTORS.customerAma);

      assert.equal(
        await asService(
          async (c) =>
            (await c.query('select public.is_customer($1) v', [ACTORS.customerAma])).rows[0].v
        ),
        false,
        'the capability is gone'
      );
    });

    test('a suspended customer cannot use the capability', async () => {
      await suspend(ACTORS.customerAma);

      const error = await expectRejection(
        submitOrder({
          items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
          destination: LOCATIONS.room204,
        })
      );
      assert.match(error.message, /suspended/i);
    });

    test('suspending a Partner removes the PARTNER capability and takes them offline', async () => {
      await suspend(ACTORS.partnerYaw);

      const row = await asService(
        async (c) =>
          (
            await c.query(
              `select public.is_approved_partner($1) as approved,
                      (select is_available from public.partner_profiles where user_id = $1) as available`,
              [ACTORS.partnerYaw]
            )
          ).rows[0]
      );
      assert.equal(row.approved, false, 'no longer an approved Partner');
      assert.equal(row.available, false, 'and no longer in the offer pool');
    });

    test('a suspended Partner cannot accept a delivery', async () => {
      const { order_id: orderId } = await orderReadyForDispatch({
        destination: LOCATIONS.room204,
      });
      await suspend(ACTORS.partnerYaw);

      const error = await expectRejection(partnerAccept(orderId, ACTORS.partnerYaw));
      assert.match(error.message, /partner|suspend|approved/i);
    });

    test('the application status is untouched — suspension is not a rejection', async () => {
      await suspend(ACTORS.partnerYaw);
      const status = await asService(
        async (c) =>
          (
            await c.query('select status from public.partner_profiles where user_id = $1', [
              ACTORS.partnerYaw,
            ])
          ).rows[0].status
      );
      assert.equal(status, 'APPROVED', 'they are still an approved Partner, just a suspended one');
    });

    test('reinstating returns every capability', async () => {
      await suspend(ACTORS.partnerYaw);
      await reinstate(ACTORS.partnerYaw);

      const row = await asService(
        async (c) =>
          (
            await c.query(
              'select public.is_customer($1) as customer, public.is_approved_partner($1) as partner',
              [ACTORS.partnerYaw]
            )
          ).rows[0]
      );
      assert.equal(row.customer, true, 'PARTNER implies CUSTOMER, and both are back');
      assert.equal(row.partner, true);
    });

    test("going back online after reinstatement is the Partner's own decision", async () => {
      await suspend(ACTORS.partnerYaw);
      await reinstate(ACTORS.partnerYaw);

      const available = await asService(
        async (c) =>
          (
            await c.query('select is_available from public.partner_profiles where user_id = $1', [
              ACTORS.partnerYaw,
            ])
          ).rows[0].is_available
      );
      assert.equal(available, false, 'reinstatement does not put somebody back in the offer pool');
    });

    test('a customer cannot suspend anybody', async () => {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.admin_set_user_suspended($1, true, $2)', [
            ACTORS.partnerYaw,
            'because I said so',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });

    test('a Partner cannot suspend anybody', async () => {
      const error = await expectRejection(
        asUser(ACTORS.partnerYaw, (c) =>
          c.query('select * from public.admin_set_user_suspended($1, true, $2)', [
            ACTORS.customerAma,
            'rival',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });

    test('a customer cannot un-suspend themselves', async () => {
      await suspend(ACTORS.customerAma);
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.admin_set_user_suspended($1, false, $2)', [
            ACTORS.customerAma,
            'let me back in',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });

    test('anon cannot reach the function at all', async () => {
      const error = await expectRejection(
        asAnon((c) =>
          c.query('select * from public.admin_set_user_suspended($1, true, $2)', [
            ACTORS.customerAma,
            'hello',
          ])
        )
      );
      assert.match(error.message, /permission denied|does not exist/i);
    });

    test('a reason is required, and a blank one is not a reason', async () => {
      for (const reason of ['', '   ', 'no']) {
        const error = await expectRejection(suspend(ACTORS.customerAma, reason));
        assert.match(error.message, /reason is required/i, `accepted ${JSON.stringify(reason)}`);
      }
      const still = await asService(
        async (c) =>
          (
            await c.query('select is_suspended from public.users where id = $1', [
              ACTORS.customerAma,
            ])
          ).rows[0].is_suspended
      );
      assert.equal(still, false, 'a refused call changes nothing');
    });

    test('the direction must be stated, not inferred', async () => {
      const error = await expectRejection(
        asUser(ACTORS.admin, (c) =>
          c.query('select * from public.admin_set_user_suspended($1, null, $2)', [
            ACTORS.customerAma,
            'not sure which way',
          ])
        )
      );
      assert.match(error.message, /stated explicitly/i);
    });

    test('suspending an account that does not exist is refused', async () => {
      const error = await expectRejection(suspend('00000000-0000-4000-8000-0000000000ff', 'ghost'));
      assert.match(error.message, /no such user/i);
    });

    // ---- SELF-SUSPENSION ---------------------------------------------------
    /**
     * is_admin() is `is_admin and not is_suspended`. An administrator who
     * suspends their own account therefore destroys, in one statement, the
     * authority required to undo it — and if they are the only administrator,
     * the console is unreachable until somebody opens a SQL client against
     * production. The database refuses it; the hidden button is a courtesy.
     */
    test('an administrator cannot suspend their own account', async () => {
      const error = await expectRejection(suspend(ACTORS.admin, 'locking myself out'));
      assert.match(error.message, /cannot suspend your own account/i);

      const row = await asService(
        async (c) =>
          (
            await c.query(
              'select is_suspended, public.is_admin() from public.users where id = $1',
              [ACTORS.admin]
            )
          ).rows[0]
      );
      assert.equal(row.is_suspended, false, 'the admin is still active');
    });

    test('the self-suspension refusal is server-side, not a disabled button', async () => {
      // Called DIRECTLY against the database, exactly as a hostile client
      // bypassing the screen would.
      const error = await expectRejection(
        asUser(ACTORS.admin, (c) =>
          c.query(
            `select * from public.admin_set_user_suspended(
               (select id from public.users where is_admin and id = $1), true, $2)`,
            [ACTORS.admin, 'straight at the function']
          )
        )
      );
      assert.match(error.message, /cannot suspend your own account/i);
    });

    test('one administrator may suspend ANOTHER administrator', async () => {
      // Not the same hazard: the target keeps a colleague who can undo it, and
      // "this administrator has gone rogue" is a real thing to need to express.
      await asService((c) =>
        c.query('update public.users set is_admin = true where id = $1', [ACTORS.customerKwesi])
      );
      try {
        await suspend(ACTORS.customerKwesi, 'shared their password');
        const row = await asService(
          async (c) =>
            (
              await c.query('select is_suspended from public.users where id = $1', [
                ACTORS.customerKwesi,
              ])
            ).rows[0]
        );
        assert.equal(row.is_suspended, true);
      } finally {
        await asService((c) =>
          c.query('update public.users set is_admin = false, is_suspended = false where id = $1', [
            ACTORS.customerKwesi,
          ])
        );
      }
    });

    test('a suspended administrator has no admin authority, and cannot suspend anyone', async () => {
      // The rule the console already relies on, restated against the new
      // function so it cannot be the one write path that forgot.
      await asService((c) =>
        c.query('update public.users set is_suspended = true where id = $1', [ACTORS.admin])
      );
      try {
        const error = await expectRejection(
          asUser(ACTORS.admin, (c) =>
            c.query('select * from public.admin_set_user_suspended($1, true, $2)', [
              ACTORS.customerAma,
              'still in charge, surely',
            ])
          )
        );
        assert.match(error.message, /admin privileges required/i);
      } finally {
        await asService((c) =>
          c.query('update public.users set is_suspended = false where id = $1', [ACTORS.admin])
        );
      }
    });

    // ---- AUDIT -------------------------------------------------------------
    test('suspension is audited with actor, target, reason and before/after', async () => {
      await suspend(ACTORS.customerAma, 'repeated chargebacks');

      const actions = await rowsAsAdmin('select * from public.admin_list_actions(20)');
      const entry = actions.find((a) => a.action === 'USER_SUSPENDED');

      assert.ok(entry, 'the suspension is on the record');
      assert.equal(entry.target_type, 'user');
      assert.equal(entry.target_id, ACTORS.customerAma);
      assert.equal(entry.admin_user_id, ACTORS.admin);
      assert.equal(entry.reason, 'repeated chargebacks');
      assert.equal(entry.before_state.is_suspended, false);
      assert.equal(entry.after_state.is_suspended, true);
    });

    test('reinstatement is audited too, under its own action name', async () => {
      await suspend(ACTORS.customerAma, 'pending review');
      await reinstate(ACTORS.customerAma, 'nothing to answer');

      const actions = await rowsAsAdmin('select * from public.admin_list_actions(20)');
      const entry = actions.find((a) => a.action === 'USER_UNSUSPENDED');

      assert.ok(entry, 'a reinstatement is as auditable as a suspension');
      assert.equal(entry.reason, 'nothing to answer');
      assert.equal(entry.before_state.is_suspended, true);
      assert.equal(entry.after_state.is_suspended, false);
    });

    test('the dashboard counts suspended accounts', async () => {
      const before = (await oneAsAdmin('select public.admin_dashboard() v')).v;
      await suspend(ACTORS.customerAma);
      const after = (await oneAsAdmin('select public.admin_dashboard() v')).v;
      assert.equal(Number(after.people.suspended), Number(before.people.suspended) + 1);
    });
  });

  // =========================================================================
  // IDOR AND MALFORMED INPUT
  // =========================================================================
  describe('hostile input', () => {
    test('a customer cannot read another customer through the admin detail view', async () => {
      const rows = await asUser(
        ACTORS.customerKwesi,
        async (c) =>
          (await c.query('select * from public.admin_customer_detail($1)', [ACTORS.customerAma]))
            .rows
      );
      assert.equal(rows.length, 0, 'not an admin, so not a row');
    });

    test('a Partner cannot read another Partner through the admin detail view', async () => {
      const rows = await asUser(
        ACTORS.partnerAdjoa,
        async (c) =>
          (await c.query('select * from public.admin_partner_detail($1)', [ACTORS.partnerYaw])).rows
      );
      assert.equal(rows.length, 0);
    });

    test('an id that belongs to nobody returns nothing rather than erroring', async () => {
      const missing = '00000000-0000-4000-8000-0000000000ff';
      assert.equal(
        (await rowsAsAdmin('select * from public.admin_customer_detail($1)', [missing])).length,
        0
      );
      assert.equal(
        (await rowsAsAdmin('select * from public.admin_partner_detail($1)', [missing])).length,
        0
      );
      assert.equal(
        (await rowsAsAdmin('select * from public.admin_scan_order($1)', [missing])).length,
        0
      );
      assert.equal(
        (await rowsAsAdmin('select * from public.admin_order_money($1)', [missing])).length,
        0
      );
    });

    test('a malformed id is refused by the type system, not by a string check', async () => {
      const error = await expectRejection(
        rowsAsAdmin('select * from public.admin_customer_detail($1)', ['not-a-uuid'])
      );
      assert.match(error.message, /invalid input syntax for type uuid/i);
    });

    test('a filter value the database does not recognise cannot inject', async () => {
      // The filters are compared as text against enum casts; a hostile value
      // simply matches nothing.
      const rows = await rowsAsAdmin('select * from public.admin_order_board(null,100,$1)', [
        "FOOD'; drop table public.orders; --",
      ]);
      assert.deepEqual(rows, []);

      const stillThere = await asService(
        async (c) => (await c.query('select count(*)::int n from public.orders')).rows[0].n
      );
      assert.equal(typeof stillThere, 'number', 'orders still exists');
    });

    test('the board limit is capped regardless of what is asked for', async () => {
      const rows = await rowsAsAdmin('select * from public.admin_order_board(null, $1)', [100000]);
      assert.ok(rows.length <= 500);
    });
  });

  // =========================================================================
  // THE ORDER BOARD'S FILTER VOCABULARY
  // =========================================================================
  /**
   * `?attention=` is validated in app/admin/orders/page.js against a list, and
   * the list it was validated against was ATTENTION — which is a SUPERSET.
   * ATTENTION also carries FAILED_PAYOUT and RECONCILIATION so that the
   * exceptions queue can label its other two sources, and neither is a state an
   * order can be in.
   *
   * The failure mode is quiet, which is why it is worth a test: passing one of
   * them to admin_order_board() matches no row, so the board renders an empty
   * table that reads exactly like "no orders need this". A filter that appears
   * to have worked and did not.
   */
  describe('order board attention values', () => {
    const ORDER_BOARD_VALUES = [
      'DISPUTED',
      'SCAN_REFUSED',
      'CUSTOMER_ABSENT',
      'NO_PARTNER',
      'REFUND_PENDING',
      'PAYMENT_FAILED',
      'AWAITING_VENDOR',
      'AWAITING_PAYMENT',
      'SEARCHING_PARTNER',
      'IN_PROGRESS',
      'DONE',
      'CLOSED',
    ];
    const NOT_ORDER_BOARD_VALUES = ['FAILED_PAYOUT', 'RECONCILIATION'];

    test('the UI vocabulary matches the database exactly', async () => {
      const ui = await import('node:fs').then(({ readFileSync }) =>
        readFileSync(new URL('../app/admin/ui.js', import.meta.url), 'utf8')
      );

      const block = ui.match(/export const ORDER_BOARD_ATTENTION = \{([\s\S]*?)\n\};/)?.[1];
      assert.ok(block, 'ORDER_BOARD_ATTENTION is the constant the page must validate against');

      const keys = [...block.matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]);
      assert.deepEqual(
        [...keys].sort(),
        [...ORDER_BOARD_VALUES].sort(),
        'ORDER_BOARD_ATTENTION has drifted from admin_order_board()'
      );

      for (const value of NOT_ORDER_BOARD_VALUES) {
        assert.ok(
          !keys.includes(value),
          `${value} is an exceptions-queue kind, never an order-board filter`
        );
      }
    });

    test('the orders page validates against the narrow list, not the superset', async () => {
      const page = await import('node:fs').then(({ readFileSync }) =>
        readFileSync(new URL('../app/admin/orders/page.js', import.meta.url), 'utf8')
      );
      assert.match(
        page,
        /attention:\s*pick\(params\.attention,\s*Object\.keys\(ORDER_BOARD_ATTENTION\)\)/,
        'the ?attention= filter must be validated against ORDER_BOARD_ATTENTION'
      );
    });

    test('every value the board actually produces is in the list', async () => {
      // Real orders across several states, so this is not a reading of the SQL
      // but of its output.
      await completedFoodOrder();
      const searching = await scanOrder();
      await payScan(searching);
      const submitted = await submitOrder({
        items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
        destination: LOCATIONS.room204,
      });
      assert.ok(submitted.order_id);

      const rows = await rowsAsAdmin('select * from public.admin_order_board(null, 500)');
      assert.ok(rows.length >= 3);
      for (const row of rows) {
        assert.ok(
          ORDER_BOARD_VALUES.includes(row.attention),
          `the board produced ${row.attention}, which no filter list knows about`
        );
      }
    });

    test('each order-board value is a filter the database understands', async () => {
      // Not that each returns rows — most will not — but that none of them
      // errors, so the whole vocabulary is genuinely filterable.
      for (const value of ORDER_BOARD_VALUES) {
        const rows = await rowsAsAdmin('select * from public.admin_order_board($1)', [value]);
        assert.ok(Array.isArray(rows), `${value} is not a usable filter`);
      }
    });

    test('an exceptions-queue kind matches nothing on the board, which is why it must be rejected earlier', async () => {
      await completedFoodOrder();
      for (const value of NOT_ORDER_BOARD_VALUES) {
        const rows = await rowsAsAdmin('select * from public.admin_order_board($1)', [value]);
        assert.deepEqual(
          rows,
          [],
          `${value} silently returns an empty board — it must never reach the RPC`
        );
      }
    });

    test('the summary only ever reports order-board values', async () => {
      await completedFoodOrder();
      const rows = await rowsAsAdmin('select * from public.admin_order_board_summary()');
      for (const row of rows) {
        assert.ok(ORDER_BOARD_VALUES.includes(row.attention), `summary reported ${row.attention}`);
      }
    });
  });

  // =========================================================================
  // THE CONSOLE'S OWN FAILURE MODES
  // =========================================================================
  /**
   * Source-level, because these are properties of the SCREENS rather than of
   * the database, and the screens are JSX that this runner cannot execute.
   * Reading the source is a weaker check than rendering it, and it is still
   * enough to catch the two regressions that actually happen: a boundary file
   * quietly deleted, and a destructive control losing its confirmation.
   */
  describe('console safety rails', () => {
    const read = async (relative) =>
      import('node:fs').then(({ readFileSync }) =>
        readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
      );

    const exists = async (relative) =>
      import('node:fs').then(({ existsSync }) =>
        existsSync(new URL(`../${relative}`, import.meta.url))
      );

    test('the admin routes have a loading boundary', async () => {
      assert.ok(await exists('app/admin/loading.js'), 'app/admin/loading.js is missing');
    });

    test('the admin routes have an error boundary, and it is a client component', async () => {
      assert.ok(await exists('app/admin/error.js'), 'app/admin/error.js is missing');
      const source = await read('app/admin/error.js');
      assert.match(source, /^'use client';/, 'an error boundary must be a client component');
      assert.match(source, /reset/, 'it must offer a way to retry');
    });

    test('the error boundary shows the digest and nothing else from the error', async () => {
      const source = await read('app/admin/error.js');
      // The digest is an opaque id Next.js also writes to the server log. The
      // message and the stack are database text — table names, constraint
      // names, sometimes a value — and must not reach a screen.
      assert.match(source, /error\?\.digest/, 'the digest is the reference an operator quotes');
      assert.ok(
        !/\{\s*error\.message\s*\}|\{\s*error\?\.message\s*\}/.test(source),
        'the error message must not be rendered'
      );
      assert.ok(!/error\.stack/.test(source), 'the stack must never be rendered');
    });

    test('the pages that had no fetch handling now render Unavailable instead of throwing', async () => {
      for (const page of [
        'app/admin/settlements/page.js',
        'app/admin/audit/page.js',
        'app/admin/locations/page.js',
        'app/admin/money/page.js',
        'app/admin/vendors/[id]/page.js',
      ]) {
        const source = await read(page);
        assert.match(source, /Unavailable/, `${page} does not distinguish failure from emptiness`);
      }
    });

    test('every destructive action is behind a confirmation', async () => {
      // The mechanism matters as much as the presence: ConfirmButton renders a
      // type="button" until it is armed, so there is no state in which one
      // click performs the action.
      const confirm = await read('app/admin/confirm.js');
      assert.match(confirm, /type="button"/, 'the unarmed control must not be a submit control');

      for (const [page, action] of [
        ['app/admin/vendors/[id]/menu-forms.js', 'deleteMenuItemAction'],
        ['app/admin/locations/location-forms.js', 'deleteLocationAction'],
        ['app/admin/partners/[userId]/purge-documents-form.js', 'purgePartnerDocumentsAction'],
        ['app/admin/account-suspension.js', 'setUserSuspendedAction'],
      ]) {
        const source = await read(page);
        assert.match(source, new RegExp(action), `${page} no longer calls ${action}`);
        assert.match(source, /ConfirmButton/, `${action} lost its confirmation`);
        // The confirmation is IN ADDITION to the audited reason, never instead
        // of it.
        assert.match(source, /name="reason"/, `${action} lost its mandatory reason field`);
      }
    });
  });

  // =========================================================================
  // AUDIT
  // =========================================================================
  describe('audit', () => {
    test('administrative changes are recorded with actor, action, target and reason', async () => {
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_set_vendor_status($1, $2, $3)', [
            VENDORS.one,
            'SUSPENDED',
            'hygiene complaint',
          ]),
        { commit: true }
      );

      const actions = await rowsAsAdmin('select * from public.admin_list_actions(20)');
      // The action name carries the new status, so the log reads as a sentence:
      // VENDOR_STATUS_SUSPENDED, not a generic "updated".
      const entry = actions.find((a) => a.action === 'VENDOR_STATUS_SUSPENDED');
      assert.ok(entry, 'the suspension is on the record');
      assert.equal(entry.target_type, 'vendor');
      assert.equal(entry.target_id, VENDORS.one);
      assert.equal(entry.admin_user_id, ACTORS.admin);
      assert.equal(entry.reason, 'hygiene complaint');
      assert.ok(entry.created_at);
      // The before/after states are captured so a change can be explained later.
      assert.equal(entry.before_state.status, 'ACTIVE');
      assert.equal(entry.after_state.status, 'SUSPENDED');
    });

    test('the audit log is not readable by a non-admin', async () => {
      const rows = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.admin_list_actions(10)')).rows
      );
      assert.equal(rows.length, 0);
    });
  });
});
