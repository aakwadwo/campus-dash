import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  closePools,
  resetTransactionalState,
  ACTORS,
  VENDORS,
  MENU,
  SCAN_MENU,
} from './helpers/db.js';
import {
  submitOrder,
  submitScanOrder,
  payOrder,
  partnerAccept,
  vendorRedeemScan,
  vendorReady,
  completeDelivery,
  getOrder,
  getAllocations,
} from './helpers/flow.js';
import { vendorSharePesewas } from '../lib/orders/state.js';

/**
 * THE SCAN PACK FEE BELONGS TO THE STORE.
 *
 * The one intentional change to scan economics. The GH₵4 pack used to be
 * platform revenue; it is now allocated to the vendor in the same row, on the
 * same channel, as a food order's subtotal. Everything else is pinned here as
 * unchanged: the flat GH₵2 scan fee, the GH₵5 Partner fee, the scanned value
 * never entering the ledger, and food orders exactly as they were.
 *
 * Each case asks the ledger, not the screen: allocations are the authoritative
 * answer to "who is owed what", and a figure that is right on a page and wrong
 * here is wrong.
 */
describe('scan pack allocation', () => {
  const SCAN_FEE = 200;
  const PACK = 400;
  const PARTNER_FEE = 500;

  // THE LIVE PILOT FIGURES, stated rather than inherited: other files retune
  // pricing_config for their own arithmetic and not every one puts it back.
  async function livePricing() {
    await resetTransactionalState();
    await asService((c) =>
      c.query(`
        update public.pricing_config
           set service_fee_bps = 695, delivery_fee_pesewas = 500,
               scan_service_fee_pesewas = 200, scan_pack_fee_pesewas = 400,
               partner_share_of_delivery_bps = 10000, partner_delivery_enabled = true
         where id
      `)
    );
    await asService((c) =>
      c.query('update public.vendors set is_accepting_orders = true where id = any($1::uuid[])', [
        [VENDORS.one, VENDORS.wafflemania, VENDORS.yellowBar],
      ])
    );
  }

  before(livePricing);
  beforeEach(livePricing);
  after(closePools);

  const byPayee = async (orderId) =>
    Object.fromEntries(
      (await getAllocations(orderId)).map((a) => [a.payee_type, Number(a.amount_pesewas)])
    );

  const sum = (ledger) => Object.values(ledger).reduce((total, amount) => total + amount, 0);

  /** Pay, and for a Partner order walk it to DELIVERED at the right store. */
  async function payAndFinish(order, { vendorId = VENDORS.wafflemania, partner = false } = {}) {
    await payOrder(order.order_id);
    if (!partner) return;
    const staff = vendorId === VENDORS.yellowBar ? ACTORS.yellowBarStaff : ACTORS.wafflemaniaStaff;
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await vendorRedeemScan(order.order_id, staff);
    await vendorReady(order.order_id, staff);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);
  }

  test('1. scan collection, no pack: GH₵2, all of it Campus Dash, no vendor row', async () => {
    const order = await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: false });
    await payAndFinish(order);

    const stored = await getOrder(order.order_id);
    assert.equal(Number(stored.total_pesewas), SCAN_FEE);
    assert.equal(Number(stored.pack_fee_pesewas), 0);

    const ledger = await byPayee(order.order_id);
    assert.deepEqual(ledger, { PLATFORM: SCAN_FEE });
    assert.equal(ledger.VENDOR, undefined, 'a zero-pesewa liability is never written');
  });

  test('2. scan collection with a pack: GH₵6, the GH₵4 pack to the store', async () => {
    const order = await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: true });
    await payAndFinish(order);

    const stored = await getOrder(order.order_id);
    assert.equal(Number(stored.total_pesewas), SCAN_FEE + PACK);

    const ledger = await byPayee(order.order_id);
    assert.equal(ledger.VENDOR, PACK, 'vendor = food subtotal (GH₵0 through us) + GH₵4');
    assert.equal(ledger.PLATFORM, SCAN_FEE, 'Campus Dash keeps GH₵2 and nothing else');
    assert.equal(ledger.PARTNER, undefined, 'nobody carried it');
  });

  test('3. scan with a Partner: GH₵11, split GH₵4 / GH₵2 / GH₵5 once delivered', async () => {
    const order = await submitScanOrder({ fulfilment: 'DELIVERY' });

    const stored = await getOrder(order.order_id);
    assert.equal(Number(stored.total_pesewas), SCAN_FEE + PACK + PARTNER_FEE);
    assert.equal(Number(stored.pack_fee_pesewas), PACK, 'compulsory with a Partner');

    await payOrder(order.order_id);
    assert.deepEqual(
      await byPayee(order.order_id),
      { VENDOR: PACK, PLATFORM: SCAN_FEE + PARTNER_FEE },
      'at payment no Partner exists, so the platform holds their fee'
    );

    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await vendorRedeemScan(order.order_id, ACTORS.wafflemaniaStaff);
    await vendorReady(order.order_id, ACTORS.wafflemaniaStaff);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const ledger = await byPayee(order.order_id);
    assert.equal(ledger.VENDOR, PACK, 'the pack is the store’s');
    assert.equal(ledger.PLATFORM, SCAN_FEE, 'the flat fee is Campus Dash’s');
    assert.equal(ledger.PARTNER, PARTNER_FEE, 'the pack is never part of the Partner’s GH₵5');
  });

  test('4. the food value never moves the figures: GH₵38 waffle, GH₵42 tilapia, 3 waffles', async () => {
    const cases = [
      { vendorId: VENDORS.wafflemania, items: [{ menu_item_id: SCAN_MENU.waffle, quantity: 1 }] },
      { vendorId: VENDORS.yellowBar, items: [{ menu_item_id: SCAN_MENU.tilapia, quantity: 1 }] },
      { vendorId: VENDORS.wafflemania, items: [{ menu_item_id: SCAN_MENU.waffle, quantity: 3 }] },
    ];

    const ledgers = [];
    for (const { vendorId, items } of cases) {
      const order = await submitScanOrder({ vendorId, items, fulfilment: 'DELIVERY' });
      await payAndFinish(order, { vendorId, partner: true });

      const stored = await getOrder(order.order_id);
      assert.equal(Number(stored.subtotal_pesewas), 0, 'the scanned value is never our subtotal');
      ledgers.push(await byPayee(order.order_id));
    }

    for (const ledger of ledgers) {
      assert.deepEqual(ledger, { VENDOR: PACK, PLATFORM: SCAN_FEE, PARTNER: PARTNER_FEE });
    }
  });

  test('5. every scan ledger sums to exactly what the customer paid', async () => {
    const orders = [
      [await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: false }), false],
      [await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: true }), false],
      [await submitScanOrder({ fulfilment: 'DELIVERY' }), true],
    ];

    for (const [order, partner] of orders) {
      await payAndFinish(order, { partner });
      const stored = await getOrder(order.order_id);
      assert.equal(
        sum(await byPayee(order.order_id)),
        Number(stored.total_pesewas),
        'allocations_must_balance, checked from the outside too'
      );
    }
  });

  test('6. the store’s board says whether a pack goes with it, and the pack is its amount', async () => {
    const withPack = await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: true });
    const without = await submitScanOrder({ fulfilment: 'PICKUP', wantsPack: false });
    await payOrder(withPack.order_id);
    await payOrder(without.order_id);

    const board = await asUser(
      ACTORS.wafflemaniaStaff,
      async (c) =>
        (await c.query('select * from public.vendor_order_board($1, 20)', [VENDORS.wafflemania]))
          .rows
    );
    const a = board.find((r) => r.order_id === withPack.order_id);
    const b = board.find((r) => r.order_id === without.order_id);

    assert.equal(a.pack_included, true);
    assert.equal(Number(a.vendor_amount_pesewas), PACK);
    assert.equal(b.pack_included, false);
    assert.equal(Number(b.vendor_amount_pesewas), 0);

    const [detail] = await asUser(
      ACTORS.wafflemaniaStaff,
      async (c) =>
        (await c.query('select * from public.vendor_order_detail($1)', [withPack.order_id])).rows
    );
    assert.equal(Number(detail.vendor_pack_pesewas), PACK);
    assert.equal(Number(detail.vendor_amount_pesewas), PACK);
    assert.equal('total_pesewas' in detail, false, 'never the customer total');
  });

  test('7. the Paystack split share is the same figure the ledger writes', () => {
    assert.equal(vendorSharePesewas({ subtotal_pesewas: 0, pack_fee_pesewas: 400 }), 400);
    assert.equal(vendorSharePesewas({ subtotal_pesewas: 0, pack_fee_pesewas: 0 }), 0);
    assert.equal(vendorSharePesewas({ subtotal_pesewas: 7300, pack_fee_pesewas: 0 }), 7300);
    assert.equal(vendorSharePesewas({ subtotal_pesewas: '7300', pack_fee_pesewas: null }), 7300);
  });

  describe('8. a normal FOOD order is unchanged', () => {
    test('collection: vendor = subtotal, platform = 6.95% service fee, no pack', async () => {
      // 2 × GH₵35 jollof + GH₵3 water = GH₵73.00; 6.95% = GH₵5.0735 → GH₵5.07.
      const order = await submitOrder({
        fulfilment: 'PICKUP',
        items: [
          { menu_item_id: MENU.jollof, quantity: 2 },
          { menu_item_id: MENU.water, quantity: 1 },
        ],
      });
      await payOrder(order.order_id);

      const stored = await getOrder(order.order_id);
      assert.equal(Number(stored.subtotal_pesewas), 7300);
      assert.equal(Number(stored.service_fee_pesewas), 507);
      assert.equal(Number(stored.pack_fee_pesewas), 0);
      assert.equal(Number(stored.total_pesewas), 7807);

      assert.deepEqual(await byPayee(order.order_id), { VENDOR: 7300, PLATFORM: 507 });
    });

    test('with a Partner: vendor = subtotal, Partner = GH₵5, platform = the service fee', async () => {
      const order = await submitOrder({
        fulfilment: 'DELIVERY',
        items: [
          { menu_item_id: MENU.jollof, quantity: 2 },
          { menu_item_id: MENU.water, quantity: 1 },
        ],
      });
      await payOrder(order.order_id);
      await partnerAccept(order.order_id, ACTORS.partnerYaw);
      await vendorReady(order.order_id, ACTORS.vendor1Staff);
      await completeDelivery(order.order_id, ACTORS.partnerYaw);

      const stored = await getOrder(order.order_id);
      assert.equal(Number(stored.total_pesewas), 7300 + 507 + PARTNER_FEE);
      assert.deepEqual(await byPayee(order.order_id), {
        VENDOR: 7300,
        PLATFORM: 507,
        PARTNER: PARTNER_FEE,
      });
    });
  });
});
