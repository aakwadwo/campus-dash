import { test, describe, before, beforeEach, after } from 'node:test';
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
  SCAN_MENU,
} from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * Meal scans.
 *
 * A SCAN IS A WAY OF PAYING, NOT A DIFFERENT PRODUCT. A student holds a prepaid
 * campus meal entitlement; the store honours it at the counter; Campus Dash
 * charges a fee for putting the order through and, if asked, for a Partner to
 * carry it. Everything below defends one of four claims:
 *
 *   1. THE STORE IS THE REDEMPTION POINT. A paid scan order is on the board
 *      with a normal queue number, carries real items, and the STORE is the
 *      party that verifies the scan before anything leaves the counter.
 *   2. THE MONEY. The scan's face value never enters our ledger. The store is
 *      owed nothing BY US, the Partner is paid for carrying and not for the
 *      meal, and the platform's revenue is the fee.
 *   3. THE SCAN IS PRIVATE, and its readers are exactly the customer, the
 *      CURRENTLY assigned Partner, the store WHILE THE ORDER IS LIVE, and an
 *      admin. Nobody else, at any point, by any route.
 *   4. VERIFYING IS NOT HANDING OVER. Checking the scan and giving somebody
 *      their lunch are separate acts, and the four-digit code still proves the
 *      second one.
 */
describe('meal scans', () => {
  // The agreed commercial terms. Written out rather than read from config on
  // purpose: a test that reads the number it is checking proves only that the
  // code is self-consistent, not that the price is right.
  const SCAN_FEE = 200; // GH₵2.00 FLAT, every scan order, whatever is in it
  const PACK_FEE = 400; // GH₵4.00 — a choice on a collection, compulsory with a Partner
  const PARTNER_FEE = 500; // GH₵5.00
  const SERVICE_BPS = 695; // 6.95%, and it belongs to FOOD orders only

  // Chicken Waffle, GH₵38.00 — scan-eligible at Wafflemania in the seed.
  const WAFFLE = 3800;

  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(`
        update public.pricing_config
           set delivery_fee_pesewas = 500, partner_share_of_delivery_bps = 10000,
               scan_service_fee_pesewas = 200, scan_pack_fee_pesewas = 400,
               partner_search_seconds = 600, service_fee_bps = 695,
               partner_delivery_enabled = true
         where id
      `)
    );
    // The seed marks these scan-capable; a previous test may have flipped them.
    await asService((c) =>
      c.query(`update public.vendors set can_accept_scans = (id = any($1::uuid[]))`, [
        [VENDORS.wafflemania, VENDORS.yellowBar],
      ])
    );
    await asService((c) =>
      c.query(`update public.menu_items set scan_eligible = (id = any($1::uuid[]))`, [
        [SCAN_MENU.waffle, SCAN_MENU.tilapia],
      ])
    );
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  // A path shaped exactly like the one the upload route produces.
  const scanPath = (customer = ACTORS.customerAma) => `${customer}/scans/scan-1.jpg`;

  const itemsFor = (vendorId) =>
    vendorId === VENDORS.yellowBar
      ? [{ menu_item_id: SCAN_MENU.tilapia, quantity: 1 }]
      : [{ menu_item_id: SCAN_MENU.waffle, quantity: 1 }];

  /** Creates a scan order the way the application does. */
  async function submitScan({
    customer = ACTORS.customerAma,
    vendorId = VENDORS.wafflemania,
    fulfilment = 'DELIVERY',
    destination = LOCATIONS.room204,
    items = null,
    path = null,
    details = null,
    wantsPack = false,
  } = {}) {
    return asUser(
      customer,
      async (c) =>
        (
          await c.query(
            `select * from public.submit_scan_order(
               $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              vendorId,
              JSON.stringify(items ?? itemsFor(vendorId)),
              fulfilment,
              path ?? scanPath(customer),
              'image/jpeg',
              120000,
              fulfilment === 'DELIVERY' ? destination : null,
              details,
              null,
              wantsPack,
            ]
          )
        ).rows[0],
      { commit: true }
    );
  }

  function quoteScan({
    customer = ACTORS.customerAma,
    vendorId = VENDORS.wafflemania,
    fulfilment = 'DELIVERY',
    destination = LOCATIONS.room204,
    items = null,
    wantsPack = false,
  } = {}) {
    return asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.quote_scan_order($1, $2::jsonb, $3, $4, $5)', [
            vendorId,
            JSON.stringify(items ?? itemsFor(vendorId)),
            fulfilment,
            fulfilment === 'DELIVERY' ? destination : null,
            wantsPack,
          ])
        ).rows[0]
    );
  }

  /** Pays a scan order through the real intent → confirm path. */
  async function payScan(orderId) {
    return asService(async (c) => {
      const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        orderId,
        `scan:${orderId}`,
      ]);
      const payment = rows[0];
      await c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        `txn_${orderId}`,
        payment.amount_pesewas,
      ]);
      return payment;
    });
  }

  const getOrder = (orderId) =>
    asService(
      async (c) => (await c.query('select * from public.orders where id = $1', [orderId])).rows[0]
    );

  const allocationsFor = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select payee_type, payee_id, amount_pesewas, status from public.allocations where order_id = $1 order by payee_type',
            [orderId]
          )
        ).rows
    );

  async function acceptAs(partner, orderId) {
    return asUser(
      partner,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [orderId])).rows[0],
      { commit: true }
    );
  }

  /** The store checks the scan. Wafflemania's owner in the seed staffs it. */
  async function redeemAs(staff, orderId) {
    return asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_redeem_scan($1)', [orderId])).rows[0],
      { commit: true }
    );
  }

  /** The store says the Meal Scan is not valid. Irreversible, and it cancels. */
  async function refuseAs(staff, orderId, reason) {
    return asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_refuse_scan($1, $2)', [orderId, reason]))
          .rows[0],
      { commit: true }
    );
  }

  async function markReadyAs(staff, orderId) {
    return asUser(
      staff,
      async (c) => (await c.query('select * from public.vendor_mark_ready($1)', [orderId])).rows[0],
      { commit: true }
    );
  }

  const pickupCode = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query('select pickup_code from public.order_secrets where order_id = $1', [
            orderId,
          ])
        ).rows[0].pickup_code
    );

  const deliveryCode = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query('select delivery_code from public.order_secrets where order_id = $1', [
            orderId,
          ])
        ).rows[0].delivery_code
    );

  // =========================================================================
  // PRICING — three shapes, and a flat fee under all of them
  // =========================================================================
  // GH₵2 collection, GH₵6 collection with a pack, GH₵11 with a Partner. The
  // service fee does not move, and a percentage never appears anywhere in this
  // section: the scanned value is the STORE'S price for food Campus Dash did
  // not sell, and charging a share of it would be a commission on a transaction
  // between the student and the university.
  describe('pricing', () => {
    test('a collection with no pack is the flat fee and nothing else', async () => {
      const quote = await quoteScan({ fulfilment: 'PICKUP', wantsPack: false });

      assert.equal(Number(quote.subtotal_pesewas), 0, 'Campus Dash sells no food here');
      assert.equal(Number(quote.scanned_value_pesewas), WAFFLE, 'what the scan is being spent on');
      assert.equal(Number(quote.service_fee_pesewas), SCAN_FEE, 'GH₵2.00 flat');
      assert.equal(Number(quote.pack_fee_pesewas), 0, 'they are bringing their own container');
      assert.equal(Number(quote.delivery_fee_pesewas), 0, 'nobody is carrying it');
      assert.equal(Number(quote.total_pesewas), 200, 'GH₵2.00');
      assert.equal(quote.pack_is_compulsory, false, 'and the screen may offer the choice');
    });

    test('a collection that asks for a pack pays for one', async () => {
      const quote = await quoteScan({ fulfilment: 'PICKUP', wantsPack: true });

      assert.equal(Number(quote.service_fee_pesewas), SCAN_FEE, 'the fee did not move');
      assert.equal(Number(quote.pack_fee_pesewas), PACK_FEE);
      assert.equal(Number(quote.total_pesewas), 600, 'GH₵6.00');
    });

    test('a Partner order is the flat fee, a compulsory pack and the Partner fee', async () => {
      const quote = await quoteScan({ fulfilment: 'DELIVERY' });

      assert.equal(Number(quote.subtotal_pesewas), 0);
      assert.equal(Number(quote.scanned_value_pesewas), WAFFLE);
      assert.equal(Number(quote.service_fee_pesewas), SCAN_FEE, 'still GH₵2.00, still flat');
      assert.equal(Number(quote.pack_fee_pesewas), PACK_FEE);
      assert.equal(Number(quote.delivery_fee_pesewas), PARTNER_FEE);
      assert.equal(Number(quote.total_pesewas), 1100, 'GH₵11.00');
      assert.equal(quote.pack_is_compulsory, true, 'so no screen offers a no-pack option');
    });

    /**
     * THE PACK CANNOT BE DECLINED WITH A PARTNER, and asking anyway is the
     * interesting case. A checkbox that is never rendered is not a control that
     * cannot be operated — anybody can post the field — so the refusal has to
     * be in the pricing function rather than in the markup.
     */
    test('a Partner order is charged for a pack however loudly it says no', async () => {
      for (const wantsPack of [false, true, null]) {
        const quote = await quoteScan({ fulfilment: 'DELIVERY', wantsPack });
        assert.equal(
          Number(quote.pack_fee_pesewas),
          PACK_FEE,
          `wants_pack=${wantsPack} is overruled`
        );
        assert.equal(Number(quote.total_pesewas), 1100);
      }
    });

    test('the pack a customer declined is not smuggled back at submission', async () => {
      const order = await submitScan({ fulfilment: 'PICKUP', wantsPack: false });
      const row = await getOrder(order.order_id);
      assert.equal(Number(row.pack_fee_pesewas), 0);
      assert.equal(Number(row.total_pesewas), 200);
    });

    test('and the pack a Partner order needs is charged at submission too', async () => {
      const order = await submitScan({ fulfilment: 'DELIVERY', wantsPack: false });
      const row = await getOrder(order.order_id);
      assert.equal(Number(row.pack_fee_pesewas), PACK_FEE);
      assert.equal(Number(row.total_pesewas), 1100);
    });

    test('the pack fee is a setting, not a number in a function', async () => {
      await asService((c) =>
        c.query('update public.pricing_config set scan_pack_fee_pesewas = 750 where id')
      );
      const quote = await quoteScan({ fulfilment: 'PICKUP', wantsPack: true });
      assert.equal(Number(quote.pack_fee_pesewas), 750);
      assert.equal(Number(quote.total_pesewas), SCAN_FEE + 750);
    });

    /**
     * THE TWO PRICING SYSTEMS DO NOT MEET. service_fee_bps is the food rate; a
     * scan order must not read it at all, on either fulfilment. Setting it to
     * something absurd is the cheapest way to prove that.
     */
    test('the scan fee is FLAT — it does not move with the food percentage', async () => {
      await asService((c) =>
        c.query('update public.pricing_config set service_fee_bps = 5000 where id')
      );
      for (const fulfilment of ['PICKUP', 'DELIVERY']) {
        const quote = await quoteScan({ fulfilment });
        assert.equal(
          Number(quote.service_fee_pesewas),
          SCAN_FEE,
          `${fulfilment} pays a flat amount, never a percentage`
        );
      }
    });

    test('and it does not move with the value of the meal either', async () => {
      // Two waffles is twice the scanned value. A percentage would double; a
      // flat fee is the same errand and the same GH₵2.00.
      const one = await quoteScan({ fulfilment: 'PICKUP' });
      const two = await quoteScan({
        fulfilment: 'PICKUP',
        items: [{ menu_item_id: SCAN_MENU.waffle, quantity: 2 }],
      });

      assert.equal(Number(two.scanned_value_pesewas), WAFFLE * 2, 'the scan covers twice as much');
      assert.equal(Number(one.service_fee_pesewas), SCAN_FEE);
      assert.equal(Number(two.service_fee_pesewas), SCAN_FEE, 'and the fee did not follow it');
    });

    test('a FOOD order still pays the configured percentage of its own subtotal', async () => {
      const { rows } = await asUser(
        ACTORS.customerAma,
        async (c) =>
          c.query('select * from public.quote_order($1, $2::jsonb)', [
            VENDORS.one,
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
          ]),
        { commit: false }
      );
      const quote = rows[0];

      // Jollof is GH₵35.00 and Campus Dash really does sell it, so the subtotal
      // is real — which is the whole difference from a scan order.
      assert.equal(Number(quote.subtotal_pesewas), 3500);
      assert.equal(Number(quote.service_fee_pesewas), Math.round((3500 * SERVICE_BPS) / 10000));
      assert.equal(Number(quote.total_pesewas), 3500 + Number(quote.service_fee_pesewas));
    });

    test('an unconfigured scan fee refuses to price rather than assuming zero', async () => {
      await asService((c) =>
        c.query('update public.pricing_config set scan_service_fee_pesewas = null where id')
      );
      const error = await expectRejection(quoteScan({ fulfilment: 'PICKUP' }));
      assert.match(error.message, /not configured/i);
    });

    test('a store that does not take scans cannot be quoted or ordered from', async () => {
      const error = await expectRejection(
        quoteScan({ vendorId: VENDORS.two, items: [{ menu_item_id: MENU.shawarma, quantity: 1 }] })
      );
      assert.match(error.message, /not accepting meal scans/i);

      const refused = await expectRejection(
        submitScan({
          vendorId: VENDORS.two,
          items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
        })
      );
      assert.match(refused.message, /not accepting meal scans/i);
    });

    /**
     * ELIGIBILITY IS PER ITEM. The store opts in, and then chooses what it will
     * honour a scan for. A screen that only offered eligible items is a
     * convenience; this is the enforcement, and it is what stops somebody
     * arriving at a counter with a scan for an imported drink.
     */
    test('an item the store does not take a scan for is refused', async () => {
      const error = await expectRejection(
        quoteScan({ items: [{ menu_item_id: SCAN_MENU.iceCream, quantity: 1 }] })
      );
      assert.match(error.message, /cannot be paid for with a meal scan/i);
    });

    /**
     * THE CHECKOUT READS THE ORDINARY MENU NOW. There is no scan_menu(): a
     * Meal Scan is a switch on the store's own checkout, so the storefront
     * read carries scan_eligible and the screen marks the lines the store will
     * not honour one for. price_scan_order() is still the enforcement.
     */
    test('marking an item ineligible stops it being paid for with a Meal Scan', async () => {
      await asService((c) =>
        c.query('update public.menu_items set scan_eligible = false where id = $1', [
          SCAN_MENU.waffle,
        ])
      );

      const menu = await asAnon(
        async (c) =>
          (
            await c.query('select id, scan_eligible from public.menu_items where vendor_id = $1', [
              VENDORS.wafflemania,
            ])
          ).rows
      );
      assert.equal(
        menu.find((item) => item.id === SCAN_MENU.waffle)?.scan_eligible,
        false,
        'the storefront read says so, so the checkout can mark it'
      );

      const error = await expectRejection(quoteScan());
      assert.match(error.message, /cannot be paid for with a meal scan/i);
    });

    test('a Partner order still needs somewhere to bring it', async () => {
      const error = await expectRejection(quoteScan({ fulfilment: 'DELIVERY', destination: null }));
      assert.match(error.message, /where the Partner should bring it/i);
    });

    test('a non-deliverable destination is refused', async () => {
      const error = await expectRejection(submitScan({ destination: LOCATIONS.floor2 }));
      assert.match(error.message, /not a place a Partner can bring an order to/i);
    });

    /**
     * Turning Partner delivery off must not take the whole scan feature with
     * it. A collection asks nothing of a Partner, so it is still orderable.
     */
    test('with Partners switched off a collection still prices and a Partner order does not', async () => {
      await asService((c) =>
        c.query('update public.pricing_config set partner_delivery_enabled = false where id')
      );

      const quote = await quoteScan({ fulfilment: 'PICKUP', wantsPack: true });
      assert.equal(Number(quote.total_pesewas), SCAN_FEE + PACK_FEE);
      assert.equal(quote.partner_available, false, 'and the screen is told why');

      const error = await expectRejection(quoteScan({ fulfilment: 'DELIVERY' }));
      assert.match(error.message, /no Partners are available/i);
    });

    /**
     * A MEAL SCAN IS NOT A PLACE TO GO. The separate catalogue is gone: a
     * customer browses the one list of stores, and a store that takes a Meal
     * Scan says so on its own page. can_accept_scans is what the storefront
     * reads, and an administrator is the only one who sets it.
     */
    test('the browsing mode is gone, and the store flag is what is left', async () => {
      const listed = await asService(
        async (c) =>
          (
            await c.query(
              `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('scan_restaurants', 'scan_menu')`
            )
          ).rows
      );
      assert.deepEqual(listed, [], 'no scan catalogue, no scan menu');

      const storefront = await asAnon(
        async (c) =>
          (await c.query('select * from public.storefront_vendor($1)', [VENDORS.wafflemania]))
            .rows[0]
      );
      assert.equal(storefront.can_accept_scans, true, 'the store page says Meal Scan accepted');

      const ordinary = await asAnon(
        async (c) =>
          (await c.query('select * from public.storefront_vendor($1)', [VENDORS.one])).rows[0]
      );
      assert.equal(ordinary.can_accept_scans, false, 'and an ordinary store does not');
    });
  });

  // =========================================================================
  // THE LIFECYCLE — a store order that happens to be paid for with a scan
  // =========================================================================
  describe('the successful scan order', () => {
    test('collection: pay → store verifies → ready → customer types the code', async () => {
      const submitted = await submitScan({ fulfilment: 'PICKUP', wantsPack: true });
      const orderId = submitted.order_id;

      // A QUEUE NUMBER, like every other order. This is the whole of
      // requirement 21: nobody is asked to read a CD- reference at a counter.
      assert.ok(submitted.vendor_order_no >= 1, 'a scan order takes a daily queue number');

      let order = await getOrder(orderId);
      assert.equal(order.order_type, 'SCAN');
      assert.equal(order.fulfilment_type, 'PICKUP');
      assert.equal(Number(order.subtotal_pesewas), 0);
      assert.equal(order.scan_status, 'UPLOADED');
      assert.equal(order.order_status, 'ACCEPTED', 'priced and payable');
      assert.equal(order.delivery_status, 'NONE');
      assert.ok(order.vendor_order_no, 'and it is stored on the order');

      // THE ITEMS ARE REAL, so the counter knows what to hand over.
      const items = await asService(
        async (c) =>
          (await c.query('select * from public.order_items where order_id = $1', [orderId])).rows
      );
      assert.equal(items.length, 1);
      assert.equal(Number(items[0].line_total_pesewas), WAFFLE);

      await payScan(orderId);

      order = await getOrder(orderId);
      assert.equal(order.payment_status, 'PAID');
      assert.equal(order.order_status, 'PREPARING', 'a paid scan order reaches the store');
      assert.equal(order.delivery_status, 'NONE', 'nobody is carrying a collection');

      // READY IS REFUSED UNTIL THE SCAN IS CHECKED. Nothing should be boxed
      // against an entitlement nobody has looked at.
      const early = await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(early.success, false);
      assert.match(early.reason, /check the meal scan/i);

      const redeemed = await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(redeemed.success, true);
      assert.equal((await getOrder(orderId)).scan_status, 'REDEEMED');

      const ready = await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(ready.success, true);

      order = await getOrder(orderId);
      assert.equal(order.order_status, 'READY');

      // THE STORE HOLDS THE CODE AND READS IT OUT; the customer types it in.
      const done = await asUser(
        ACTORS.customerAma,
        async (c) =>
          (
            await c.query('select * from public.customer_complete_pickup($1, $2)', [
              orderId,
              await pickupCode(orderId),
            ])
          ).rows[0],
        { commit: true }
      );
      assert.equal(done.success, true);
      assert.equal((await getOrder(orderId)).order_status, 'COMPLETED');

      // THE LEDGER. The university's system settles the food; the PACK is the
      // store's, and Campus Dash keeps the flat fee.
      const settled = await allocationsFor(orderId);
      const byPayee = Object.fromEntries(
        settled.map((a) => [a.payee_type, Number(a.amount_pesewas)])
      );
      assert.equal(byPayee.VENDOR, PACK_FEE, 'the pack they asked for is the store’s money');
      assert.equal(byPayee.PLATFORM, SCAN_FEE, 'GH₵2.00: the flat fee, and nothing else');
      assert.equal(byPayee.PARTNER, undefined, 'nobody carried it');
      assert.equal(
        settled.reduce((sum, a) => sum + Number(a.amount_pesewas), 0),
        SCAN_FEE + PACK_FEE,
        'GH₵6.00, every pesewa of it allocated once'
      );
    });

    for (const [label, vendorId, staff] of [
      ['Wafflemania', VENDORS.wafflemania, ACTORS.wafflemaniaStaff],
      ['Yellow Bar', VENDORS.yellowBar, ACTORS.yellowBarStaff],
    ]) {
      test(`${label}, with a Partner: pay → verify → ready → collect → deliver`, async () => {
        const submitted = await submitScan({ vendorId });
        const orderId = submitted.order_id;
        assert.ok(submitted.vendor_order_no >= 1);

        // GH₵11.00, AND THE SAME AT BOTH STORES. A tilapia costs more than a
        // waffle and the fee is identical, which is the flat rate doing its job.
        const total = SCAN_FEE + PACK_FEE + PARTNER_FEE;
        assert.equal(total, 1100);

        let order = await getOrder(orderId);
        assert.equal(order.fulfilment_type, 'DELIVERY');
        assert.equal(Number(order.total_pesewas), total);

        await payScan(orderId);

        order = await getOrder(orderId);
        assert.equal(order.order_status, 'PREPARING', 'the store has it');
        assert.equal(
          order.delivery_status,
          'NONE',
          'and NOBODY is being looked for yet — the store checks the scan first'
        );

        // AT PAYMENT: the pack to the store, everything else held by the
        // platform until a Partner earns their part of it.
        const paid = Object.fromEntries(
          (await allocationsFor(orderId)).map((a) => [a.payee_type, Number(a.amount_pesewas)])
        );
        assert.deepEqual(paid, { VENDOR: PACK_FEE, PLATFORM: SCAN_FEE + PARTNER_FEE });

        // THE STORE VERIFIES, not the Partner — and approving is what opens
        // the search.
        assert.equal((await redeemAs(staff, orderId)).success, true);
        order = await getOrder(orderId);
        assert.equal(order.scan_status, 'REDEEMED');
        assert.equal(order.delivery_status, 'SEARCHING', 'approval opened dispatch');

        const accepted = await acceptAs(ACTORS.partnerYaw, orderId);
        assert.equal(accepted.success, true);

        order = await getOrder(orderId);
        assert.equal(order.delivery_status, 'ASSIGNED');
        assert.equal(order.scan_status, 'REDEEMED', 'and the Partner changed nothing about it');

        assert.equal((await markReadyAs(staff, orderId)).success, true);

        // THE SAME FOUR DIGITS EVERY ORDER USES. The store reads them out; the
        // Partner types them in.
        const collected = await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            (
              await c.query('select * from public.partner_confirm_pickup($1, $2)', [
                orderId,
                await pickupCode(orderId),
              ])
            ).rows[0],
          { commit: true }
        );
        assert.equal(collected.success, true);
        assert.equal((await getOrder(orderId)).delivery_status, 'PICKED_UP');

        const done = await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            (
              await c.query('select * from public.partner_complete_delivery($1, $2)', [
                orderId,
                await deliveryCode(orderId),
              ])
            ).rows[0],
          { commit: true }
        );
        assert.equal(done.success, true);

        order = await getOrder(orderId);
        assert.equal(order.delivery_status, 'DELIVERED');
        assert.equal(order.order_status, 'COMPLETED');

        const settled = await allocationsFor(orderId);
        const byPayee = Object.fromEntries(
          settled.map((a) => [a.payee_type, Number(a.amount_pesewas)])
        );
        assert.equal(byPayee.PARTNER, PARTNER_FEE, 'the Partner earns the carry, not the meal');
        assert.equal(byPayee.PLATFORM, SCAN_FEE, 'GH₵2.00 of the GH₵11.00: the flat fee');
        assert.equal(byPayee.VENDOR, PACK_FEE, 'GH₵4.00: the pack is the store’s');
        assert.equal(
          settled.reduce((sum, a) => sum + Number(a.amount_pesewas), 0),
          total,
          'the ledger balances against what the customer actually paid'
        );
      });
    }
  });

  // =========================================================================
  // THE STORE SEES IT — the correction this model exists for
  // =========================================================================
  describe('the store', () => {
    test('a paid scan order is on the board, with its queue number and items', async () => {
      const { order_id: orderId, vendor_order_no: queueNo } = await submitScan();
      await payScan(orderId);

      const board = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select * from public.vendor_order_board($1, 20)', [VENDORS.wafflemania]))
            .rows
      );

      const row = board.find((r) => r.order_id === orderId);
      assert.ok(row, 'the store can see the scan order it is expected to honour');
      assert.equal(row.order_type, 'SCAN');
      assert.equal(row.vendor_order_no, queueNo, 'and it is numbered like everything else');
      assert.equal(Number(row.item_count), 1);
      assert.equal(row.scan_status, 'UPLOADED');
      assert.equal(row.bucket, 'NEW');
    });

    test('an UNPAID scan order is not', async () => {
      const { order_id: orderId } = await submitScan();

      const board = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select * from public.vendor_order_board($1, 20)', [VENDORS.wafflemania]))
            .rows
      );
      assert.equal(
        board.some((r) => r.order_id === orderId),
        false,
        'a store is never shown an order nobody has paid for'
      );
    });

    test('the store is paid the pack by Campus Dash, and the board says a pack goes with it', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const row = await asUser(ACTORS.wafflemaniaStaff, async (c) =>
        (
          await c.query('select * from public.vendor_order_board($1, 20)', [VENDORS.wafflemania])
        ).rows.find((r) => r.order_id === orderId)
      );

      assert.equal(Number(row.vendor_amount_pesewas), PACK_FEE, 'the pack, and not the meal');
      assert.equal(row.pack_included, true, 'a Partner order always carries a pack');
      assert.equal(
        Number(row.scan_value_pesewas),
        WAFFLE,
        'but what the scan is worth at their own prices is shown'
      );
    });

    /**
     * THE EXTRA EXPOSURE IS THE SCAN AND THE ITEMS, AND NOTHING ELSE.
     *
     * Putting a scan order on the board necessarily shows a store more than it
     * saw before. This is the test that says how much more: not the
     * destination, not the customer's phone number, not what Campus Dash
     * charged. A store hands food across a counter; where it goes afterwards is
     * the Partner's business and the customer's.
     */
    test('the store is never shown the destination, the phone number or the total', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      const detail = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select * from public.vendor_order_detail($1)', [orderId])).rows[0]
      );

      assert.ok(detail, 'the store can open it');
      const columns = Object.keys(detail);
      for (const forbidden of [
        'destination',
        'destination_zone',
        'destination_note',
        'destination_location_id',
        'customer_phone',
        'partner_phone',
        'total_pesewas',
        'service_fee_pesewas',
        'delivery_fee_pesewas',
        'pack_fee_pesewas',
      ]) {
        assert.equal(
          columns.includes(forbidden),
          false,
          `${forbidden} must not be returned to a store`
        );
      }
    });

    test('the store can read the scan while the order is live, and not afterwards', async () => {
      const { order_id: orderId } = await submitScan({ fulfilment: 'PICKUP' });

      const pathAsStore = () =>
        asUser(
          ACTORS.wafflemaniaStaff,
          async (c) =>
            (await c.query('select public.vendor_scan_image_path($1) as p', [orderId])).rows[0].p
        );

      assert.equal(await pathAsStore(), null, 'not before it is paid for');

      await payScan(orderId);
      assert.equal(await pathAsStore(), scanPath(), 'yes once it is on their board');

      await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      await asUser(
        ACTORS.customerAma,
        async (c) =>
          c.query('select * from public.customer_complete_pickup($1, $2)', [
            orderId,
            await pickupCode(orderId),
          ]),
        { commit: true }
      );

      assert.equal(
        await pathAsStore(),
        null,
        'and the right closes when the order leaves the board'
      );
    });

    test('another store cannot read it at any point', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const path = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (await c.query('select public.vendor_scan_image_path($1) as p', [orderId])).rows[0].p
      );
      assert.equal(path, null);
    });

    test('a store cannot redeem a scan belonging to another store', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const error = await expectRejection(redeemAs(ACTORS.vendor1Staff, orderId));
      assert.match(error.message, /not authorised/i);
    });

    test('a scan cannot be redeemed twice', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      assert.equal((await redeemAs(ACTORS.wafflemaniaStaff, orderId)).success, true);
      const second = await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(second.success, false, 'the second attempt matches zero rows');
      assert.match(second.reason, /already been dealt with/i);
    });

    test('a refused scan stops the order and moves no money', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      const before = await allocationsFor(orderId);

      const refused = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (
            await c.query('select * from public.vendor_refuse_scan($1, $2)', [
              orderId,
              'Already used today',
            ])
          ).rows[0],
        { commit: true }
      );
      assert.equal(refused.success, true);

      const order = await getOrder(orderId);
      assert.equal(order.scan_status, 'REFUSED');
      assert.equal(order.payment_status, 'PAID', 'nothing is refunded automatically');
      assert.deepEqual(await allocationsFor(orderId), before, 'the ledger is untouched');

      const reason = await asService(
        async (c) =>
          (
            await c.query('select refusal_reason from public.order_scans where order_id = $1', [
              orderId,
            ])
          ).rows[0].refusal_reason
      );
      assert.equal(reason, 'Already used today');
    });

    test('a refused scan cannot then be redeemed, and cannot be marked ready', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await asUser(
        ACTORS.wafflemaniaStaff,
        (c) => c.query('select * from public.vendor_refuse_scan($1, $2)', [orderId, 'no']),
        { commit: true }
      );

      assert.equal((await redeemAs(ACTORS.wafflemaniaStaff, orderId)).success, false);
      const ready = await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(ready.success, false);
      assert.match(ready.reason, /check the meal scan/i);
    });

    /**
     * AN INVALID MEAL SCAN ENDS THE ORDER, and that is the change.
     *
     * It used to set scan_status = REFUSED and stop there, leaving the order
     * PREPARING — a state where the store had said it would not honour the
     * entitlement and could still press Ready on the food, and where a Partner
     * already carrying it went on carrying it.
     */
    test('marking it invalid cancels the order outright', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const refused = await refuseAs(ACTORS.wafflemaniaStaff, orderId, 'Already used today');
      assert.equal(refused.success, true);

      const order = await getOrder(orderId);
      assert.equal(order.scan_status, 'REFUSED');
      assert.equal(order.order_status, 'CANCELLED_BY_VENDOR', 'there is nothing left to prepare');
      assert.ok(order.cancelled_at);
      assert.match(order.cancellation_reason, /could not accept this Meal Scan/i);
      assert.equal(order.delivery_status, 'NONE', 'and nobody is being sent');
    });

    test('nothing can be done with the order afterwards', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await refuseAs(ACTORS.wafflemaniaStaff, orderId, 'blurred');

      const ready = await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(ready.success, false, 'the store cannot mark it ready');

      const redeemed = await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(redeemed.success, false, 'and cannot change its mind');

      const accepted = await acceptAs(ACTORS.partnerYaw, orderId);
      assert.equal(accepted.success, false, 'and no Partner can take it');

      assert.equal((await getOrder(orderId)).order_status, 'CANCELLED_BY_VENDOR');
    });

    /**
     * NO SECOND SCAN ON A PAID ORDER. That would be a second entitlement
     * against one payment, and there is deliberately no function for it: the
     * row is keyed on the order and nobody but the service role may write it.
     */
    test('the customer cannot attach another Meal Scan to the same order', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await refuseAs(ACTORS.wafflemaniaStaff, orderId, 'not readable');

      const writes = [
        [
          'update public.order_scans set image_path = $2 where order_id = $1',
          [orderId, `${ACTORS.customerAma}/scans/second.jpg`],
        ],
        [
          `insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size)
             values ($1, $2, $3, 'image/jpeg', 100)`,
          [orderId, ACTORS.customerAma, `${ACTORS.customerAma}/scans/second.jpg`],
        ],
      ];

      for (const [sql, params] of writes) {
        const error = await expectRejection(
          asUser(ACTORS.customerAma, (c) => c.query(sql, params))
        );
        assert.match(error.message, /permission denied/i, sql);
      }

      // And there is no RPC that would do it for them.
      const functions = await asService(
        async (c) =>
          (
            await c.query(
              `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and (p.proname ilike '%replace%scan%' or p.proname ilike '%scan%replace%'
                       or p.proname ilike '%retry%scan%' or p.proname ilike '%reupload%')`
            )
          ).rows
      );
      assert.deepEqual(functions, [], 'no replace-the-scan path exists');
    });

    test('the store must say why, and a blank reason changes nothing', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      for (const reason of ['', '   ', null]) {
        const result = await refuseAs(ACTORS.wafflemaniaStaff, orderId, reason);
        assert.equal(result.success, false);
        assert.match(result.reason, /say why/i);
      }

      const order = await getOrder(orderId);
      assert.equal(order.scan_status, 'UPLOADED', 'the scan is untouched');
      assert.equal(order.order_status, 'PREPARING', 'and so is the order');
    });

    test('a scan already approved cannot then be marked invalid', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await redeemAs(ACTORS.wafflemaniaStaff, orderId);

      const late = await refuseAs(ACTORS.wafflemaniaStaff, orderId, 'changed my mind');
      assert.equal(late.success, false);
      assert.equal((await getOrder(orderId)).scan_status, 'REDEEMED');
      assert.equal((await getOrder(orderId)).order_status, 'PREPARING');
    });

    test('another store cannot mark somebody else’s Meal Scan invalid', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select * from public.vendor_refuse_scan($1, $2)', [orderId, 'mine now'])
        )
      );
      assert.match(error.message, /not authorised/i);
      assert.equal((await getOrder(orderId)).scan_status, 'UPLOADED');
    });

    /**
     * THE PIPELINE THE CUSTOMER READS. Every one of these comes from
     * customer_order_stage(), which now sees the order type and the scan too —
     * without them a paid Meal Scan read "Being prepared" through the whole
     * verification wait, and a refused one read "Cancelled".
     */
    test('the customer’s stage follows the Meal Scan through', async () => {
      const { order_id: orderId } = await submitScan();

      const stageOf = (id) =>
        asUser(
          ACTORS.customerAma,
          async (c) =>
            (await c.query('select * from public.customer_order_detail($1)', [id])).rows[0].stage
        );

      assert.equal(await stageOf(orderId), 'PAYMENT_REQUIRED', '1. submitted, not yet paid');

      await payScan(orderId);
      assert.equal(await stageOf(orderId), 'SCAN_AWAITING_CHECK', '2-3. paid, awaiting the store');

      await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(
        await stageOf(orderId),
        'PREPARING_SEARCHING',
        '4-6. approved, being made, and a Partner is being found'
      );

      await acceptAs(ACTORS.partnerYaw, orderId);
      assert.equal(await stageOf(orderId), 'PREPARING_PARTNER_ASSIGNED');

      await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      assert.equal(await stageOf(orderId), 'PARTNER_ASSIGNED', '7-8. ready, Partner collecting');
    });

    test('an invalid Meal Scan reads as itself, not as a cancellation', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await refuseAs(ACTORS.wafflemaniaStaff, orderId, 'Already used today');

      const view = await asUser(
        ACTORS.customerAma,
        async (c) =>
          (await c.query('select * from public.customer_order_detail($1)', [orderId])).rows[0]
      );
      assert.equal(view.stage, 'SCAN_INVALID');
      assert.match(view.cancellation_reason, /Meal Scan/i);
      // THE WAY BACK. The screen offers "Order again" at this store, so the id
      // has to be on the customer's own order.
      assert.equal(view.vendor_id, VENDORS.wafflemania);

      const listed = await asUser(ACTORS.customerAma, async (c) =>
        (await c.query('select * from public.customer_order_list(30)')).rows.find(
          (r) => r.order_id === orderId
        )
      );
      assert.equal(listed.stage, 'SCAN_INVALID', 'and the history says the same thing');
    });

    test('refusing without a reason is refused', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const result = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select * from public.vendor_refuse_scan($1, $2)', [orderId, '  ']))
            .rows[0],
        { commit: true }
      );
      assert.equal(result.success, false);
      assert.match(result.reason, /say why/i);
    });

    test('a scan order counts in the store’s pending count like any other', async () => {
      const before = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select public.vendor_pending_count($1) as n', [VENDORS.wafflemania]))
            .rows[0].n
      );

      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const after = await asUser(
        ACTORS.wafflemaniaStaff,
        async (c) =>
          (await c.query('select public.vendor_pending_count($1) as n', [VENDORS.wafflemania]))
            .rows[0].n
      );
      assert.equal(Number(after), Number(before) + 1);
    });
  });

  // =========================================================================
  // THE ECONOMICS, stated as money rather than as ratios
  // =========================================================================
  describe('scan economics', () => {
    test('a provider fee cannot be deducted from anyone’s entitlement', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      // APPROVAL FIRST, always: it is what opens the search.
      await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);
      await markReadyAs(ACTORS.wafflemaniaStaff, orderId);
      await asUser(
        ACTORS.partnerYaw,
        async (c) =>
          c.query('select * from public.partner_confirm_pickup($1, $2)', [
            orderId,
            await pickupCode(orderId),
          ]),
        { commit: true }
      );
      await asUser(
        ACTORS.partnerYaw,
        async (c) =>
          c.query('select * from public.partner_complete_delivery($1, $2)', [
            orderId,
            await deliveryCode(orderId),
          ]),
        { commit: true }
      );

      const byPayee = Object.fromEntries(
        (await allocationsFor(orderId)).map((a) => [a.payee_type, Number(a.amount_pesewas)])
      );
      // The Partner's GH₵5.00 is exact. There is no fee column anywhere in the
      // schema, so a processing cost has nowhere to land but the platform.
      assert.equal(byPayee.PARTNER, PARTNER_FEE);
    });

    test('a customer cannot tamper with the fees on their own scan order', async () => {
      const { order_id: orderId } = await submitScan();
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('update public.orders set service_fee_pesewas = 0 where id = $1', [orderId])
        )
      );
      assert.match(error.message, /permission denied/i);
    });

    test('a scan order can never carry food value, even if one is forced in', async () => {
      const { order_id: orderId } = await submitScan();
      const error = await expectRejection(
        asService((c) =>
          c.query('update public.orders set subtotal_pesewas = 1000 where id = $1', [orderId])
        )
      );
      // Two constraints stand in the way, and either is a correct refusal:
      // orders_scan_has_no_food_value says a scan order has no subtotal at all,
      // and orders_total_is_sum says the parts must add up to the whole.
      assert.match(error.message, /orders_scan_has_no_food_value|orders_total_is_sum/i);
    });

    test('a pack fee cannot leak onto a FOOD order', async () => {
      const constraint = await asService(
        async (c) =>
          (
            await c.query(
              `select pg_get_constraintdef(oid) as def from pg_constraint
                where conname = 'orders_pack_fee_scan_only'`
            )
          ).rows[0]
      );
      assert.ok(constraint, 'the constraint exists rather than being a convention');
      assert.match(constraint.def, /SCAN/);
    });
  });

  // =========================================================================
  // DISPATCH
  // =========================================================================
  /**
   * APPROVAL IS THE GATE, and this is the whole of it.
   *
   * Paying for a Meal Scan order used to open the search, so Partners were
   * offered a job whose entitlement nobody had looked at — and which the store
   * might be about to refuse, cancelling the order under them. The store looks
   * first now, and vendor_redeem_scan() is the only statement that opens a scan
   * order's search.
   */
  test('paying does NOT open dispatch on a Meal Scan order', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const order = await getOrder(orderId);
    assert.equal(order.order_status, 'PREPARING', 'the store has it');
    assert.equal(order.delivery_status, 'NONE', 'and nobody is being looked for yet');
    assert.equal(order.search_deadline_at, null);
  });

  test('a Partner cannot be assigned before the store approves the scan', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const early = await acceptAs(ACTORS.partnerYaw, orderId);
    assert.equal(early.success, false, 'there is nothing to accept');

    const order = await getOrder(orderId);
    assert.equal(order.partner_id, null);
    assert.equal(order.delivery_status, 'NONE');
  });

  test('a paid scan order is not in the offer pool until it is approved', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const offered = (partner) =>
      asUser(partner, async (c) =>
        (await c.query('select order_id from public.get_delivery_offers()')).rows.map(
          (r) => r.order_id
        )
      );

    assert.equal((await offered(ACTORS.partnerYaw)).includes(orderId), false, 'before approval');
    await redeemAs(ACTORS.wafflemaniaStaff, orderId);
    assert.equal((await offered(ACTORS.partnerYaw)).includes(orderId), true, 'after it');
  });

  test('approving opens the search, and two Partners race for exactly one slot', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await redeemAs(ACTORS.wafflemaniaStaff, orderId);

    assert.equal((await getOrder(orderId)).delivery_status, 'SEARCHING');

    const [first, second] = await Promise.all([
      acceptAs(ACTORS.partnerYaw, orderId),
      acceptAs(ACTORS.partnerAdjoa, orderId),
    ]);

    const wins = [first, second].filter((r) => r?.success).length;
    assert.equal(wins, 1, 'exactly one acceptance wins');
  });

  test('accepting does not collect it, and touches the scan not at all', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await redeemAs(ACTORS.wafflemaniaStaff, orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);

    const order = await getOrder(orderId);
    assert.equal(order.scan_status, 'REDEEMED', 'the store settled it, not the Partner');
    assert.equal(order.delivery_status, 'ASSIGNED');
    assert.notEqual(order.delivery_status, 'PICKED_UP');
  });

  test('a Partner cannot collect before the store has marked it ready', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await redeemAs(ACTORS.wafflemaniaStaff, orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);

    const early = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_confirm_pickup($1, $2)', [orderId, '0000']))
          .rows[0],
      { commit: true }
    );
    assert.equal(early.success, false);
    assert.match(early.reason, /not ready yet/i);
  });

  test('when the search expires the scan stays exactly as the store left it', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await redeemAs(ACTORS.wafflemaniaStaff, orderId);

    await asService((c) =>
      c.query(
        "update public.orders set search_deadline_at = now() - interval '1 minute' where id = $1",
        [orderId]
      )
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    const order = await getOrder(orderId);
    assert.equal(order.delivery_status, 'FAILED_NO_PARTNER');
    assert.equal(order.scan_status, 'REDEEMED', 'nobody un-approved anything');
  });

  // =========================================================================
  // PRIVACY
  // =========================================================================
  describe('scan privacy', () => {
    async function pathAs(userId, orderId) {
      return asUser(
        userId,
        async (c) => (await c.query('select public.scan_image_path($1) as p', [orderId])).rows[0].p
      );
    }

    test('the customer can read their own scan', async () => {
      const { order_id: orderId } = await submitScan();
      assert.equal(await pathAs(ACTORS.customerAma, orderId), scanPath(ACTORS.customerAma));
    });

    test('another customer cannot read it', async () => {
      const { order_id: orderId } = await submitScan();
      assert.equal(await pathAs(ACTORS.customerKwesi, orderId), null);
    });

    test('a Partner cannot read it before accepting', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      assert.equal(
        await pathAs(ACTORS.partnerYaw, orderId),
        null,
        'an offer is a decision aid, not the artifact'
      );
    });

    test('the assigned Partner cannot read it either', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      assert.equal(
        await pathAs(ACTORS.partnerYaw, orderId),
        null,
        'the store already judged it; the Partner only carries the food'
      );
      assert.equal(await pathAs(ACTORS.partnerAdjoa, orderId), null);
    });

    test('reassignment changes nothing, because nobody had it', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await redeemAs(ACTORS.wafflemaniaStaff, orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_reassign_delivery($1, $2)', [
            orderId,
            'partner unreachable',
          ]),
        { commit: true }
      );

      assert.equal(await pathAs(ACTORS.partnerYaw, orderId), null);
      // THE APPROVAL STANDS. A scan the store has already honoured is not
      // un-honoured by a Partner dropping the job; the food is still made.
      assert.equal((await getOrder(orderId)).scan_status, 'REDEEMED');
    });

    test('an administrator can read it', async () => {
      const { order_id: orderId } = await submitScan();
      assert.equal(await pathAs(ACTORS.admin, orderId), scanPath());
    });

    /**
     * The store reads a scan through its OWN function, gated on the order being
     * live on its board. scan_image_path() is the customer/Partner/admin door
     * and stays shut to them — two doors, two windows, neither widened.
     */
    test('the store does not get in through the customer’s door', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      assert.equal(await pathAs(ACTORS.wafflemaniaStaff, orderId), null);
    });

    test('anon cannot reach either function at all', async () => {
      const { order_id: orderId } = await submitScan();
      for (const fn of ['scan_image_path', 'vendor_scan_image_path']) {
        const error = await expectRejection(
          asAnon((c) => c.query(`select public.${fn}($1)`, [orderId]))
        );
        assert.match(error.message, /permission denied|does not exist/i);
      }
    });

    test('the row itself is unreadable to everyone but those four', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);

      const rowsFor = (userId) =>
        asUser(
          userId,
          async (c) =>
            (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows
        );

      assert.equal((await rowsFor(ACTORS.customerAma)).length, 1);
      assert.equal((await rowsFor(ACTORS.admin)).length, 1);
      assert.equal(
        (await rowsFor(ACTORS.wafflemaniaStaff)).length,
        1,
        'the store honouring it, while it is live'
      );
      assert.equal((await rowsFor(ACTORS.customerKwesi)).length, 0);
      assert.equal((await rowsFor(ACTORS.partnerAdjoa)).length, 0);
      assert.equal(
        (await rowsFor(ACTORS.vendor1Staff)).length,
        0,
        'and never a store with no part in it'
      );
    });

    /**
     * A PARTNER NEVER READS A MEAL SCAN, AT ANY POINT.
     *
     * There used to be a window here — released on assignment, shut at the end
     * of the delivery — because the Partner carried the entitlement to a
     * counter that had never seen the order. The store verifies it on its own
     * board now, BEFORE dispatch even opens, so a Partner holding a link to
     * somebody's meal entitlement is exposure with nothing on the other side
     * of it. The right was removed rather than narrowed.
     *
     * Both doors are checked at every point in the delivery, because
     * `authenticated` holds SELECT on order_scans and a function that returns
     * null means nothing if the row can be read straight off the table.
     */
    describe('the Partner has no window', () => {
      const rowsFor = (userId, orderId) =>
        asUser(
          userId,
          async (c) =>
            (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows
        );

      /** Both doors at once: the function, and the table behind it. */
      async function readsFor(userId, orderId) {
        return {
          path: await pathAs(userId, orderId),
          rows: (await rowsFor(userId, orderId)).length,
        };
      }

      const shut = async (userId, orderId, when) => {
        const seen = await readsFor(userId, orderId);
        assert.deepEqual(seen, { path: null, rows: 0 }, when);
      };

      /** Paid, approved by the store, accepted, collected. */
      async function carriedToPickedUp() {
        const { order_id: orderId } = await submitScan();
        await payScan(orderId);
        await redeemAs(ACTORS.wafflemaniaStaff, orderId);
        await acceptAs(ACTORS.partnerYaw, orderId);
        await markReadyAs(ACTORS.wafflemaniaStaff, orderId);

        const collected = await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            (
              await c.query('select * from public.partner_confirm_pickup($1, $2)', [
                orderId,
                await pickupCode(orderId),
              ])
            ).rows[0],
          { commit: true }
        );
        assert.equal(collected.success, true, 'the Partner is carrying it');
        return orderId;
      }

      test('SEARCHING: an offer carries no scan', async () => {
        const { order_id: orderId } = await submitScan();
        await payScan(orderId);
        await redeemAs(ACTORS.wafflemaniaStaff, orderId);
        await shut(ACTORS.partnerYaw, orderId, 'before accepting');
      });

      test('ASSIGNED: the carrying Partner still reads nothing', async () => {
        const { order_id: orderId } = await submitScan();
        await payScan(orderId);
        await redeemAs(ACTORS.wafflemaniaStaff, orderId);
        await acceptAs(ACTORS.partnerYaw, orderId);

        await shut(ACTORS.partnerYaw, orderId, 'assigned');
        await shut(ACTORS.partnerAdjoa, orderId, 'and neither does anybody else');
      });

      test('PICKED_UP: holding the food changes nothing', async () => {
        const orderId = await carriedToPickedUp();
        await shut(ACTORS.partnerYaw, orderId, 'carrying it');
      });

      test('DELIVERED: still nothing', async () => {
        const orderId = await carriedToPickedUp();
        await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            c.query('select * from public.partner_complete_delivery($1, $2)', [
              orderId,
              await deliveryCode(orderId),
            ]),
          { commit: true }
        );
        await shut(ACTORS.partnerYaw, orderId, 'after delivering');
      });

      /**
       * THE RELEASE MACHINERY IS GONE, not merely unused. A trigger that
       * nobody calls is a trigger somebody re-wires; the function and its
       * trigger are dropped, so the only way back is a migration that says so.
       */
      test('nothing releases a scan to anybody any more', async () => {
        const { order_id: orderId } = await submitScan();
        await payScan(orderId);
        await redeemAs(ACTORS.wafflemaniaStaff, orderId);
        await acceptAs(ACTORS.partnerYaw, orderId);

        const row = await asService(
          async (c) =>
            (
              await c.query(
                'select released_to, released_at from public.order_scans where order_id = $1',
                [orderId]
              )
            ).rows[0]
        );
        assert.equal(row.released_to, null, 'assignment releases nothing');
        assert.equal(row.released_at, null);

        const gone = await asService(
          async (c) =>
            (
              await c.query(
                `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('release_scan_on_assignment',
                                      'partner_may_read_scan',
                                      'partner_scan_brief')`
              )
            ).rows
        );
        assert.deepEqual(gone, [], 'and the functions behind it do not exist');
      });

      /**
       * The AUDIT survives. What was withdrawn is the ability to fetch an
       * image, never the record of what happened to the entitlement.
       */
      test('the record of what happened is untouched', async () => {
        const orderId = await carriedToPickedUp();

        const row = await asService(
          async (c) =>
            (
              await c.query(
                'select redeemed_at, redeemed_by from public.order_scans where order_id = $1',
                [orderId]
              )
            ).rows[0]
        );
        assert.ok(row.redeemed_at, 'the store redeemed it and that is written down');
        assert.equal(row.redeemed_by, ACTORS.wafflemaniaStaff);
      });

      test('the customer and an administrator are untouched by all of it', async () => {
        const orderId = await carriedToPickedUp();

        assert.equal(
          (await readsFor(ACTORS.customerAma, orderId)).path,
          scanPath(ACTORS.customerAma),
          'their own scan, always'
        );
        assert.equal((await readsFor(ACTORS.admin, orderId)).rows, 1);
      });
    });
  });

  // =========================================================================
  // THE REST OF THE ATTACK SURFACE
  // =========================================================================
  describe('authorisation', () => {
    test('a scan path belonging to someone else cannot be attached to an order', async () => {
      const error = await expectRejection(
        submitScan({ customer: ACTORS.customerAma, path: scanPath(ACTORS.customerKwesi) })
      );
      assert.match(error.message, /does not belong to this account/i);
    });

    test('an account without the Customer capability cannot create a scan order', async () => {
      const error = await expectRejection(submitScan({ customer: ACTORS.admin }));
      assert.match(error.message, /student details/i);
    });

    test('a scan order cannot be created without a scan', async () => {
      const error = await expectRejection(submitScan({ path: '   ' }));
      assert.match(error.message, /attach your meal scan|does not belong/i);
    });

    test('a scan order cannot be created with no items', async () => {
      const error = await expectRejection(submitScan({ items: [] }));
      assert.match(error.message, /at least one item/i);
    });

    /**
     * THE DETAILS FIELD IS OPTIONAL NOW. It used to be the only way anybody
     * knew what to hand over, so it had to be compulsory; the items say that.
     */
    test('the optional note is optional, and is stored when given', async () => {
      const without = await submitScan({ details: null });
      assert.ok(without.order_id, 'an order with no note is accepted');

      const { order_id: orderId } = await submitScan({ details: 'No pepper.' });
      const stored = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.my_scan_order($1)', [orderId])).rows[0]
      );
      assert.equal(stored.details, 'No pepper.');
    });

    test('a note longer than the column allows is refused', async () => {
      const error = await expectRejection(submitScan({ details: 'x'.repeat(281) }));
      assert.match(error.message, /order information under 280 characters/i);
    });

    test('a customer cannot mark their own scan redeemed', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      const error = await expectRejection(redeemAs(ACTORS.customerAma, orderId));
      assert.match(error.message, /not authorised/i);
    });

    test('a Partner cannot mark a scan redeemed, assigned or not', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      const error = await expectRejection(redeemAs(ACTORS.partnerYaw, orderId));
      assert.match(error.message, /not authorised/i);
    });

    /**
     * The Partner's old self-report is GONE, not merely unreachable. A second
     * road to REDEEMED from the other side of the counter is exactly the
     * asymmetry the handoff rule exists to prevent.
     */
    test('the Partner’s old redemption functions no longer exist', async () => {
      const remaining = await asService(
        async (c) =>
          (
            await c.query(
              `select proname from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and proname in ('partner_report_scan_redeemed', 'partner_report_scan_refused')`
            )
          ).rows
      );
      assert.deepEqual(remaining, []);
    });

    test('the redemption call is refused on a food order', async () => {
      const foodOrderId = await asService(
        async (c) =>
          (
            await c.query(
              `select id from public.orders where order_type = 'FOOD' and vendor_id = $1 limit 1`,
              [VENDORS.one]
            )
          ).rows[0]?.id
      );
      if (!foodOrderId) return;

      const result = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (await c.query('select * from public.vendor_redeem_scan($1)', [foodOrderId])).rows[0],
        { commit: true }
      );
      assert.equal(result.success, false);
      assert.match(result.reason, /not a meal scan/i);
    });

    test('nobody can write to order_scans directly', async () => {
      const { order_id: orderId } = await submitScan();
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query("update public.order_scans set details = 'x' where order_id = $1", [orderId])
        )
      );
      assert.match(error.message, /permission denied/i);
    });
  });

  // =========================================================================
  // CONFLICT OF INTEREST — unchanged, and still applied
  // =========================================================================
  describe('conflict of interest', () => {
    test('a Partner cannot carry their own scan order', async () => {
      const { order_id: orderId } = await submitScan({ customer: ACTORS.partnerYaw });
      await payScan(orderId);

      const offers = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
      );
      assert.equal(
        offers.some((o) => o.order_id === orderId),
        false,
        'it is not even offered to them'
      );

      const error = await expectRejection(acceptAs(ACTORS.partnerYaw, orderId));
      assert.match(error.message, /cannot deliver an order you placed/i);
    });
  });

  // =========================================================================
  // INFRASTRUCTURE — the things that go wrong silently
  // =========================================================================
  describe('scan infrastructure', () => {
    /**
     * DROP FUNCTION discards the REVOKE applied to the old definition, and
     * CREATE hands EXECUTE back to PUBLIC. This migration drops and recreates
     * several functions, and getting that wrong once already made the live
     * dispatch queue anon-callable. Asserted by name so the next person who
     * drops one finds out immediately.
     */
    test('every function this migration dropped and recreated is closed to anon', async () => {
      // partner_scan_brief is NOT here any more, and not because it lost its
      // grant: it does not exist. A Partner is told nothing about a Meal Scan.
      const dropped = [
        'vendor_order_board',
        'vendor_order_detail',
        'my_scan_order',
        'submit_scan_order',
        'quote_scan_order',
      ];

      const reachable = await asService(async (c) =>
        (
          await c.query(
            `select distinct p.proname
                 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname = any($1::text[])
                  and has_function_privilege('anon', p.oid, 'EXECUTE')`,
            [dropped]
          )
        ).rows.map((r) => r.proname)
      );
      assert.deepEqual(reachable, [], 'a dropped function silently regained PUBLIC execute');

      const authenticated = await asService(async (c) =>
        (
          await c.query(
            `select distinct p.proname
                 from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname = any($1::text[])
                  and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
            [dropped]
          )
        ).rows.map((r) => r.proname)
      );
      assert.deepEqual(
        authenticated.sort(),
        [...dropped].sort(),
        'and each one is still reachable by the people who need it'
      );
    });

    test('price_scan_order is reachable only through the functions that wrap it', async () => {
      const reachable = await asService(
        async (c) =>
          (
            await c.query(
              `select r.rolname from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
               cross join (values ('anon'), ('authenticated')) as r(rolname)
              where n.nspname = 'public' and p.proname = 'price_scan_order'
                and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`
            )
          ).rows
      );
      assert.deepEqual(reachable, [], 'a client cannot probe scan pricing directly');
    });

    test('every scan function pins its search_path and is SECURITY DEFINER', async () => {
      const rows = await asService(
        async (c) =>
          (
            await c.query(`
              select p.proname, p.prosecdef, p.proconfig
                from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public'
                 and (p.proname like '%scan%' or p.proname = 'release_scan_on_assignment')
            `)
          ).rows
      );

      assert.ok(rows.length >= 8, `expected the scan functions, found ${rows.length}`);
      for (const fn of rows) {
        assert.equal(fn.prosecdef, true, `${fn.proname} must be SECURITY DEFINER`);
        const pinned = (fn.proconfig ?? []).some((setting) => setting.startsWith('search_path='));
        assert.ok(pinned, `${fn.proname} must pin an empty search_path`);
      }
    });

    /**
     * A fresh hosted project must be priced correctly on day one.
     * schema.sql installs pricing_config by naming only the columns with no
     * default, so a nullable fee with no default would install as NULL and
     * price_scan_order() would refuse to quote on a brand-new project.
     */
    test('both scan fees have column defaults, so a fresh install is priced', async () => {
      const columns = await asService(
        async (c) =>
          (
            await c.query(`
              select column_name, column_default, is_nullable
                from information_schema.columns
               where table_schema = 'public'
                 and table_name = 'pricing_config'
                 and column_name in ('scan_service_fee_pesewas', 'scan_pack_fee_pesewas')
            `)
          ).rows
      );
      const by = Object.fromEntries(columns.map((c) => [c.column_name, c]));

      assert.match(String(by.scan_service_fee_pesewas.column_default), /200/, 'GH₵2.00');
      assert.equal(
        by.scan_service_fee_pesewas.is_nullable,
        'YES',
        'null stays expressible as "unpriced"'
      );
      assert.equal(by.scan_pack_fee_pesewas.is_nullable, 'NO', 'the pack fee is never unpriced');
    });

    test('the live pack fee is GH₵4.00', async () => {
      const value = await asService(
        async (c) =>
          (await c.query('select scan_pack_fee_pesewas from public.pricing_config where id'))
            .rows[0].scan_pack_fee_pesewas
      );
      assert.equal(Number(value), PACK_FEE);
    });

    test('the scan-documents bucket is private and has no storage policies', async () => {
      const bucket = await asService(
        async (c) =>
          (await c.query("select * from storage.buckets where id = 'scan-documents'")).rows[0]
      );
      assert.ok(bucket, 'the bucket exists');
      assert.equal(bucket.public, false, 'a meal scan is never publicly readable');

      const policies = await asService(
        async (c) =>
          (
            await c.query(`
              select policyname, qual::text
                from pg_policies
               where schemaname = 'storage' and tablename = 'objects'
                 and qual::text like '%scan-documents%'
            `)
          ).rows
      );
      assert.deepEqual(policies, [], 'no client may reach scan objects through the API');
    });

    test('order_scans is readable only through its policy, and never writable', async () => {
      const grants = await asService(
        async (c) =>
          (
            await c.query(`
              select grantee, privilege_type
                from information_schema.role_table_grants
               where table_schema = 'public' and table_name = 'order_scans'
                 and grantee in ('anon', 'authenticated')
               order by grantee, privilege_type
            `)
          ).rows
      );
      assert.deepEqual(
        grants,
        [{ grantee: 'authenticated', privilege_type: 'SELECT' }],
        'clients get SELECT only, and anon gets nothing at all'
      );

      const rls = await asService(
        async (c) =>
          (
            await c.query(
              "select relrowsecurity from pg_class where oid = 'public.order_scans'::regclass"
            )
          ).rows[0].relrowsecurity
      );
      assert.equal(rls, true, 'RLS is enabled');
    });
  });

  test('a non-admin gets nothing from the admin view', async () => {
    const { order_id: orderId } = await submitScan();
    const rows = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.admin_scan_order($1)', [orderId])).rows
    );
    assert.equal(rows.length, 0);
  });
});
