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
import { acceptedOrder, getOrder } from './helpers/flow.js';

/**
 * The platform service fee: 6.95% of the FOOD subtotal.
 *
 * Three claims, and the third is the one that only became interesting when the
 * rate halved:
 *
 *   1. the fee is a percentage of the FOOD, never of the delivery fee and never
 *      of the total — so the vendor's entitlement and the Partner's are
 *      untouched by the rate;
 *   2. the arithmetic is integer pesewas throughout, rounded HALF-UP;
 *   3. at 10% a basket priced in whole cedis could never produce a fraction of
 *      a pesewa. At 6.95% it can — a subtotal that is an odd multiple of ten
 *      pesewas lands exactly on .5 — so the rounding rule is now load-bearing
 *      for prices a vendor might plausibly set.
 *
 * The seeded menu is priced in whole cedis, which cannot exercise (3). So the
 * fractional cases set a real price through the real admin RPC and quote a real
 * basket, INSIDE A TRANSACTION THAT ROLLS BACK — nothing here leaks into the
 * catalogue the other suites share.
 */
describe('the 6.95% platform service fee', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  /**
   * A quote is FOOD plus the 6.95% fee, and nothing else.
   *
   * There is no fulfilment argument any more: pickup or delivery is chosen
   * after the vendor accepts, so a basket quote cannot know a delivery fee and
   * does not pretend to. That is also why the fee base is unambiguous here —
   * the delivery fee is not in the quote at all.
   */
  const quote = (items) =>
    asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.quote_order($1, $2::jsonb)', [
            VENDORS.one,
            JSON.stringify(items),
          ])
        ).rows[0]
    );

  /**
   * Prices one jollof at `price`, quotes a single-item pickup basket, and rolls
   * the whole thing back. The price change, the admin_actions row it writes and
   * the quote all vanish with the transaction.
   */
  const quoteAtPrice = (price) =>
    asUser(ACTORS.admin, async (c) => {
      await c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
        MENU.jollof,
        'rounding fixture',
        price,
      ]);
      const { rows } = await c.query('select * from public.quote_order($1, $2::jsonb)', [
        VENDORS.one,
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
      ]);
      return rows[0];
    });

  // =========================================================================
  // The rate
  // =========================================================================
  test('the configured rate is 695 basis points', async () => {
    const config = await asService(
      async (c) => (await c.query('select * from public.platform_config()')).rows[0]
    );
    assert.equal(config.service_fee_bps, 695, '6.95%, in basis points');
    assert.equal(config.delivery_fee_pesewas, 500, 'the flat GH₵5 delivery fee is unchanged');
  });

  test('the fee is 6.95% of the food, and the delivery fee is not part of the base', async () => {
    // A quote is food + fee. The delivery fee is not in the base and cannot be:
    // it is added at the fulfilment choice, from the same snapshot, and the
    // service fee is never recomputed there.
    const basket = await quote([{ menu_item_id: MENU.jollof, quantity: 1 }]);
    assert.equal(basket.subtotal_pesewas, 3500);
    assert.equal(basket.service_fee_pesewas, 243, '6.95% of GH₵35');
    assert.equal(basket.total_pesewas, 3743);

    const order = await acceptedOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilment: 'DELIVERY',
    });
    const stored = await getOrder(order.order_id);
    assert.equal(stored.subtotal_pesewas, 3500);
    assert.equal(
      stored.service_fee_pesewas,
      243,
      'the SAME fee — adding GH₵5 of delivery does not add to the base'
    );
    assert.equal(stored.delivery_fee_pesewas, 500);
    assert.equal(stored.total_pesewas, 3500 + 243 + 500);
  });

  test('the worked example from the brief: GH₵25 food, GH₵1.74 fee', async () => {
    const q = await quoteAtPrice(2500);
    assert.equal(q.subtotal_pesewas, 2500, 'the vendor is entitled to all of it');
    assert.equal(q.service_fee_pesewas, 174, '6.95% of GH₵25.00');
    assert.equal(q.total_pesewas, 2674, 'pickup: food + fee');
  });

  test('the rate scales with the basket, rather than being flat', async () => {
    const one = await quote([{ menu_item_id: MENU.jollof, quantity: 1 }]);
    const three = await quote([{ menu_item_id: MENU.jollof, quantity: 3 }]);
    assert.equal(one.service_fee_pesewas, 243);
    assert.equal(three.service_fee_pesewas, 730, 'three times the food, three times the fee');
  });

  // =========================================================================
  // Rounding — the cases a fractional rate creates and a whole one never could
  // =========================================================================
  test('a fee landing exactly on half a pesewa rounds UP', async () => {
    // 6.95% of 5000 is 347.5. Half-up gives 348, and the customer pays a pesewa
    // more rather than Campus Dash quietly eating it.
    const q = await quoteAtPrice(5000);
    assert.equal(q.subtotal_pesewas, 5000);
    assert.equal(q.service_fee_pesewas, 348, '347.5 rounds up, never down or toward even');
    assert.equal(q.total_pesewas, 5348);
  });

  test('every half-pesewa case in a run of prices rounds up', async () => {
    // WHICH SUBTOTALS LAND ON .5 IS A PROPERTY OF THE RATE, so this table is
    // recomputed whenever the rate moves. At 6.95% the exact half-pesewa cases
    // are the odd multiples of 1000: 695 × 1000 = 695000, and 695000 mod 10000
    // = 5000. At 5% they were the odd multiples of 10, which is why the old
    // table looked nothing like this one.
    for (const [price, fee] of [
      [1000, 70], // 69.5  -> 70
      [3000, 209], // 208.5 -> 209
      [5000, 348], // 347.5 -> 348
      [7000, 487], // 486.5 -> 487
      [9000, 626], // 625.5 -> 626
    ]) {
      const q = await quoteAtPrice(price);
      assert.equal(q.service_fee_pesewas, fee, `6.95% of ${price} should be ${fee}`);
    }
  });

  test('a fee below half a pesewa rounds down, including to nothing', async () => {
    for (const [price, fee] of [
      [1, 0], // 0.070 -> 0
      [7, 0], // 0.486 -> 0
      [8, 1], // 0.556 -> 1
      [2504, 174], // 174.028 -> 174
      [2516, 175], // 174.862 -> 175
    ]) {
      const q = await quoteAtPrice(price);
      assert.equal(q.service_fee_pesewas, fee, `6.95% of ${price} should be ${fee}`);
    }
  });

  test('the fee is always a whole number of pesewas', async () => {
    for (const price of [1, 7, 13, 99, 2501, 2510, 3333, 9999]) {
      const q = await quoteAtPrice(price);
      assert.ok(
        Number.isInteger(q.service_fee_pesewas),
        `${price} produced ${q.service_fee_pesewas}`
      );
      assert.equal(
        q.total_pesewas,
        q.subtotal_pesewas + q.service_fee_pesewas,
        'and the total is the exact sum of integers'
      );
    }
  });

  test('the rounding fixtures left the catalogue untouched', async () => {
    // Every quoteAtPrice above rolled back. If one had not, this is where a
    // silently repriced menu would surface for every other suite.
    const item = await asService(
      async (c) =>
        (await c.query('select price_pesewas from public.menu_items where id = $1', [MENU.jollof]))
          .rows[0]
    );
    assert.equal(item.price_pesewas, 3500, 'jollof is still GH₵35');
  });

  // =========================================================================
  // Halving the rate takes money from Campus Dash and from nobody else
  // =========================================================================
  test('the vendor is entitled to the whole food subtotal, whatever the rate', async () => {
    const config = await asService(
      async (c) => (await c.query('select * from public.platform_config()')).rows[0]
    );
    const order = await acceptedOrder({
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'DELIVERY',
    });
    const q = await getOrder(order.order_id);

    assert.equal(q.subtotal_pesewas, 7000, 'the vendor entitlement is the food, in full');
    assert.equal(q.service_fee_pesewas, 487, 'and the platform takes 5% ON TOP');
    assert.equal(q.delivery_fee_pesewas, config.delivery_fee_pesewas, "the Partner's, in full");
    assert.equal(
      q.total_pesewas,
      q.subtotal_pesewas + q.service_fee_pesewas + q.delivery_fee_pesewas,
      'the customer pays the sum of three separate entitlements'
    );
  });
});
