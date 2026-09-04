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
} from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * Scan Delivery.
 *
 * A student holds a prepaid campus meal entitlement and does not want to walk
 * to the restaurant. Campus Dash sells the errand, not the food.
 *
 * Every assertion here exists to defend one of three claims:
 *
 *   1. THE MONEY. The scan's face value never enters our ledger. The restaurant
 *      is owed nothing by us, the Partner is paid for the errand and not for the
 *      meal, and the platform's revenue is the scan service fee.
 *   2. THE SCAN. It is private. The customer, the CURRENTLY assigned Partner and
 *      an admin can reach it; nobody else can, at any point, by any route.
 *   3. REDEMPTION IS NOT ACCEPTANCE. Taking the job does not mean the scan was
 *      honoured, and no scan order can be redeemed twice through this workflow.
 */
describe('scan delivery', () => {
  // The agreed commercial terms for a scan errand. Written out rather than read
  // from config on purpose: a test that reads the number it is checking proves
  // only that the code is self-consistent, not that the price is right.
  const SCAN_FEE = 200; // GH₵2.00 flat per errand
  const DELIVERY_FEE = 500; // GH₵5.00
  const CUSTOMER_PAYS = 700; // GH₵7.00 — and no food value anywhere in it
  const FOOD_SERVICE_FEE_BPS = 500; // 5% of the food subtotal, for FOOD orders only

  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(`
        update public.pricing_config
           set delivery_fee_pesewas = 500, partner_share_of_delivery_bps = 10000,
               scan_service_fee_pesewas = 200, partner_search_seconds = 600,
               service_fee_bps = 500
         where id
      `)
    );
    // The seed marks these scan-capable; a previous test may have flipped them.
    await asService((c) =>
      c.query(`update public.vendors set can_accept_scans = (id = any($1::uuid[]))`, [
        [VENDORS.wafflemania, VENDORS.yellowBar],
      ])
    );
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  // A path shaped exactly like the one the upload route produces.
  const scanPath = (customer = ACTORS.customerAma) => `${customer}/scans/scan-1.jpg`;

  /** Creates a scan order the way the application does. */
  async function submitScan({
    customer = ACTORS.customerAma,
    vendorId = VENDORS.wafflemania,
    destination = LOCATIONS.room204,
    path = null,
  } = {}) {
    return asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.submit_scan_order($1, $2, $3, $4, $5, $6)', [
            vendorId,
            destination,
            path ?? scanPath(customer),
            'image/jpeg',
            120000,
            null,
          ])
        ).rows[0],
      { commit: true }
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

  // =========================================================================
  // PRICING — the fee basis is explicit, and refuses to guess
  // =========================================================================
  describe('pricing', () => {
    test('a scan order costs the service fee plus delivery, and nothing for food', async () => {
      const quote = await asUser(
        ACTORS.customerAma,
        async (c) =>
          (
            await c.query('select * from public.quote_scan_order($1, $2)', [
              VENDORS.wafflemania,
              LOCATIONS.room204,
            ])
          ).rows[0]
      );

      // The agreed commercial terms, asserted as literal figures.
      assert.equal(Number(quote.subtotal_pesewas), 0, 'Campus Dash sells no food here');
      assert.equal(Number(quote.service_fee_pesewas), 200, 'GH₵2.00 flat scan service fee');
      assert.equal(Number(quote.delivery_fee_pesewas), 500, 'GH₵5.00 delivery fee');
      assert.equal(Number(quote.total_pesewas), 700, 'the customer pays GH₵7.00');
    });

    test('the scan fee is FLAT — it does not move with the food service percentage', async () => {
      // Crank the FOOD service fee to 50%. A scan order must not notice.
      await asService((c) =>
        c.query('update public.pricing_config set service_fee_bps = 5000 where id')
      );

      const quote = await asUser(
        ACTORS.customerAma,
        async (c) =>
          (
            await c.query('select * from public.quote_scan_order($1, $2)', [
              VENDORS.wafflemania,
              LOCATIONS.room204,
            ])
          ).rows[0]
      );

      assert.equal(
        Number(quote.service_fee_pesewas),
        SCAN_FEE,
        'the scan fee is a flat amount, never a percentage'
      );
      assert.equal(Number(quote.total_pesewas), CUSTOMER_PAYS);
    });

    test('the scan fee does not move with the food subtotal either', async () => {
      // There is no subtotal to scale against, and raising the delivery fee must
      // not drag the service fee with it.
      await asService((c) =>
        c.query('update public.pricing_config set delivery_fee_pesewas = 1500 where id')
      );

      const quote = await asUser(
        ACTORS.customerAma,
        async (c) =>
          (
            await c.query('select * from public.quote_scan_order($1, $2)', [
              VENDORS.wafflemania,
              LOCATIONS.room204,
            ])
          ).rows[0]
      );

      assert.equal(Number(quote.service_fee_pesewas), SCAN_FEE, 'still GH₵2.00');
      assert.equal(Number(quote.delivery_fee_pesewas), 1500);
      assert.equal(Number(quote.total_pesewas), SCAN_FEE + 1500);
    });

    test('a FOOD order still pays 5% of its food subtotal, untouched by any of this', async () => {
      const { rows } = await asUser(
        ACTORS.customerAma,
        async (c) =>
          c.query('select * from public.quote_order($1, $2, $3::jsonb, $4)', [
            VENDORS.one,
            'DELIVERY',
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
            LOCATIONS.room204,
          ]),
        { commit: false }
      );
      const quote = rows[0];

      // Jollof is GH₵35.00. 5% of that is GH₵1.75 — the pre-existing rule,
      // proven here so a change to scan pricing can never quietly reach it.
      assert.equal(Number(quote.subtotal_pesewas), 3500);
      assert.equal(
        Number(quote.service_fee_pesewas),
        Math.round((3500 * FOOD_SERVICE_FEE_BPS) / 10000),
        'food still pays a percentage, not the flat scan fee'
      );
      assert.equal(Number(quote.service_fee_pesewas), 175);
      assert.notEqual(Number(quote.service_fee_pesewas), SCAN_FEE);
      assert.equal(Number(quote.total_pesewas), 3500 + 175 + DELIVERY_FEE);
    });

    test('an unconfigured scan fee refuses to price rather than assuming zero', async () => {
      await asService((c) =>
        c.query('update public.pricing_config set scan_service_fee_pesewas = null where id')
      );

      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.quote_scan_order($1, $2)', [
            VENDORS.wafflemania,
            LOCATIONS.room204,
          ])
        )
      );
      assert.match(error.message, /not configured/i);
    });

    test('a restaurant that does not take scans cannot be quoted or ordered from', async () => {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.quote_scan_order($1, $2)', [VENDORS.two, LOCATIONS.room204])
        )
      );
      assert.match(error.message, /not accepting scan deliveries/i);

      const refused = await expectRejection(submitScan({ vendorId: VENDORS.two }));
      assert.match(refused.message, /not accepting scan deliveries/i);
    });

    test('a non-deliverable destination is refused — scan delivery is delivery-only', async () => {
      const error = await expectRejection(submitScan({ destination: LOCATIONS.floor2 }));
      assert.match(error.message, /not a valid delivery location/i);
    });

    test('only scan-capable restaurants are listed', async () => {
      const rows = await asAnon(
        async (c) => (await c.query('select * from public.scan_restaurants()')).rows
      );
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(VENDORS.wafflemania));
      assert.ok(ids.includes(VENDORS.yellowBar));
      assert.equal(ids.includes(VENDORS.two), false, 'a non-scan stall is not offered');
    });
  });

  // =========================================================================
  // SCENARIO 1 & 2 — the successful errand, and the ledger it produces
  // =========================================================================
  describe('the successful scan delivery', () => {
    for (const [label, vendorId] of [
      ['Wafflemania', VENDORS.wafflemania],
      ['Yellow Bar', VENDORS.yellowBar],
    ]) {
      test(`${label}: upload → pay → assign → redeem → deliver, with a correct ledger`, async () => {
        const submitted = await submitScan({ vendorId });
        const orderId = submitted.order_id;

        let order = await getOrder(orderId);
        assert.equal(order.order_type, 'SCAN');
        assert.equal(order.fulfilment_type, 'DELIVERY', 'scan orders are delivery-only');
        assert.equal(Number(order.subtotal_pesewas), 0);
        assert.equal(order.scan_status, 'UPLOADED');
        // ACCEPTED with no vendor involved: the restaurant has nothing to accept.
        assert.equal(order.order_status, 'ACCEPTED');
        assert.equal(order.delivery_status, 'NONE', 'dispatch does not open before payment');

        await payScan(orderId);

        order = await getOrder(orderId);
        assert.equal(order.payment_status, 'PAID');
        assert.equal(order.order_status, 'READY', 'paying is what opens dispatch');
        assert.equal(order.delivery_status, 'SEARCHING');

        // THE LEDGER AT PAYMENT. Two facts matter and both are asserted:
        // there is no VENDOR row at all, and the platform holds the rest.
        const paid = await allocationsFor(orderId);
        assert.equal(
          paid.some((a) => a.payee_type === 'VENDOR'),
          false,
          'the restaurant is owed nothing by Campus Dash for a scan'
        );
        assert.deepEqual(
          paid.map((a) => [a.payee_type, Number(a.amount_pesewas)]),
          [['PLATFORM', SCAN_FEE + DELIVERY_FEE]]
        );

        const accepted = await acceptAs(ACTORS.partnerYaw, orderId);
        assert.equal(accepted.success, true);

        order = await getOrder(orderId);
        assert.equal(order.delivery_status, 'ASSIGNED');
        assert.equal(order.scan_status, 'RELEASED', 'accepting releases the scan to that Partner');

        // Redemption is its own act, and it is what puts the food in hand.
        const redeemed = await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            (await c.query('select * from public.partner_report_scan_redeemed($1)', [orderId]))
              .rows[0],
          { commit: true }
        );
        assert.equal(redeemed.success, true);

        order = await getOrder(orderId);
        assert.equal(order.scan_status, 'REDEEMED');
        assert.equal(order.delivery_status, 'PICKED_UP');

        const code = await asService(
          async (c) =>
            (
              await c.query('select delivery_code from public.order_secrets where order_id = $1', [
                orderId,
              ])
            ).rows[0].delivery_code
        );

        const done = await asUser(
          ACTORS.partnerYaw,
          async (c) =>
            (
              await c.query('select * from public.partner_complete_delivery($1, $2)', [
                orderId,
                code,
              ])
            ).rows[0],
          { commit: true }
        );
        assert.equal(done.success, true);

        order = await getOrder(orderId);
        assert.equal(order.delivery_status, 'DELIVERED');
        assert.equal(order.order_status, 'COMPLETED');

        // THE LEDGER AFTER DELIVERY. The Partner is paid for the errand — the
        // delivery fee, not the meal — and the platform keeps the scan fee.
        const settled = await allocationsFor(orderId);
        const byPayee = Object.fromEntries(
          settled.map((a) => [a.payee_type, Number(a.amount_pesewas)])
        );
        assert.equal(byPayee.PARTNER, DELIVERY_FEE, 'the Partner earns the errand, not the meal');
        assert.equal(byPayee.PLATFORM, SCAN_FEE);
        assert.equal(byPayee.VENDOR, undefined);
        assert.equal(
          settled.reduce((sum, a) => sum + Number(a.amount_pesewas), 0),
          SCAN_FEE + DELIVERY_FEE,
          'the ledger balances against what the customer actually paid'
        );
      });
    }
  });

  // =========================================================================
  // THE ECONOMICS, stated as money rather than as ratios
  // =========================================================================
  describe('scan economics', () => {
    test('the whole ledger, in cedis: customer 7, partner 5, platform 2, vendor nothing', async () => {
      const { order_id: orderId } = await submitScan();

      const order = await getOrder(orderId);
      assert.equal(Number(order.subtotal_pesewas), 0, 'no food value enters our books');
      assert.equal(Number(order.service_fee_pesewas), SCAN_FEE);
      assert.equal(Number(order.delivery_fee_pesewas), DELIVERY_FEE);
      assert.equal(Number(order.total_pesewas), CUSTOMER_PAYS);

      const payment = await payScan(orderId);
      assert.equal(
        Number(payment.amount_pesewas),
        CUSTOMER_PAYS,
        'we ask the provider for exactly GH₵7.00'
      );

      await acceptAs(ACTORS.partnerYaw, orderId);
      await asUser(
        ACTORS.partnerYaw,
        (c) => c.query('select * from public.partner_report_scan_redeemed($1)', [orderId]),
        { commit: true }
      );
      const code = await asService(
        async (c) =>
          (
            await c.query('select delivery_code from public.order_secrets where order_id = $1', [
              orderId,
            ])
          ).rows[0].delivery_code
      );
      await asUser(
        ACTORS.partnerYaw,
        (c) => c.query('select * from public.partner_complete_delivery($1, $2)', [orderId, code]),
        { commit: true }
      );

      const ledger = Object.fromEntries(
        (await allocationsFor(orderId)).map((a) => [a.payee_type, Number(a.amount_pesewas)])
      );

      assert.equal(ledger.VENDOR, undefined, 'the restaurant is owed nothing by Campus Dash');
      assert.equal(ledger.PARTNER, 500, 'the Partner earns GH₵5.00 for the errand');
      assert.equal(ledger.PLATFORM, 200, 'Campus Dash keeps GH₵2.00');
      assert.equal(
        Object.values(ledger).reduce((a, b) => a + b, 0),
        CUSTOMER_PAYS,
        'and the three of those account for every pesewa the customer paid'
      );
    });

    /**
     * Paystack's cut is a platform expense BY CONSTRUCTION, not by policy.
     *
     * `payments` records the gross collected and the schema has no fee column
     * anywhere, so there is nothing that could deduct a processing fee from what
     * a Partner or a vendor is owed. The cost lands on the platform's share
     * because that is the only place left for it to land. This test asserts the
     * structural fact rather than a number we do not have.
     */
    test('a provider fee cannot be deducted from anyone’s entitlement', async () => {
      const feeColumns = await asService(
        async (c) =>
          (
            await c.query(`
              select table_name, column_name
                from information_schema.columns
               where table_schema = 'public'
                 and table_name in ('payments', 'allocations', 'orders', 'payouts')
                 and (column_name like '%fee%' or column_name like '%charge%')
            `)
          ).rows
      );
      // The only fee columns in the money tables are OUR fees on the order.
      // Nothing records a provider charge, so nothing can net one off.
      const unexpected = feeColumns.filter(
        (r) =>
          !(
            r.table_name === 'orders' &&
            ['service_fee_pesewas', 'delivery_fee_pesewas'].includes(r.column_name)
          )
      );
      assert.deepEqual(unexpected, [], 'no provider-fee column exists in the money tables');

      const { order_id: orderId } = await submitScan();
      const payment = await payScan(orderId);
      const order = await getOrder(orderId);

      assert.equal(
        Number(payment.amount_pesewas),
        Number(order.total_pesewas),
        'the payment is the gross the customer owes, never net of a provider fee'
      );

      const total = (await allocationsFor(orderId)).reduce(
        (sum, a) => sum + Number(a.amount_pesewas),
        0
      );
      assert.equal(total, Number(order.total_pesewas), 'and the ledger distributes that gross');
    });

    test('a customer cannot tamper with the GH₵2.00 fee, before or after paying', async () => {
      const { order_id: orderId } = await submitScan();

      for (const sql of [
        'update public.orders set service_fee_pesewas = 0 where id = $1',
        'update public.orders set total_pesewas = 500 where id = $1',
        'update public.orders set subtotal_pesewas = -100 where id = $1',
        "update public.orders set order_type = 'FOOD' where id = $1",
      ]) {
        const error = await expectRejection(
          asUser(ACTORS.customerAma, (c) => c.query(sql, [orderId]))
        );
        assert.match(error.message, /permission denied/i);
      }

      const order = await getOrder(orderId);
      assert.equal(Number(order.service_fee_pesewas), SCAN_FEE, 'still GH₵2.00');
      assert.equal(Number(order.total_pesewas), CUSTOMER_PAYS);
      assert.equal(order.order_type, 'SCAN');
    });

    test('a Partner cannot inflate their own payout on a scan errand', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      const error = await expectRejection(
        asUser(ACTORS.partnerYaw, (c) =>
          c.query('update public.orders set partner_earnings_pesewas = 5000 where id = $1', [
            orderId,
          ])
        )
      );
      assert.match(error.message, /permission denied/i);

      const order = await getOrder(orderId);
      assert.equal(Number(order.partner_earnings_pesewas), DELIVERY_FEE);
    });

    test('a scan order can never carry food value, even if one is forced in', async () => {
      const { order_id: orderId } = await submitScan();

      // The constraint is the backstop behind every permission check above.
      const error = await expectRejection(
        asService((c) =>
          c.query('update public.orders set subtotal_pesewas = 2500 where id = $1', [orderId])
        )
      );
      assert.match(error.message, /orders_scan_has_no_food_value|violates check constraint/i);
    });

    test('a FOOD order is completely unaffected: 5% fee and a real vendor entitlement', async () => {
      const { rows } = await asUser(
        ACTORS.customerAma,
        async (c) =>
          c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
            VENDORS.one,
            'DELIVERY',
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
            LOCATIONS.room204,
            null,
          ]),
        { commit: true }
      );
      const foodOrderId = rows[0].order_id;

      await asUser(
        ACTORS.vendor1Staff,
        (c) => c.query('select public.vendor_accept_order($1)', [foodOrderId]),
        { commit: true }
      );
      await asService(async (c) => {
        const intent = (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            foodOrderId,
            `food:${foodOrderId}`,
          ])
        ).rows[0];
        await c.query('select public.confirm_payment($1, $2, $3)', [
          intent.id,
          'txn_food',
          intent.amount_pesewas,
        ]);
      });

      const order = await getOrder(foodOrderId);
      assert.equal(order.order_type, 'FOOD');
      assert.equal(order.scan_status, null, 'a food order has no scan dimension');
      assert.equal(Number(order.subtotal_pesewas), 3500);
      assert.equal(Number(order.service_fee_pesewas), 175, 'still 5% of the food');
      assert.equal(Number(order.total_pesewas), 3500 + 175 + DELIVERY_FEE);

      const ledger = Object.fromEntries(
        (await allocationsFor(foodOrderId)).map((a) => [a.payee_type, Number(a.amount_pesewas)])
      );
      assert.equal(ledger.VENDOR, 3500, 'the vendor IS owed for food they sold');
      assert.equal(ledger.PLATFORM, 175 + DELIVERY_FEE);
    });
  });

  // =========================================================================
  // SCENARIO 3 — nobody accepts
  // =========================================================================
  test('when the search expires the scan is NOT marked redeemed', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    await asService((c) =>
      c.query(
        `update public.orders set search_deadline_at = now() - interval '1 minute' where id = $1`,
        [orderId]
      )
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    const order = await getOrder(orderId);
    assert.equal(order.delivery_status, 'FAILED_NO_PARTNER');
    assert.equal(order.scan_status, 'UPLOADED', 'an unredeemed scan stays unredeemed');
    assert.equal(order.partner_id, null);

    const scan = await asService(
      async (c) =>
        (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows[0]
    );
    assert.equal(scan.redeemed_at, null);
    assert.equal(scan.released_to, null, 'nobody ever held it');
  });

  // =========================================================================
  // SCENARIO 4 — two Partners race
  // =========================================================================
  test('two Partners race and exactly one is assigned the scan', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const results = await Promise.allSettled([
      acceptAs(ACTORS.partnerYaw, orderId),
      acceptAs(ACTORS.partnerAdjoa, orderId),
    ]);

    const won = results.filter((r) => r.status === 'fulfilled' && r.value.success === true);
    assert.equal(won.length, 1, 'exactly one Partner takes the errand');

    const order = await getOrder(orderId);
    const scan = await asService(
      async (c) =>
        (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows[0]
    );
    assert.equal(scan.released_to, order.partner_id, 'released to the winner, and only the winner');
  });

  // =========================================================================
  // SCENARIO 6 — double redemption
  // =========================================================================
  test('a scan order cannot be redeemed twice through this workflow', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);

    const first = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_report_scan_redeemed($1)', [orderId])).rows[0],
      { commit: true }
    );
    assert.equal(first.success, true);

    const second = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_report_scan_redeemed($1)', [orderId])).rows[0],
      { commit: true }
    );
    // A state failure returns; it does not raise. Hard rule 9.
    assert.equal(second.success, false);
    assert.match(second.reason, /not in a state that can be redeemed/i);

    // And the rejection is on the record.
    const rejected = await asService(
      async (c) =>
        (
          await c.query(
            `select count(*)::int n from public.order_events
              where order_id = $1 and event = 'SCAN_REDEEMED' and accepted = false`,
            [orderId]
          )
        ).rows[0].n
    );
    assert.equal(rejected, 1, 'the refused second attempt is logged, not silently dropped');
  });

  // =========================================================================
  // SCENARIO 7 — the restaurant will not honour it
  // =========================================================================
  test('a refused scan is recorded and moves no money on its own', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);

    const refused = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (
          await c.query('select * from public.partner_report_scan_refused($1, $2)', [
            orderId,
            'the counter said this scan was already used today',
          ])
        ).rows[0],
      { commit: true }
    );
    assert.equal(refused.success, true);

    const order = await getOrder(orderId);
    assert.equal(order.scan_status, 'REFUSED');
    assert.equal(order.delivery_status, 'ASSIGNED', 'the delivery is not silently failed');
    assert.equal(order.payment_status, 'PAID', 'NO automatic refund — an admin decides');

    // The ledger is untouched by a refusal. There is no policy that says who
    // should be paid here, so nothing pretends there is one.
    const after = await allocationsFor(orderId);
    assert.deepEqual(
      after.map((a) => [a.payee_type, Number(a.amount_pesewas)]),
      [['PLATFORM', SCAN_FEE + DELIVERY_FEE]]
    );

    const scan = await asService(
      async (c) =>
        (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows[0]
    );
    assert.ok(scan.refused_at);
    assert.match(scan.refusal_reason, /already used/);
    assert.equal(scan.redeemed_at, null);
  });

  test('a refused scan cannot then be redeemed', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select * from public.partner_report_scan_refused($1, $2)', [orderId, 'no']),
      { commit: true }
    );

    const attempt = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_report_scan_redeemed($1)', [orderId])).rows[0],
      { commit: true }
    );
    assert.equal(attempt.success, false);
  });

  // =========================================================================
  // REDEMPTION IS NOT ACCEPTANCE
  // =========================================================================
  test('accepting the errand does not redeem the scan, and does not deliver it', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);
    await acceptAs(ACTORS.partnerYaw, orderId);

    const order = await getOrder(orderId);
    assert.equal(order.scan_status, 'RELEASED', 'released to read — not redeemed');
    assert.equal(order.delivery_status, 'ASSIGNED');

    const code = await asService(
      async (c) =>
        (
          await c.query('select delivery_code from public.order_secrets where order_id = $1', [
            orderId,
          ])
        ).rows[0].delivery_code
    );

    // Completion requires PICKED_UP, and for a scan order the only road to
    // PICKED_UP is an explicit redemption report.
    const early = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_complete_delivery($1, $2)', [orderId, code]))
          .rows[0],
      { commit: true }
    );
    assert.equal(early.success, false, 'you cannot deliver food you never collected');
  });

  // =========================================================================
  // SCENARIO 5 + §22 — who may read the scan
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

    test('the assigned Partner can read it, and an unassigned one cannot', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      assert.equal(await pathAs(ACTORS.partnerYaw, orderId), scanPath());
      assert.equal(
        await pathAs(ACTORS.partnerAdjoa, orderId),
        null,
        'Partner B never gets what Partner A was assigned'
      );
    });

    test('a Partner loses the scan the moment the assignment does', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);
      assert.equal(await pathAs(ACTORS.partnerYaw, orderId), scanPath());

      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_reassign_delivery($1, $2)', [
            orderId,
            'partner unreachable',
          ]),
        { commit: true }
      );

      assert.equal(
        await pathAs(ACTORS.partnerYaw, orderId),
        null,
        'the previous Partner keeps nothing'
      );
      const order = await getOrder(orderId);
      assert.equal(order.scan_status, 'UPLOADED', 'and the scan is unreleased again');
    });

    test('an administrator can read it', async () => {
      const { order_id: orderId } = await submitScan();
      assert.equal(await pathAs(ACTORS.admin, orderId), scanPath());
    });

    test('the vendor cannot read it, even their own restaurant’s order', async () => {
      const { order_id: orderId } = await submitScan();
      assert.equal(await pathAs(ACTORS.vendor1Staff, orderId), null);
    });

    test('anon cannot reach the function at all', async () => {
      const { order_id: orderId } = await submitScan();
      const error = await expectRejection(
        asAnon((c) => c.query('select public.scan_image_path($1)', [orderId]))
      );
      assert.match(error.message, /permission denied|does not exist/i);
    });

    test('the row itself is unreadable to everyone but those three', async () => {
      const { order_id: orderId } = await submitScan();
      const rowsFor = (userId) =>
        asUser(
          userId,
          async (c) =>
            (await c.query('select * from public.order_scans where order_id = $1', [orderId])).rows
        );

      assert.equal((await rowsFor(ACTORS.customerAma)).length, 1);
      assert.equal((await rowsFor(ACTORS.customerKwesi)).length, 0);
      assert.equal((await rowsFor(ACTORS.partnerAdjoa)).length, 0);
      assert.equal((await rowsFor(ACTORS.vendor1Staff)).length, 0);
      assert.equal((await rowsFor(ACTORS.admin)).length, 1);
    });
  });

  // =========================================================================
  // §22 — the rest of the attack surface
  // =========================================================================
  describe('authorisation', () => {
    test('a scan path belonging to someone else cannot be attached to an order', async () => {
      const error = await expectRejection(
        submitScan({ customer: ACTORS.customerAma, path: scanPath(ACTORS.customerKwesi) })
      );
      assert.match(error.message, /does not belong to this account/i);
    });

    test('an account without the Customer capability cannot create a scan order', async () => {
      // The admin holds no customer_profiles row in the seed.
      const error = await expectRejection(submitScan({ customer: ACTORS.admin }));
      assert.match(error.message, /student details/i);
    });

    test('a scan order cannot be created without a scan', async () => {
      const error = await expectRejection(submitScan({ path: '   ' }));
      assert.match(error.message, /scan is required|does not belong/i);
    });

    test('a customer cannot mark their own scan redeemed', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.partner_report_scan_redeemed($1)', [orderId])
        )
      );
      assert.match(error.message, /not assigned to you/i);
    });

    test('an unassigned Partner cannot mark it redeemed', async () => {
      const { order_id: orderId } = await submitScan();
      await payScan(orderId);
      await acceptAs(ACTORS.partnerYaw, orderId);

      const error = await expectRejection(
        asUser(ACTORS.partnerAdjoa, (c) =>
          c.query('select * from public.partner_report_scan_redeemed($1)', [orderId])
        )
      );
      assert.match(error.message, /not assigned to you/i);
    });

    test('the food-order redemption call is refused on a food order', async () => {
      const { rows } = await asUser(
        ACTORS.customerAma,
        async (c) =>
          c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
            VENDORS.one,
            'DELIVERY',
            JSON.stringify([{ menu_item_id: '30000000-0000-4000-8000-000000000001', quantity: 1 }]),
            LOCATIONS.room204,
            null,
          ]),
        { commit: true }
      );
      const foodOrderId = rows[0].order_id;

      const error = await expectRejection(
        asUser(ACTORS.partnerYaw, (c) =>
          c.query('select * from public.partner_report_scan_redeemed($1)', [foodOrderId])
        )
      );
      assert.match(error.message, /not assigned to you|not a scan delivery/i);
    });

    test('nobody can write to order_scans directly', async () => {
      const { order_id: orderId } = await submitScan();
      for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.admin]) {
        const error = await expectRejection(
          asUser(actor, (c) =>
            c.query('update public.order_scans set released_to = $1 where order_id = $2', [
              actor,
              orderId,
            ])
          )
        );
        assert.match(error.message, /permission denied/i);
      }
    });

    test('a customer cannot change the fees on their own scan order', async () => {
      const { order_id: orderId } = await submitScan();
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('update public.orders set service_fee_pesewas = 0 where id = $1', [orderId])
        )
      );
      assert.match(error.message, /permission denied/i);
    });
  });

  // =========================================================================
  // CONFLICT OF INTEREST — unchanged rules, applied to a new order type
  // =========================================================================
  describe('conflict of interest', () => {
    test('a Partner cannot deliver their own scan order', async () => {
      // Yaw holds both Customer and Partner capabilities.
      const { order_id: orderId } = await submitScan({ customer: ACTORS.partnerYaw });
      await payScan(orderId);

      const offers = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
      );
      assert.equal(
        offers.some((o) => o.order_id === orderId),
        false,
        'your own errand is not offered to you'
      );

      const error = await expectRejection(
        asUser(ACTORS.partnerYaw, (c) =>
          c.query('select * from public.partner_accept_delivery($1)', [orderId])
        )
      );
      assert.match(error.message, /order you placed yourself/i);
    });

    test('a Partner cannot deliver a scan order from a restaurant they staff', async () => {
      await asService((c) =>
        c.query('insert into public.vendor_users (vendor_id, user_id) values ($1, $2)', [
          VENDORS.wafflemania,
          ACTORS.partnerYaw,
        ])
      );
      try {
        const { order_id: orderId } = await submitScan();
        await payScan(orderId);

        const error = await expectRejection(
          asUser(ACTORS.partnerYaw, (c) =>
            c.query('select * from public.partner_accept_delivery($1)', [orderId])
          )
        );
        assert.match(error.message, /vendor you work for/i);
      } finally {
        await asService((c) =>
          c.query('delete from public.vendor_users where vendor_id = $1 and user_id = $2', [
            VENDORS.wafflemania,
            ACTORS.partnerYaw,
          ])
        );
      }
    });
  });

  // =========================================================================
  // THE VENDOR IS NOT INVOLVED
  // =========================================================================
  test('a scan order never appears on the restaurant’s board', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const board = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.vendor_order_board($1, 20)', [VENDORS.wafflemania]))
          .rows
    );
    assert.equal(
      board.some((r) => r.order_id === orderId),
      false,
      'there is nothing for the restaurant to do'
    );
  });

  // =========================================================================
  // THE PARTNER'S OFFER
  // =========================================================================
  test('a scan errand is labelled as one, and says the food is not ready yet', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const offer = await asUser(ACTORS.partnerYaw, async (c) =>
      (await c.query('select * from public.get_delivery_offers()')).rows.find(
        (o) => o.order_id === orderId
      )
    );

    assert.ok(offer, 'the errand is offered');
    assert.equal(offer.order_type, 'SCAN');
    assert.equal(offer.food_is_ready, false, 'nobody has cooked anything yet');
    assert.equal(Number(offer.earnings_pesewas), DELIVERY_FEE);
    assert.equal(offer.vendor_name, 'Wafflemania (test)');
    // The offer carries no scan and no room number.
    assert.equal(Object.hasOwn(offer, 'image_path'), false);
  });

  // =========================================================================
  // ADMIN
  // =========================================================================
  test('an admin sees the scan order without being shown the image', async () => {
    const { order_id: orderId } = await submitScan();
    await payScan(orderId);

    const row = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_scan_order($1)', [orderId])).rows[0]
    );

    assert.equal(row.scan_status, 'UPLOADED');
    assert.equal(row.restaurant_name, 'Wafflemania (test)');
    assert.equal(row.has_scan_image, true, 'existence is reported…');
    assert.equal(Object.hasOwn(row, 'image_path'), false, '…but the path is not');
    assert.equal(Number(row.service_fee_pesewas), SCAN_FEE);
    assert.equal(Number(row.total_pesewas), SCAN_FEE + DELIVERY_FEE);
  });

  // =========================================================================
  // INFRASTRUCTURE — the things that go wrong silently
  // =========================================================================
  describe('scan infrastructure', () => {
    /**
     * The regression this migration actually caused once.
     *
     * DROP FUNCTION discards the REVOKE that was applied to the old definition,
     * and CREATE hands EXECUTE back to PUBLIC. Recreating these three without
     * re-granting made get_delivery_offers() — the live dispatch queue — and
     * admin_update_config() anon-callable. Asserted here by name so the next
     * person who drops one of them finds out immediately.
     */
    test('every function this migration dropped and recreated is closed to anon', async () => {
      const dropped = ['get_delivery_offers', 'admin_update_config', 'partner_active_delivery'];

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
        // Postgres stores `set search_path = ''` as the setting `search_path=""`.
        // An unpinned SECURITY DEFINER function resolves names against the
        // caller's search_path, which is how a shadowed table becomes a
        // privilege escalation.
        const pinned = (fn.proconfig ?? []).some((setting) => setting.startsWith('search_path='));
        assert.ok(pinned, `${fn.proname} must pin an empty search_path`);
      }
    });

    /**
     * A fresh hosted project must be priced correctly on day one.
     *
     * supabase/schema.sql installs pricing_config by naming only the columns
     * that have no default, letting defaults carry everything else. A nullable
     * scan fee with no default would therefore install as NULL and
     * price_scan_order() would refuse to quote on a brand-new project. The
     * column default is the only thing standing between a new deployment and a
     * scan feature that silently does not work.
     */
    test('the scan fee has a column default, so a fresh install is priced', async () => {
      const column = await asService(
        async (c) =>
          (
            await c.query(`
              select column_default, is_nullable
                from information_schema.columns
               where table_schema = 'public'
                 and table_name = 'pricing_config'
                 and column_name = 'scan_service_fee_pesewas'
            `)
          ).rows[0]
      );

      assert.ok(column, 'the column exists');
      assert.match(String(column.column_default), /200/, 'defaults to GH₵2.00');
      assert.equal(column.is_nullable, 'YES', 'and null stays expressible as "unpriced"');
    });

    test('the scan-documents bucket is private and has no storage policies', async () => {
      const bucket = await asService(
        async (c) =>
          (await c.query("select * from storage.buckets where id = 'scan-documents'")).rows[0]
      );
      assert.ok(bucket, 'the bucket exists');
      assert.equal(bucket.public, false, 'a meal voucher is never publicly readable');

      // No policy means RLS denies every client read and write. That is the
      // whole protection — the service role is the only thing that touches a
      // file, and it hands out short-lived signed URLs instead.
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
