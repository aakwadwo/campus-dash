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
} from './helpers/db.js';
import {
  submitOrder,
  orderReadyForDispatch,
  partnerAccept,
  expectRejection,
  getSecrets,
  tryTransition,
} from './helpers/flow.js';

describe('row level security and authorisation', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  // --- 7 -------------------------------------------------------------------
  test('a customer cannot mark their own order PAID', async () => {
    const order = await submitOrder();

    // There is no UPDATE grant on orders for authenticated at all, so this
    // fails on privileges before RLS is even consulted.
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query("update public.orders set payment_status = 'PAID' where id = $1", [order.order_id])
      )
    );
    assert.match(error.message, /permission denied/i);

    const stored = await asService(
      async (c) =>
        (await c.query('select payment_status from public.orders where id = $1', [order.order_id]))
          .rows[0]
    );
    assert.equal(stored.payment_status, 'UNPAID');
  });

  test('a customer cannot call the payment confirmation function', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.confirm_payment($1, $2, $3)', [
          '00000000-0000-0000-0000-000000000000',
          'x',
          100,
        ])
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test('a customer cannot inflate their own order total', async () => {
    const order = await submitOrder();
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.orders set total_pesewas = 1 where id = $1', [order.order_id])
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test('the client cannot dictate price: submit_order ignores any price it sends', async () => {
    // A crafted payload carrying its own price and total.
    const order = await submitOrder({
      items: [
        {
          menu_item_id: '30000000-0000-4000-8000-000000000001',
          quantity: 2,
          price_pesewas: 1,
          unit_price_pesewas: 1,
        },
      ],
    });
    // 2 × GH₵35.00 = GH₵70.00, + 5% (GH₵3.50) = GH₵73.50. No delivery fee:
    // that is added when the customer chooses, from the same snapshot.
    assert.equal(order.total_pesewas, 7350, 'the server priced it, not the client');
  });

  // --- 6 -------------------------------------------------------------------
  test("a vendor cannot see or act on another vendor's order", async () => {
    const order = await submitOrder({ vendorId: VENDORS.one });

    const visible = await asUser(
      ACTORS.vendor2Staff,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows
    );
    assert.equal(visible.length, 0, "vendor two cannot even read vendor one's order");

    const error = await expectRejection(
      asUser(ACTORS.vendor2Staff, (c) =>
        c.query('select public.vendor_accept_order($1)', [order.order_id])
      )
    );
    assert.match(error.message, /not authorised/);

    const stored = await asService(
      async (c) =>
        (await c.query('select order_status from public.orders where id = $1', [order.order_id]))
          .rows[0]
    );
    assert.equal(stored.order_status, 'SUBMITTED', 'the order was untouched');
  });

  test('a vendor CAN see and act on their own order', async () => {
    const order = await submitOrder({ vendorId: VENDORS.one });
    const visible = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows
    );
    assert.equal(visible.length, 1);
  });

  test("a customer cannot read another customer's order", async () => {
    const order = await submitOrder({ customer: ACTORS.customerAma });
    const visible = await asUser(
      ACTORS.customerKwesi,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows
    );
    assert.equal(visible.length, 0);
  });

  test("a customer cannot read another customer's order items", async () => {
    const order = await submitOrder({ customer: ACTORS.customerAma });
    const visible = await asUser(
      ACTORS.customerKwesi,
      async (c) =>
        (await c.query('select * from public.order_items where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(visible.length, 0);
  });

  // --- 8 -------------------------------------------------------------------
  test('a Partner cannot see the customer phone number before assignment', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });

    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(rows.length, 0, 'no access before the Partner is even assigned');

    // The offer itself carries a zone, never a person.
    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    const offer = offers.find((o) => o.order_id === order.order_id);
    assert.ok(offer, 'the offer is visible');
    assert.equal(offer.destination_zone, 'Hostel Block A');
    assert.ok(!('customer_phone' in offer), 'the offer has no customer phone field');
    assert.ok(!('destination' in offer), 'the offer has no room-level destination');
  });

  test('ASSIGNMENT is what reveals the customer phone, and only to that Partner', async () => {
    // The window OPENS at assignment now, not at handoff. A Partner who cannot
    // find a room needs to ring before they are holding food that is going
    // cold, not after — and the offer list still shows nobody a phone number.
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const assigned = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(assigned.length, 1, 'the assigned Partner may ring the customer');
    assert.equal(assigned[0].phone, '+233200000021');

    // EVERY OTHER PARTNER STILL SEES NOTHING. The policy is per assignment, not
    // per capability.
    const stranger = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(stranger.length, 0, 'an unassigned Partner gets nothing');
  });

  test('a Partner keeps the customer phone while carrying, and loses it on completion', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const during = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(during.length, 1, 'visible while actively carrying the food');
    assert.equal(during[0].phone, '+233200000021');

    await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
      order.order_id,
      secrets.delivery_code,
    ]);

    const after = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(after.length, 0, 'access ends when the delivery does — not kept in history');
  });

  test("a Partner cannot read another Partner's active delivery", async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const rows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows
    );
    assert.equal(rows.length, 0);
  });

  test("a Partner cannot read another Partner's profile or documents", async () => {
    const rows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.partnerYaw,
          ])
        ).rows
    );
    assert.equal(rows.length, 0);
  });

  test("a Partner cannot read another Partner's earnings", async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await asService((c) => c.query('select public.settle_partner_earnings($1)', [order.order_id]));

    const rows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query("select * from public.allocations where payee_type = 'PARTNER'")).rows
    );
    assert.equal(rows.length, 0);
  });

  // --- order_secrets ------------------------------------------------------
  test('NOBODY can read order_secrets directly — not the vendor, not the Partner, not an admin', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    for (const [label, actor] of [
      ['vendor', ACTORS.vendor1Staff],
      ['partner', ACTORS.partnerYaw],
      ['customer', ACTORS.customerAma],
      ['admin', ACTORS.admin],
    ]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('select pickup_code from public.order_secrets where order_id = $1', [
            order.order_id,
          ])
        )
      );
      assert.match(error.message, /permission denied/i, `${label} must not read order_secrets`);
    }
  });

  test('the VENDOR gets the pickup code, and no Partner can reach it at all', async () => {
    // THE HANDOFF, and the asymmetry that makes it mean anything. The vendor
    // holds the code and reads it out; the Partner types in what they hear. A
    // Partner who could read it could confirm a collection that never happened.
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const stored = await getSecrets(order.order_id);
    const theirs = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_pickup_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.equal(theirs, stored.pickup_code);

    for (const partner of [ACTORS.partnerYaw, ACTORS.partnerAdjoa]) {
      const error = await expectRejection(
        asUser(partner, (c) => c.query('select public.vendor_pickup_code($1)', [order.order_id]))
      );
      assert.match(error.message, /not authorised for this order/);
    }

    // A different store cannot read it either.
    const otherStore = await expectRejection(
      asUser(ACTORS.vendor2Staff, (c) =>
        c.query('select public.vendor_pickup_code($1)', [order.order_id])
      )
    );
    assert.match(otherStore.message, /not authorised for this order/);
  });

  test('the customer gets a COLLECTION code, and only for an order they collect', async () => {
    // A different code from the delivery one, held by a different person: this
    // is the one the customer shows at the counter for a self-pickup order.
    const delivery = await orderReadyForDispatch();
    const notTheirs = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.get_my_pickup_code($1)', [delivery.order_id])
      )
    );
    assert.match(notTheirs.message, /no collection code available/);
  });

  test('the customer gets their delivery code, and another customer cannot', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const code = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select public.get_my_delivery_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.match(code, /^\d{4}$/);

    const error = await expectRejection(
      asUser(ACTORS.customerKwesi, (c) =>
        c.query('select public.get_my_delivery_code($1)', [order.order_id])
      )
    );
    assert.match(error.message, /no delivery code available/);
  });

  // --- admin & anon --------------------------------------------------------
  test('a non-admin cannot perform admin overrides or read the audit log', async () => {
    const order = await submitOrder();

    const cancel = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [order.order_id, 'trying it on'])
      )
    );
    assert.match(cancel.message, /admin privileges required/);

    const audit = await expectRejection(
      asUser(ACTORS.customerAma, (c) => c.query('select * from public.admin_actions'))
    );
    assert.match(audit.message, /permission denied/i);
  });

  test('anonymous visitors can browse the catalogue but see no orders or users', async () => {
    await submitOrder();

    const vendors = await asAnon(async (c) => (await c.query('select * from public.vendors')).rows);
    assert.ok(vendors.length >= 2, 'active vendors are browsable');

    const items = await asAnon(
      async (c) => (await c.query('select * from public.menu_items')).rows
    );
    assert.ok(items.length > 0);

    const orders = await expectRejection(asAnon((c) => c.query('select * from public.orders')));
    assert.match(orders.message, /permission denied/i);

    const users = await expectRejection(asAnon((c) => c.query('select * from public.users')));
    assert.match(users.message, /permission denied/i);
  });

  test('a suspended vendor disappears from the public catalogue', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_set_vendor_status($1, $2, $3)', [
          VENDORS.two,
          'SUSPENDED',
          'test suspension',
        ]),
      { commit: true }
    );

    const vendors = await asAnon(
      async (c) => (await c.query('select id from public.vendors')).rows
    );
    assert.ok(!vendors.some((v) => v.id === VENDORS.two));
  });
});
