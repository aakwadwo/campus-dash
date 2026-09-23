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
  SCAN_MENU,
  LOCATIONS,
} from './helpers/db.js';
import {
  submitOrder,
  payOrder,
  vendorReady,
  partnerAccept,
  completeDelivery,
  getOrder,
  getAllocations,
  submitScanOrder,
  expectRejection,
} from './helpers/flow.js';

/**
 * The switches an operator flips during a pilot.
 *
 * Each of these governs what can be STARTED and nothing else. That is the whole
 * property worth testing: an order somebody has already paid for is their
 * dinner and a Partner's GH₵5, and no setting may reach back into it. A switch
 * that cancelled live work would be worse than no switch at all.
 */
describe('operational switches', () => {
  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(
        'update public.pricing_config set partner_delivery_enabled = true, scan_pack_fee_pesewas = 0'
      )
    );
    await asService((c) => c.query('update public.menu_items set is_available = true'));
    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = true where id = $1', [VENDORS.one])
    );
  });
  after(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(
        'update public.pricing_config set partner_delivery_enabled = true, scan_pack_fee_pesewas = 0'
      )
    );
    await closePools();
  });

  const setSwitch = (on) =>
    asUser(
      ACTORS.admin,
      (c) =>
        c.query(
          `select public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null,
             null, null, null, $2, null)`,
          [on ? 'partners are back' : 'nobody is available tonight', on]
        ),
      { commit: true }
    );

  const options = (orderId) =>
    asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.fulfilment_options($1)', [orderId])).rows
    );

  // =========================================================================
  // PARTNER DELIVERY, ON AND OFF
  // =========================================================================
  test('with delivery switched off, a new order can only be collected', async () => {
    await setSwitch(false);

    const refused = await expectRejection(submitOrder());
    assert.match(refused.message, /partner delivery is unavailable/i);

    // Collection is untouched. The point of the switch is to keep the product
    // running with half of it, not to close the platform.
    const collected = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    assert.ok(collected.order_id);
    assert.equal((await getOrder(collected.order_id)).fulfilment_type, 'PICKUP');
  });

  test('the checkout is told, so it can grey the option out rather than guess', async () => {
    const quote = (fulfilment) =>
      asUser(
        ACTORS.customerAma,
        async (c) =>
          (
            await c.query('select * from public.quote_order($1, $2::jsonb, $3)', [
              VENDORS.one,
              JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
              fulfilment,
            ])
          ).rows[0]
      );

    assert.equal((await quote('DELIVERY')).delivery_available, true);
    await setSwitch(false);
    assert.equal((await quote('DELIVERY')).delivery_available, false);

    // And on an order that already exists, the same answer per option.
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    const rows = await options(order.order_id);
    const byType = Object.fromEntries(rows.map((r) => [r.fulfilment_type, r]));
    assert.equal(byType.PICKUP.is_available, true, 'collection is always on offer');
    assert.equal(byType.DELIVERY.is_available, false);
  });

  test('switching delivery off never touches an order already paid for', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await vendorReady(order.order_id);

    await setSwitch(false);

    // Nothing moved: same fulfilment, same fee, same Partner, same money.
    const stored = await getOrder(order.order_id);
    assert.equal(stored.fulfilment_type, 'DELIVERY');
    assert.equal(stored.delivery_fee_pesewas, 500);
    assert.equal(stored.partner_id, ACTORS.partnerYaw);
    assert.equal(stored.delivery_status, 'ASSIGNED');
    assert.equal(stored.payment_status, 'PAID');

    // And the delivery still completes, and still earns GH₵5.
    await completeDelivery(order.order_id, ACTORS.partnerYaw);
    const done = await getOrder(order.order_id);
    assert.equal(done.order_status, 'COMPLETED');
    assert.equal(done.delivery_status, 'DELIVERED');

    const partner = (await getAllocations(order.order_id)).find((a) => a.payee_type === 'PARTNER');
    assert.equal(partner.amount_pesewas, 500, 'the Partner is paid for work they actually did');
  });

  test('a customer cannot switch delivery back on for themselves', async () => {
    await setSwitch(false);

    const viaFunction = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query(
          `select public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null,
             null, null, null, true, null)`,
          ['let me have it']
        )
      )
    );
    assert.match(viaFunction.message, /admin privileges required/);

    const direct = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.pricing_config set partner_delivery_enabled = true where id')
      )
    );
    assert.match(direct.message, /permission denied/i);
  });

  test('changing the choice to delivery is refused while it is switched off', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await setSwitch(false);

    const result = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select public.customer_choose_fulfilment($1, $2, $3, null) as r', [
            order.order_id,
            'DELIVERY',
            LOCATIONS.room204,
          ])
        ).rows[0].r,
      { commit: true }
    );
    assert.ok(String(result).startsWith('(f'), 'refused, and as a state failure not an exception');
    assert.equal((await getOrder(order.order_id)).fulfilment_type, 'PICKUP');
  });

  // =========================================================================
  // SOLD OUT, AND WHAT REOPENING DOES
  // =========================================================================
  const setOpen = (open) =>
    asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_accepting_orders($1, $2)', [VENDORS.one, open]),
      { commit: true }
    );

  const soldOut = (itemId, out = true) =>
    asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, $2)', [itemId, !out]),
      { commit: true }
    );

  const setActive = (itemId, active) =>
    asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select * from public.vendor_set_menu_item_active($1, $2)', [itemId, active]),
      { commit: true }
    );

  const availability = (itemId) =>
    asService(
      async (c) =>
        (await c.query('select is_available from public.menu_items where id = $1', [itemId]))
          .rows[0].is_available
    );

  const isActive = (itemId) =>
    asService(
      async (c) =>
        (await c.query('select is_active from public.menu_items where id = $1', [itemId])).rows[0]
          .is_active
    );

  test('a sold-out item is visible to a customer but cannot be ordered', async () => {
    await soldOut(MENU.jollof);

    // STILL ON THE MENU. A dish that vanishes reads as a store that stopped
    // selling it; one marked sold out reads as a store that is busy.
    const visible = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.menu_items where id = $1 and vendor_id = $2', [
            MENU.jollof,
            VENDORS.one,
          ])
        ).rows[0]
    );
    assert.ok(visible, 'the customer can still see it');
    assert.equal(visible.is_available, false, 'marked, not hidden');

    const refused = await expectRejection(
      submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] })
    );
    assert.match(refused.message, /unavailable/);
  });

  /**
   * A STORE REOPENS BY PUTTING SOMETHING ON, which is the shape the active menu
   * gave this: closing clears what is being served and opening is the
   * consequence of choosing today's first dish. The sold-out marks still clear
   * themselves on the CLOSED → OPEN transition, wherever that transition comes
   * from, because running out of jollof is a fact about a service.
   */
  test('reopening the store puts everything back on the menu', async () => {
    await soldOut(MENU.jollof);
    await soldOut(MENU.waakye);
    assert.equal(await availability(MENU.jollof), false);

    await setOpen(false);
    assert.equal(await availability(MENU.jollof), false, 'closing changes nothing about sold out');
    assert.equal(await isActive(MENU.jollof), false, 'but it does clear the active menu');

    await setActive(MENU.jollof, true);
    assert.equal(await availability(MENU.jollof), true);
    assert.equal(await availability(MENU.waakye), true, 'every mark, not only the one turned on');

    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    assert.ok(order.order_id, 'and it is orderable again without a vendor touching anything');
  });

  test('reopening never reaches another store’s menu', async () => {
    // Vendor TWO marks their own shawarma sold out. Vendor one opening and
    // closing their store must not put it back on: the reset is scoped to the
    // store doing the reopening, and nothing else.
    await asUser(
      ACTORS.vendor2Staff,
      (c) => c.query('select public.vendor_set_menu_item_available($1, false)', [MENU.shawarma]),
      { commit: true }
    );
    assert.equal(await availability(MENU.shawarma), false);

    await setOpen(false);
    await setActive(MENU.jollof, true);
    assert.equal(await availability(MENU.shawarma), false);
  });

  test('pressing Open while already open leaves a deliberate sold-out mark alone', async () => {
    // The reset is on the TRANSITION, not on the press. A vendor who marks the
    // jollof sold out mid-service and then taps Open again out of habit should
    // not find it back on the menu.
    await soldOut(MENU.jollof);
    await setOpen(true);
    assert.equal(await availability(MENU.jollof), false);
  });

  // =========================================================================
  // THE DISPOSABLE PACK FEE
  // =========================================================================
  const setPackFee = (pesewas) =>
    asUser(
      ACTORS.admin,
      (c) =>
        c.query(
          `select public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null,
             null, null, null, null, $2)`,
          ['packs cost us something', pesewas]
        ),
      { commit: true }
    );

  /** A Partner-carried scan order at Wafflemania, priced by the server. */
  const quoteScan = () =>
    asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.quote_scan_order($1, $2::jsonb, $3, $4)', [
            VENDORS.wafflemania,
            JSON.stringify([{ menu_item_id: SCAN_MENU.waffle, quantity: 1 }]),
            'DELIVERY',
            LOCATIONS.room204,
          ])
        ).rows[0]
    );

  test('the pack fee is an admin setting, charged on a scan and shown as its own line', async () => {
    await setPackFee(150);

    const quoted = await quoteScan();

    assert.equal(Number(quoted.subtotal_pesewas), 0, 'the food was paid for by the scan');
    assert.equal(Number(quoted.pack_fee_pesewas), 150);
    assert.equal(
      Number(quoted.total_pesewas),
      Number(quoted.service_fee_pesewas) +
        Number(quoted.delivery_fee_pesewas) +
        Number(quoted.pack_fee_pesewas),
      'the total is the sum of parts a customer can each be pointed at'
    );
  });

  test('a food order is never charged a pack fee, whatever the setting says', async () => {
    await setPackFee(150);

    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    const stored = await getOrder(order.order_id);
    assert.equal(Number(stored.pack_fee_pesewas), 0);
    assert.equal(
      Number(stored.total_pesewas),
      Number(stored.subtotal_pesewas) + Number(stored.service_fee_pesewas)
    );

    // Structural, not a policy somebody could forget: the constraint refuses it.
    const forced = await expectRejection(
      asService((c) =>
        c.query('update public.orders set pack_fee_pesewas = 150 where id = $1', [order.order_id])
      )
    );
    assert.match(forced.message, /orders_pack_fee_scan_only/);
  });

  test('a zero pack fee is a real setting, and means Campus Dash absorbs it', async () => {
    await setPackFee(0);
    const quoted = await quoteScan();
    assert.equal(Number(quoted.pack_fee_pesewas), 0);
  });

  test('a negative pack fee is refused rather than stored', async () => {
    const error = await expectRejection(setPackFee(-1));
    assert.match(error.message, /pack fee cannot be negative/i);
  });

  test('the pack fee a customer paid is snapshotted, not re-read later', async () => {
    await setPackFee(150);
    const errand = await submitScanOrder({ vendorId: VENDORS.wafflemania });

    await setPackFee(900);

    const stored = await getOrder(errand.order_id);
    assert.equal(Number(stored.pack_fee_pesewas), 150, 'the customer owes what they agreed');
  });
});
