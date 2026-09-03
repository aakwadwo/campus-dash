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

/**
 * The platform service fee: 5% of the FOOD subtotal.
 *
 * Three claims, and the third is the one that only became interesting when the
 * rate halved:
 *
 *   1. the fee is a percentage of the FOOD, never of the delivery fee and never
 *      of the total — so the vendor's entitlement and the Partner's are
 *      untouched by the rate;
 *   2. the arithmetic is integer pesewas throughout, rounded HALF-UP;
 *   3. at 10% a basket priced in whole cedis could never produce a fraction of
 *      a pesewa. At 5% it can — a subtotal that is an odd multiple of ten
 *      pesewas lands exactly on .5 — so the rounding rule is now load-bearing
 *      for prices a vendor might plausibly set.
 *
 * The seeded menu is priced in whole cedis, which cannot exercise (3). So the
 * fractional cases set a real price through the real admin RPC and quote a real
 * basket, INSIDE A TRANSACTION THAT ROLLS BACK — nothing here leaks into the
 * catalogue the other suites share.
 */
describe('the 5% platform service fee', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const quote = (items, fulfilment = 'PICKUP') =>
    asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.quote_order($1, $2, $3::jsonb, $4)', [
            VENDORS.one,
            fulfilment,
            JSON.stringify(items),
            fulfilment === 'DELIVERY' ? LOCATIONS.room204 : null,
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
      const { rows } = await c.query('select * from public.quote_order($1, $2, $3::jsonb, null)', [
        VENDORS.one,
        'PICKUP',
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
      ]);
      return rows[0];
    });

  // =========================================================================
  // The rate
  // =========================================================================
  test('the configured rate is 500 basis points', async () => {
    const config = await asService(
      async (c) => (await c.query('select * from public.platform_config()')).rows[0]
    );
    assert.equal(config.service_fee_bps, 500, '5%, in basis points');
    assert.equal(config.delivery_fee_pesewas, 500, 'the flat GH₵5 delivery fee is unchanged');
  });

  test('the fee is 5% of the food, and the delivery fee is not part of the base', async () => {
    const pickup = await quote([{ menu_item_id: MENU.jollof, quantity: 1 }]);
    const delivery = await quote([{ menu_item_id: MENU.jollof, quantity: 1 }], 'DELIVERY');

    assert.equal(pickup.subtotal_pesewas, 3500);
    assert.equal(pickup.service_fee_pesewas, 175, '5% of GH₵35');
    assert.equal(delivery.subtotal_pesewas, 3500);
    assert.equal(
      delivery.service_fee_pesewas,
      175,
      'the SAME fee — adding GH₵5 of delivery does not add to the base'
    );
    assert.equal(delivery.delivery_fee_pesewas, 500);
    assert.equal(delivery.total_pesewas, 3500 + 175 + 500);
  });

  test('the worked example from the brief: GH₵25 food, GH₵1.25 fee', async () => {
    const q = await quoteAtPrice(2500);
    assert.equal(q.subtotal_pesewas, 2500, 'the vendor is entitled to all of it');
    assert.equal(q.service_fee_pesewas, 125, '5% of GH₵25.00');
    assert.equal(q.total_pesewas, 2625, 'pickup: food + fee');
  });

  test('the rate scales with the basket, rather than being flat', async () => {
    const one = await quote([{ menu_item_id: MENU.jollof, quantity: 1 }]);
    const three = await quote([{ menu_item_id: MENU.jollof, quantity: 3 }]);
    assert.equal(one.service_fee_pesewas, 175);
    assert.equal(three.service_fee_pesewas, 525, 'three times the food, three times the fee');
  });

  // =========================================================================
  // Rounding — the cases 5% creates and 10% never could
  // =========================================================================
  test('a fee landing exactly on half a pesewa rounds UP', async () => {
    // 5% of 2510 is 125.5. Half-up gives 126, and the customer pays a pesewa
    // more rather than Campus Dash quietly eating it.
    const q = await quoteAtPrice(2510);
    assert.equal(q.subtotal_pesewas, 2510);
    assert.equal(q.service_fee_pesewas, 126, '125.5 rounds up, never down or toward even');
    assert.equal(q.total_pesewas, 2636);
  });

  test('every half-pesewa case in a run of prices rounds up', async () => {
    // A subtotal that is an odd multiple of 10 pesewas always lands on .5 at 5%.
    for (const [price, fee] of [
      [10, 1], // 0.5  -> 1
      [30, 2], // 1.5  -> 2
      [50, 3], // 2.5  -> 3
      [1990, 100], // 99.5 -> 100
      [3330, 167], // 166.5 -> 167
    ]) {
      const q = await quoteAtPrice(price);
      assert.equal(q.service_fee_pesewas, fee, `5% of ${price} should be ${fee}`);
    }
  });

  test('a fee below half a pesewa rounds down, including to nothing', async () => {
    for (const [price, fee] of [
      [1, 0], // 0.05 -> 0. A one-pesewa item owes no fee, and that is correct.
      [9, 0], // 0.45 -> 0
      [11, 1], // 0.55 -> 1
      [2504, 125], // 125.2 -> 125
      [2516, 126], // 125.8 -> 126
    ]) {
      const q = await quoteAtPrice(price);
      assert.equal(q.service_fee_pesewas, fee, `5% of ${price} should be ${fee}`);
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
    const q = await quote([{ menu_item_id: MENU.jollof, quantity: 2 }], 'DELIVERY');

    assert.equal(q.subtotal_pesewas, 7000, 'the vendor entitlement is the food, in full');
    assert.equal(q.service_fee_pesewas, 350, 'and the platform takes 5% ON TOP');
    assert.equal(q.delivery_fee_pesewas, config.delivery_fee_pesewas, "the Partner's, in full");
    assert.equal(
      q.total_pesewas,
      q.subtotal_pesewas + q.service_fee_pesewas + q.delivery_fee_pesewas,
      'the customer pays the sum of three separate entitlements'
    );
  });
});
