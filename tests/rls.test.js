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
    // 2 x GH₵35.00 = GH₵70.00, + GH₵2 service + GH₵5 delivery = GH₵77.00
    assert.equal(order.total_pesewas, 7700, 'the server priced it, not the client');
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

  test('a Partner still cannot see the customer phone after assignment but before handoff', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(rows.length, 0, 'assignment alone does not reveal the customer');
  });

  test('a Partner CAN see the customer phone once the vendor confirms handoff, and not after completion', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
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

  test('the Partner gets their pickup code only through the entitlement-checked function', async () => {
    const order = await orderReadyForDispatch();
    const accepted = await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select public.get_my_pickup_code($1) as code', [order.order_id])).rows[0]
          .code
    );
    assert.equal(mine, accepted.pickup_code);

    const error = await expectRejection(
      asUser(ACTORS.partnerAdjoa, (c) =>
        c.query('select public.get_my_pickup_code($1)', [order.order_id])
      )
    );
    assert.match(error.message, /no pickup code available/);
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
