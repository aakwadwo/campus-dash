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
  MENU,
  SCAN_MENU,
} from './helpers/db.js';
import { submitOrder, submitScanOrder, payOrder, expectRejection } from './helpers/flow.js';

/**
 * A price the customer chooses.
 *
 * THREE MODES ON ONE ITEM COLUMN. FIXED is every item there has ever been.
 * STEPPED is a rule — a starting price, a step, and an optional ceiling.
 * CHOICES is a list of exact prices with no pattern. The last two are
 * "variable", sellable only at a store an administrator has given the
 * capability to, and never with a Meal Scan.
 *
 * WHAT THIS FILE IS REALLY ABOUT is that the price in the basket is a CLAIM.
 * menu_item_unit_price() is the only thing that turns it into money, and every
 * test that sends a price is checking that it is refused unless it is exactly
 * on the item's rule or list — never rounded to the nearest one that is.
 */
describe('variable pricing', () => {
  const PREFIX = 'VP test ';

  async function cleanUp() {
    await resetTransactionalState();
    await asService(async (c) => {
      await c.query('delete from public.menu_items where name like $1', [`${PREFIX}%`]);
      await c.query('update public.vendors set can_use_variable_pricing = false');
    });
  }

  before(cleanUp);
  beforeEach(cleanUp);
  after(async () => {
    await cleanUp();
    await closePools();
  });

  // --- helpers ---------------------------------------------------------------

  const setCapability = (vendorId, enabled, actor = ACTORS.admin) =>
    asUser(
      actor,
      async (c) =>
        (
          await c.query('select * from public.admin_set_vendor_variable_pricing($1, $2, $3)', [
            vendorId,
            enabled,
            'Agreed with the store',
          ])
        ).rows[0],
      { commit: true }
    );

  const createItem = (
    {
      vendorId = VENDORS.one,
      name = 'Kelewele',
      price = null,
      mode = 'STEPPED',
      min = null,
      step = null,
      max = null,
      choices = null,
      scan = false,
    } = {},
    staff = ACTORS.vendor1Staff
  ) =>
    asUser(
      staff,
      async (c) =>
        (
          await c.query(
            `select * from public.vendor_create_menu_item(
               p_vendor_id => $1, p_name => $2, p_price_pesewas => $3,
               p_scan_eligible => $4, p_pricing_mode => $5,
               p_variable_min_pesewas => $6, p_variable_step_pesewas => $7,
               p_variable_max_pesewas => $8, p_variable_choices_pesewas => $9)`,
            [vendorId, PREFIX + name, price, scan, mode, min, step, max, choices]
          )
        ).rows[0],
      { commit: true }
    );

  const updateItem = (id, fields, staff = ACTORS.vendor1Staff) => {
    const names = Object.keys(fields);
    const args = names.map((key, i) => `${key} => $${i + 2}`).join(', ');
    return asUser(
      staff,
      async (c) =>
        (
          await c.query(
            `select * from public.vendor_update_menu_item(p_menu_item_id => $1${
              args ? `, ${args}` : ''
            })`,
            [id, ...Object.values(fields)]
          )
        ).rows[0],
      { commit: true }
    );
  };

  const activate = (id, staff = ACTORS.vendor1Staff) =>
    asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_set_menu_item_active($1, true)', [id])).rows[0],
      { commit: true }
    );

  const item = (id) =>
    asService(
      async (c) => (await c.query('select * from public.menu_items where id = $1', [id])).rows[0]
    );

  const quote = (items, vendorId = VENDORS.one, customer = ACTORS.customerAma) =>
    asUser(
      customer,
      async (c) =>
        (
          await c.query("select * from public.quote_order($1, $2::jsonb, 'PICKUP')", [
            vendorId,
            JSON.stringify(items),
          ])
        ).rows[0]
    );

  const order = (items, vendorId = VENDORS.one) =>
    submitOrder({ vendorId, items, fulfilment: 'PICKUP', destination: null });

  const lines = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select menu_item_id, unit_price_pesewas, quantity, line_total_pesewas from public.order_items where order_id = $1',
            [orderId]
          )
        ).rows
    );

  const orderRow = (orderId) =>
    asService(
      async (c) => (await c.query('select * from public.orders where id = $1', [orderId])).rows[0]
    );

  const serviceFee = async (subtotal) => {
    const bps = await asService(
      async (c) =>
        (await c.query('select service_fee_bps from public.pricing_config where id')).rows[0]
          .service_fee_bps
    );
    return Math.floor((subtotal * bps + 5000) / 10000);
  };

  /** A sellable STEPPED kelewele: GH₵10, then every GH₵5. */
  async function stepped({ max = null, vendorId = VENDORS.one, staff } = {}) {
    await setCapability(vendorId, true);
    const created = await createItem({ vendorId, min: 1000, step: 500, max }, staff);
    await activate(created.id, staff);
    return created;
  }

  /** A sellable CHOICES item: GH₵10, GH₵15, GH₵30, GH₵50 and nothing else. */
  async function choices() {
    await setCapability(VENDORS.one, true);
    const created = await createItem({
      name: 'Waakye special',
      mode: 'CHOICES',
      choices: [5000, 1000, 3000, 1500],
    });
    await activate(created.id);
    return created;
  }

  const line = (id, price, quantity = 1) => ({
    menu_item_id: id,
    quantity,
    ...(price === undefined ? {} : { unit_price_pesewas: price }),
  });

  // ===========================================================================
  // FIXED PRICES ARE UNTOUCHED
  // ===========================================================================

  test('an existing fixed-price order is priced exactly as before', async () => {
    const placed = await order([line(MENU.jollof, undefined, 2)]);
    const [snapshot] = await lines(placed.order_id);
    assert.equal(snapshot.unit_price_pesewas, 3500);
    assert.equal(snapshot.line_total_pesewas, 7000);

    const row = await orderRow(placed.order_id);
    assert.equal(row.subtotal_pesewas, 7000);
    assert.equal(row.service_fee_pesewas, await serviceFee(7000));
    assert.equal(row.total_pesewas, 7000 + (await serviceFee(7000)));
  });

  test('every existing item is FIXED after the migration', async () => {
    const modes = await asService(
      async (c) =>
        (
          await c.query(
            "select distinct pricing_mode from public.menu_items where name not like 'VP test %'"
          )
        ).rows
    );
    assert.deepEqual(
      modes.map((r) => r.pricing_mode),
      ['FIXED']
    );
  });

  test('a price sent for a fixed item is ignored, as it always was', async () => {
    const placed = await order([line(MENU.jollof, 100)]);
    const [snapshot] = await lines(placed.order_id);
    assert.equal(snapshot.unit_price_pesewas, 3500, 'the menu price, not the sent one');
  });

  // ===========================================================================
  // THE CAPABILITY
  // ===========================================================================

  test('an administrator enables and disables it, and each change is audited', async () => {
    assert.equal((await setCapability(VENDORS.one, true)).can_use_variable_pricing, true);
    assert.equal((await setCapability(VENDORS.one, false)).can_use_variable_pricing, false);

    const audited = await asService(
      async (c) =>
        (
          await c.query(
            "select count(*)::int as n from public.admin_actions where action = 'VENDOR_VARIABLE_PRICING_SET' and target_id = $1",
            [VENDORS.one]
          )
        ).rows[0].n
    );
    assert.equal(audited, 2);
  });

  test('only an administrator can change it: not the store, not a customer', async () => {
    for (const actor of [ACTORS.vendor1Staff, ACTORS.customerAma]) {
      const error = await expectRejection(setCapability(VENDORS.one, true, actor));
      assert.match(error.message, /admin privileges required/);
    }
    const writers = await asService(async (c) =>
      (
        await c.query(
          `select p.proname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and p.prolang <> (select oid from pg_language where lanname = 'internal')
              and pg_get_functiondef(p.oid) ilike '%can_use_variable_pricing =%'`
        )
      ).rows.map((r) => r.proname)
    );
    assert.deepEqual(writers, ['admin_set_vendor_variable_pricing']);
  });

  test('a store without it cannot create or configure a variable item, however the call is built', async () => {
    let error = await expectRejection(createItem({ min: 1000, step: 500 }));
    assert.match(error.message, /not enabled for this store/);

    error = await expectRejection(createItem({ mode: 'CHOICES', choices: [1000, 1500] }));
    assert.match(error.message, /not enabled for this store/);

    const fixed = await createItem({ mode: 'FIXED', price: 2500 });
    error = await expectRejection(
      updateItem(fixed.id, {
        p_pricing_mode: 'STEPPED',
        p_variable_min_pesewas: 1000,
        p_variable_step_pesewas: 500,
      })
    );
    assert.match(error.message, /not enabled for this store/);
    assert.equal((await item(fixed.id)).pricing_mode, 'FIXED');
  });

  // ===========================================================================
  // THE STORE CONFIGURES ITS OWN ITEMS, AND ONLY THOSE
  // ===========================================================================

  test('a store with it configures stepped and choice items, and they sit beside fixed ones', async () => {
    await setCapability(VENDORS.one, true);

    const unlimited = await createItem({ min: 1000, step: 500 });
    assert.equal(unlimited.pricing_mode, 'STEPPED');
    assert.equal(unlimited.variable_max_pesewas, null);

    const limited = await createItem({ name: 'Limited', min: 1000, step: 500, max: 2500 });
    assert.equal(limited.variable_max_pesewas, 2500);

    const list = await createItem({ name: 'List', mode: 'CHOICES', choices: [3000, 1000] });
    assert.deepEqual(list.variable_choices_pesewas.map(Number), [1000, 3000], 'kept ascending');

    const fixed = await createItem({ name: 'Plain', mode: 'FIXED', price: 2500 });
    assert.equal(fixed.pricing_mode, 'FIXED');
    assert.equal(fixed.price_pesewas, 2500);
  });

  test('a maximum must be one of the prices the steps reach', async () => {
    await setCapability(VENDORS.one, true);
    const error = await expectRejection(createItem({ min: 1000, step: 500, max: 2700 }));
    assert.match(error.message, /maximum price must be one of the prices/);
    await expectRejection(createItem({ min: 1000, step: 500, max: 500 }));
    assert.ok(await createItem({ min: 1000, step: 500, max: 2500 }));
  });

  test('nonsensical rules and lists are refused', async () => {
    await setCapability(VENDORS.one, true);
    await expectRejection(createItem({ min: 0, step: 500 }));
    await expectRejection(createItem({ min: 1000, step: 0 }));
    await expectRejection(createItem({ min: -100, step: 500 }));
    await expectRejection(createItem({ min: 1000, step: null }));
    await expectRejection(createItem({ mode: 'CHOICES', choices: [] }));
    await expectRejection(createItem({ mode: 'CHOICES', choices: [1000, 1000] }));
    await expectRejection(createItem({ mode: 'CHOICES', choices: [1000, 0] }));
    await expectRejection(createItem({ mode: 'SOMETHING' }));
  });

  test('a store cannot touch another store’s item', async () => {
    await setCapability(VENDORS.one, true);
    await setCapability(VENDORS.two, true);
    const mine = await createItem({ mode: 'FIXED', price: 2500 });

    const error = await expectRejection(
      updateItem(
        mine.id,
        { p_pricing_mode: 'STEPPED', p_variable_min_pesewas: 100, p_variable_step_pesewas: 100 },
        ACTORS.vendor2Staff
      )
    );
    assert.match(error.message, /not authorised/);

    // Nor create one on its behalf.
    await expectRejection(
      createItem({ vendorId: VENDORS.one, min: 100, step: 100 }, ACTORS.vendor2Staff)
    );
    assert.equal((await item(mine.id)).pricing_mode, 'FIXED');
  });

  test('a customer cannot change any pricing configuration', async () => {
    const kelewele = await stepped();
    const error = await expectRejection(
      updateItem(kelewele.id, { p_variable_min_pesewas: 100 }, ACTORS.customerAma)
    );
    assert.match(error.message, /not authorised/);
    assert.equal((await item(kelewele.id)).variable_min_pesewas, 1000);
  });

  test('an item returns to fixed, and back, without losing its rule', async () => {
    const kelewele = await stepped({ max: 3000 });
    const fixed = await updateItem(kelewele.id, { p_pricing_mode: 'FIXED', p_price_pesewas: 1200 });
    assert.equal(fixed.pricing_mode, 'FIXED');
    assert.equal(fixed.variable_min_pesewas, 1000, 'the rule is kept');

    const back = await updateItem(kelewele.id, { p_pricing_mode: 'STEPPED' });
    assert.equal(back.pricing_mode, 'STEPPED');
    assert.equal(back.variable_max_pesewas, 3000);

    const unlimited = await updateItem(kelewele.id, { p_clear_variable_max: true });
    assert.equal(unlimited.variable_max_pesewas, null);
  });

  // ===========================================================================
  // DISABLING PRESERVES; RE-ENABLING RESTORES
  // ===========================================================================

  test('disabling keeps every configuration, dormant and hidden; enabling brings it back', async () => {
    const kelewele = await stepped({ max: 4000 });
    const list = await choices();
    const before = [await item(kelewele.id), await item(list.id)];

    await setCapability(VENDORS.one, false);
    const during = [await item(kelewele.id), await item(list.id)];
    for (const [a, b] of before.map((row, i) => [row, during[i]])) {
      assert.equal(b.pricing_mode, a.pricing_mode);
      assert.equal(b.variable_min_pesewas, a.variable_min_pesewas);
      assert.equal(b.variable_step_pesewas, a.variable_step_pesewas);
      assert.equal(b.variable_max_pesewas, a.variable_max_pesewas);
      assert.deepEqual(b.variable_choices_pesewas, a.variable_choices_pesewas);
      assert.equal(b.price_pesewas, a.price_pesewas, 'not converted to some fixed price');
    }

    const visible = async () =>
      asAnon(async (c) =>
        (
          await c.query('select id from public.menu_items where id = any($1)', [
            [kelewele.id, list.id],
          ])
        ).rows.map((r) => r.id)
      );
    assert.deepEqual(await visible(), [], 'a dormant item is not on the storefront');

    // Not sold at any price while dormant, and the store cannot configure it.
    await expectRejection(order([line(kelewele.id, 1500)]));
    await expectRejection(order([line(kelewele.id, undefined)]));
    await expectRejection(updateItem(kelewele.id, { p_variable_step_pesewas: 1000 }));

    await setCapability(VENDORS.one, true);
    assert.equal((await visible()).length, 2);
    const placed = await order([line(kelewele.id, 4000), line(list.id, 3000)]);
    assert.equal((await orderRow(placed.order_id)).subtotal_pesewas, 7000);
  });

  test('a basket built before the capability was turned off is refused at submission', async () => {
    const kelewele = await stepped();
    const basket = [line(kelewele.id, 3500)];
    assert.equal((await quote(basket)).subtotal_pesewas, 3500, 'quoted while enabled');

    await setCapability(VENDORS.one, false);
    const error = await expectRejection(order(basket));
    assert.match(error.message, /is unavailable/);
    await expectRejection(quote(basket));
  });

  test('a basket built before the store changed the item is re-checked against the new rule', async () => {
    const list = await choices();
    const basket = [line(list.id, 5000)];
    assert.ok(await quote(basket));

    await updateItem(list.id, { p_variable_choices_pesewas: [1000, 1500] });
    await expectRejection(order(basket));

    // And once it is fixed again, a kept amount buys nothing: the fixed price
    // is charged, whatever the basket still carries.
    await updateItem(list.id, { p_pricing_mode: 'FIXED', p_price_pesewas: 1000 });
    const placed = await order([line(list.id, 5000)]);
    assert.equal((await lines(placed.order_id))[0].unit_price_pesewas, 1000);
  });

  // ===========================================================================
  // STEPPED: MINIMUM, STEP, OPTIONAL MAXIMUM
  // ===========================================================================

  test('stepped, unlimited: every step from the minimum upward, without end', async () => {
    const kelewele = await stepped();
    for (const price of [1000, 1500, 2000, 10000, 10500, 99500, 100000]) {
      assert.equal((await quote([line(kelewele.id, price)])).subtotal_pesewas, price);
    }
  });

  test('stepped, limited: the maximum is the last valid price', async () => {
    const kelewele = await stepped({ max: 2500 });
    for (const price of [1000, 1500, 2000, 2500]) {
      assert.equal((await quote([line(kelewele.id, price)])).subtotal_pesewas, price);
    }
    for (const price of [3000, 3500, 10000]) {
      const error = await expectRejection(quote([line(kelewele.id, price)]));
      assert.match(error.message, /not one of its prices/);
    }
  });

  test('stepped: below the minimum and off the step are refused, never rounded', async () => {
    const kelewele = await stepped();
    for (const price of [900, 1100, 1200, 1400, 1750, 0, -500]) {
      const error = await expectRejection(quote([line(kelewele.id, price)]));
      assert.match(error.message, /not one of its prices/, `GH₵${price / 100}`);
      await expectRejection(order([line(kelewele.id, price)]));
    }
  });

  test('the step comes from the item, not from a constant', async () => {
    await setCapability(VENDORS.one, true);
    const other = await createItem({ name: 'Twenties', min: 2000, step: 1000 });
    await activate(other.id);
    for (const price of [2000, 3000, 4000, 11000]) {
      assert.ok(await quote([line(other.id, price)]));
    }
    await expectRejection(quote([line(other.id, 2500)]));
    await expectRejection(quote([line(other.id, 1000)]));
  });

  // ===========================================================================
  // CHOICES: EXACTLY THE LISTED PRICES
  // ===========================================================================

  test('choices: each listed price is valid, and nothing else is', async () => {
    const list = await choices();
    for (const price of [1000, 1500, 3000, 5000]) {
      assert.equal((await quote([line(list.id, price)])).subtotal_pesewas, price);
    }
    for (const price of [2000, 2500, 3500, 500, 5500, 1001]) {
      const error = await expectRejection(quote([line(list.id, price)]));
      assert.match(error.message, /not one of its prices/, `GH₵${price / 100}`);
      await expectRejection(order([line(list.id, price)]));
    }
  });

  // ===========================================================================
  // MANIPULATED REQUESTS
  // ===========================================================================

  test('a hand-built price is refused in every shape it could arrive in', async () => {
    const kelewele = await stepped();
    for (const bad of [1250.5, '1500', null, true, { amount: 1500 }, [1500]]) {
      await expectRejection(order([line(kelewele.id, bad)]));
    }
    // No price at all for a variable item is not "use the minimum".
    const error = await expectRejection(order([line(kelewele.id, undefined)]));
    assert.match(error.message, /choose an amount/);
  });

  test('another store’s variable item cannot be bought through this store', async () => {
    const kelewele = await stepped();
    await setCapability(VENDORS.two, true);
    const error = await expectRejection(order([line(kelewele.id, 1500)], VENDORS.two));
    assert.match(error.message, /is unavailable/);
  });

  // ===========================================================================
  // THE CHOSEN PRICE FLOWS INTO THE ORDER, THE CHARGE AND THE LEDGER
  // ===========================================================================

  test('the chosen price is the snapshot, times the quantity, and the payment is the total', async () => {
    const kelewele = await stepped();
    const list = await choices();

    const basket = [
      line(kelewele.id, 3500, 2),
      line(list.id, 1500, 3),
      line(MENU.jollof, undefined, 1),
    ];
    const quoted = await quote(basket);
    const placed = await order(basket);

    const snapshot = Object.fromEntries(
      (await lines(placed.order_id)).map((l) => [l.menu_item_id, l])
    );
    assert.equal(snapshot[kelewele.id].unit_price_pesewas, 3500);
    assert.equal(snapshot[kelewele.id].line_total_pesewas, 7000);
    assert.equal(snapshot[list.id].unit_price_pesewas, 1500);
    assert.equal(snapshot[list.id].line_total_pesewas, 4500);
    assert.equal(snapshot[MENU.jollof].unit_price_pesewas, 3500);

    const subtotal = 7000 + 4500 + 3500;
    const fee = await serviceFee(subtotal);
    const row = await orderRow(placed.order_id);
    assert.equal(row.subtotal_pesewas, subtotal);
    assert.equal(row.service_fee_pesewas, fee);
    assert.equal(row.total_pesewas, subtotal + fee);
    assert.equal(quoted.total_pesewas, row.total_pesewas, 'the quote and the charge agree');

    const payment = await payOrder(placed.order_id);
    assert.equal(payment.amount_pesewas, subtotal + fee, 'what the provider is asked for');

    // A price change after the fact reaches nothing that exists.
    await updateItem(kelewele.id, { p_variable_min_pesewas: 5000 });
    assert.equal((await lines(placed.order_id)).length, 3);
    assert.equal((await orderRow(placed.order_id)).total_pesewas, subtotal + fee);
  });

  // ===========================================================================
  // THE TECHNICAL CEILING: NO STORE MAXIMUM IS NOT "ANY NUMBER AT ALL"
  // ===========================================================================

  test('an unlimited stepped item goes up to the platform ceiling and no further', async () => {
    const kelewele = await stepped();
    const ceiling = await asService(
      async (c) => (await c.query('select public.max_item_price_pesewas() as v')).rows[0].v
    );
    assert.equal(ceiling, 100000, 'GH₵1,000, the same as a fixed price');

    // The last step under the ceiling is a price like any other.
    assert.equal((await quote([line(kelewele.id, 100000)])).subtotal_pesewas, 100000);

    const countOrders = () =>
      asService(
        async (c) => (await c.query('select count(*)::int as n from public.orders')).rows[0].n
      );
    const before = await countOrders();

    // One step over, and amounts no payment could ever be for — refused with
    // a sentence, before an order or a charge exists.
    for (const price of [100500, 10_000_000, 1e12, 1e30]) {
      let error = await expectRejection(quote([line(kelewele.id, price)]));
      assert.match(error.message, /more than any item can cost/, String(price));
      error = await expectRejection(order([line(kelewele.id, price)]));
      assert.match(error.message, /more than any item can cost/, String(price));
    }
    assert.equal(await countOrders(), before, 'no order was created');

    const { toUserError } = await import('@/lib/errors');
    const muted = console.error;
    console.error = () => {};
    try {
      const shown = toUserError(
        new Error('the amount for Kelewele is more than any item can cost')
      );
      assert.equal(shown.kind, 'USER');
      assert.match(shown.message, /GH₵1,000/);
    } finally {
      console.error = muted;
    }
  });

  test('the ceiling is not a store maximum: the store may still leave it unset', async () => {
    const kelewele = await stepped();
    assert.equal((await item(kelewele.id)).variable_max_pesewas, null);

    // But no store can promise a price the checkout would refuse.
    await expectRejection(updateItem(kelewele.id, { p_variable_max_pesewas: 100500 }));
    const error = await expectRejection(
      createItem({ name: 'Too far', mode: 'CHOICES', choices: [1000, 100500] })
    );
    assert.match(error.message, /GHS 1000/);
    assert.equal(
      (await updateItem(kelewele.id, { p_variable_max_pesewas: 100000 })).variable_max_pesewas,
      100000
    );
  });

  test('fixed prices keep the ceiling they always had, and nothing else about them moved', async () => {
    await expectRejection(createItem({ mode: 'FIXED', price: 100001 }));
    assert.equal((await createItem({ mode: 'FIXED', price: 100000 })).price_pesewas, 100000);
  });

  // ===========================================================================
  // OPEN MEANS SOMETHING CAN BE ORDERED
  // ===========================================================================

  const storeOpen = (vendorId = VENDORS.one) =>
    asService(
      async (c) =>
        (await c.query('select is_accepting_orders from public.vendors where id = $1', [vendorId]))
          .rows[0].is_accepting_orders
    );

  const setAccepting = (open, vendorId = VENDORS.one) =>
    asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (
          await c.query('select * from public.vendor_set_accepting_orders($1, $2)', [
            vendorId,
            open,
          ])
        ).rows[0],
      { commit: true }
    );

  test('a store whose only active item is variable closes when the capability is turned off, and reopens when it returns', async () => {
    const kelewele = await stepped();
    // Close for the day (every item off), then serve only the kelewele.
    await setAccepting(false);
    assert.equal(await storeOpen(), false);
    assert.equal((await activate(kelewele.id)).store_open, true);

    await setCapability(VENDORS.one, false);
    assert.equal(await storeOpen(), false, 'no OPEN sign over an empty menu');

    // The item itself is exactly as the store left it: on, and configured.
    const kept = await item(kelewele.id);
    assert.equal(kept.is_active, true);
    assert.equal(kept.pricing_mode, 'STEPPED');
    assert.equal(kept.variable_min_pesewas, 1000);

    // Nor can the store open around it by hand.
    const error = await expectRejection(setAccepting(true));
    assert.match(error.message, /turn at least one item on before you open/);

    await setCapability(VENDORS.one, true);
    assert.equal(await storeOpen(), true, 'the same menu is orderable again');
    const placed = await order([line(kelewele.id, 2000)]);
    assert.equal((await orderRow(placed.order_id)).subtotal_pesewas, 2000);
  });

  test('a store that still has a fixed item on stays open when the capability is turned off', async () => {
    const kelewele = await stepped();
    assert.equal(await storeOpen(), true);
    await setCapability(VENDORS.one, false);
    assert.equal(await storeOpen(), true, 'the jollof is still for sale');
    await expectRejection(order([line(kelewele.id, 1000)]));
    assert.ok(await order([line(MENU.jollof, undefined)]));
  });

  // ===========================================================================
  // SCAN
  // ===========================================================================

  test('a variable item can never be scan-eligible', async () => {
    await setCapability(VENDORS.wafflemania, true);

    let error = await expectRejection(
      createItem(
        { vendorId: VENDORS.wafflemania, min: 1000, step: 500, scan: true },
        ACTORS.wafflemaniaStaff
      )
    );
    assert.match(error.message, /cannot take meal scans/);

    error = await expectRejection(
      updateItem(
        SCAN_MENU.waffle,
        { p_pricing_mode: 'STEPPED', p_variable_min_pesewas: 1000, p_variable_step_pesewas: 500 },
        ACTORS.wafflemaniaStaff
      )
    );
    assert.match(error.message, /cannot take meal scans/);

    const variable = await createItem(
      { vendorId: VENDORS.wafflemania, mode: 'CHOICES', choices: [1000] },
      ACTORS.wafflemaniaStaff
    );
    await expectRejection(
      updateItem(variable.id, { p_scan_eligible: true }, ACTORS.wafflemaniaStaff)
    );

    // And the table refuses it even from a direct write.
    error = await expectRejection(
      asService((c) =>
        c.query(
          "update public.menu_items set pricing_mode = 'STEPPED', variable_min_pesewas = 100, variable_step_pesewas = 100 where id = $1",
          [SCAN_MENU.waffle]
        )
      )
    );
    assert.match(error.message, /menu_items_variable_is_not_scan/);
  });

  test('a variable item is refused on a Meal Scan order, and fixed scan items are unchanged', async () => {
    const variable = await stepped({
      vendorId: VENDORS.wafflemania,
      staff: ACTORS.wafflemaniaStaff,
    });

    const error = await expectRejection(
      submitScanOrder({ items: [line(variable.id, 1500)], fulfilment: 'PICKUP' })
    );
    assert.match(error.message, /cannot be paid for with a meal scan/);

    const placed = await submitScanOrder({ fulfilment: 'PICKUP' });
    const [snapshot] = await lines(placed.order_id);
    assert.equal(snapshot.menu_item_id, SCAN_MENU.waffle);
    assert.equal(snapshot.unit_price_pesewas, 3800);
  });
});

/**
 * THE SCREEN'S HALF. Not enforcement — the tests above are — but the basket
 * must send exactly the line the database reads, and the storefront's courtesy
 * check must agree with it rather than round anything into shape.
 */
describe('variable pricing on the screen', () => {
  test('a basket line carries a chosen price only when there is one', async () => {
    const { basketLines } = await import('@/lib/orders/basket');
    assert.deepEqual(
      basketLines([
        { menuItemId: 'a', quantity: 2 },
        { menuItemId: 'b', quantity: 1, unitPricePesewas: 3500 },
      ]),
      [
        { menu_item_id: 'a', quantity: 2 },
        { menu_item_id: 'b', quantity: 1, unit_price_pesewas: 3500 },
      ]
    );
  });

  test('the storefront check matches the server rule and names the nearest prices', async () => {
    const { checkChosenPrice, priceSummary } = await import('@/lib/util/item-price');
    const unlimited = {
      pricing_mode: 'STEPPED',
      variable_min_pesewas: 1000,
      variable_step_pesewas: 500,
    };
    const limited = { ...unlimited, variable_max_pesewas: 2500 };
    const list = {
      pricing_mode: 'CHOICES',
      variable_choices_pesewas: ['5000', '1000', '3000', '1500'],
    };

    assert.equal(checkChosenPrice(unlimited, 10500).ok, true);
    assert.deepEqual(checkChosenPrice(unlimited, 1200), { ok: false, lower: 1000, higher: 1500 });
    assert.deepEqual(checkChosenPrice(unlimited, 900), { ok: false, higher: 1000 });
    assert.deepEqual(checkChosenPrice(limited, 3000), { ok: false, lower: 2500, tooHigh: false });
    assert.deepEqual(checkChosenPrice(unlimited, 100500), {
      ok: false,
      lower: 100000,
      tooHigh: true,
    });
    assert.equal(checkChosenPrice(unlimited, 1e20).tooHigh, true, 'too long to hold is too much');
    assert.equal(checkChosenPrice(list, 3000).ok, true);
    assert.equal(checkChosenPrice(list, 2000).ok, false);

    assert.equal(priceSummary(unlimited), 'From GH₵10.00');
    assert.equal(priceSummary(limited), 'GH₵10.00–GH₵25.00');
    assert.equal(priceSummary(list), 'GH₵10.00–GH₵50.00');
  });
});
