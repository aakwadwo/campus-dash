import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  asService,
  asUser,
  asAnon,
  closePools,
  resetTransactionalState,
  ACTORS,
  VENDORS,
  MENU,
} from './helpers/db.js';
import { submitOrder, payOrder, getOrder, expectRejection } from './helpers/flow.js';

/**
 * Store photos, abandoning an unpaid order, the order history summary, and one
 * verified phone on one identity.
 */

after(closePools);

// --- Store photos ------------------------------------------------------------

describe('store photos', () => {
  before(clearImages);
  beforeEach(clearImages);
  after(clearImages);

  async function clearImages() {
    await asService((c) =>
      c.query('delete from public.vendor_images where vendor_id = any($1::uuid[])', [
        [VENDORS.one, VENDORS.two],
      ])
    );
  }

  const add = (actor, vendorId = VENDORS.one) =>
    asUser(
      actor,
      async (c) =>
        (
          await c.query(`select * from public.vendor_add_image($1, $2, 'image/jpeg', 1000, null)`, [
            vendorId,
            `${vendorId}/${randomUUID()}.jpg`,
          ])
        ).rows[0],
      { commit: true }
    );

  const storefrontImages = async (vendorId = VENDORS.one) =>
    asAnon(
      async (c) =>
        (await c.query('select images from public.storefront_vendor($1)', [vendorId])).rows[0]
          .images
    );

  test('no photos: the storefront has an empty gallery, not an error', async () => {
    assert.deepEqual(await storefrontImages(), []);
  });

  test('one photo: it is the primary one', async () => {
    const first = await add(ACTORS.vendor1Staff);
    const images = await storefrontImages();
    assert.equal(images.length, 1);
    assert.equal(images[0].id, first.id);
  });

  test('four photos: the first uploaded leads, the rest follow in order', async () => {
    const added = [];
    for (let i = 0; i < 4; i += 1) added.push(await add(ACTORS.vendor1Staff));

    const images = await storefrontImages();
    assert.deepEqual(
      images.map((image) => image.id),
      added.map((image) => image.id)
    );
  });

  test('a fifth photo is refused', async () => {
    for (let i = 0; i < 4; i += 1) await add(ACTORS.vendor1Staff);
    const error = await expectRejection(add(ACTORS.vendor1Staff));
    assert.match(error.message, /at most 4 photos/);
  });

  test('removing one makes room again, and the new one goes to the end', async () => {
    const added = [];
    for (let i = 0; i < 4; i += 1) added.push(await add(ACTORS.vendor1Staff));

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_delete_image($1)', [added[1].id]),
      { commit: true }
    );
    const fresh = await add(ACTORS.vendor1Staff);

    const ids = (await storefrontImages()).map((image) => image.id);
    assert.equal(ids[0], added[0].id, 'the primary did not move');
    assert.equal(ids.at(-1), fresh.id);
  });

  test('a store can choose another photo as its primary one', async () => {
    const added = [];
    for (let i = 0; i < 3; i += 1) added.push(await add(ACTORS.vendor1Staff));

    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_primary_image($1)', [added[2].id]),
      { commit: true }
    );

    const ids = (await storefrontImages()).map((image) => image.id);
    assert.deepEqual(ids, [added[2].id, added[0].id, added[1].id]);

    // The list's single picture follows the same order.
    const listed = await asAnon(
      async (c) =>
        (await c.query('select vendor_id, image_path from public.storefront_vendors()')).rows
    );
    assert.equal(listed.find((v) => v.vendor_id === VENDORS.one).image_path, added[2].storage_path);
  });

  test('an administrator can add and reorder a store’s photos', async () => {
    const one = await add(ACTORS.admin);
    const two = await add(ACTORS.admin);
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.vendor_set_primary_image($1)', [two.id]),
      { commit: true }
    );
    const ids = (await storefrontImages()).map((image) => image.id);
    assert.deepEqual(ids, [two.id, one.id]);
  });

  test('another store cannot add to, or reorder, this store’s photos', async () => {
    const mine = await add(ACTORS.vendor1Staff);

    const addError = await expectRejection(add(ACTORS.vendor2Staff, VENDORS.one));
    assert.match(addError.message, /not authorised/);

    const orderError = await expectRejection(
      asUser(ACTORS.vendor2Staff, (c) =>
        c.query('select public.vendor_set_primary_image($1)', [mine.id])
      )
    );
    assert.match(orderError.message, /not authorised/);
  });

  test('a customer cannot add a store photo', async () => {
    const error = await expectRejection(add(ACTORS.customerAma));
    assert.match(error.message, /not authorised/);
  });
});

// --- Abandoning an unpaid order ------------------------------------------------

describe('abandoning an unpaid order', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  const abandon = (actor, orderId) =>
    asUser(
      actor,
      async (c) =>
        (await c.query('select * from public.customer_abandon_unpaid_order($1)', [orderId]))
          .rows[0],
      { commit: true }
    );

  test('an unpaid order can be abandoned, and ends CANCELLED with a reason', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    const result = await abandon(ACTORS.customerAma, order.order_id);
    assert.equal(result.success, true);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'CANCELLED');
    assert.equal(stored.payment_status, 'UNPAID', 'nothing was charged, nothing moves');
    assert.match(stored.cancellation_reason, /abandoned the unpaid order/);
  });

  test('an order whose payment failed can be abandoned too', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await asService(async (c) => {
      const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        order.order_id,
        `fail-${order.order_id}`,
      ]);
      await c.query("select public.fail_payment($1, 'declined')", [rows[0].id]);
    });

    const result = await abandon(ACTORS.customerAma, order.order_id);
    assert.equal(result.success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'CANCELLED');
  });

  test('a PAID order is not cancellable this way, and is left exactly as it was', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await payOrder(order.order_id);

    const result = await abandon(ACTORS.customerAma, order.order_id);
    assert.equal(result.success, false);
    assert.match(result.reason, /paid for/);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.payment_status, 'PAID');
    assert.equal(stored.order_status, 'PREPARING', 'the kitchen still has it');

    const events = await asService(
      async (c) =>
        (
          await c.query(
            "select accepted from public.order_events where order_id = $1 and event = 'ORDER_ABANDONED'",
            [order.order_id]
          )
        ).rows
    );
    assert.deepEqual(
      events.map((e) => e.accepted),
      [false],
      'the refusal is logged'
    );
  });

  test('a payment still in flight is not abandoned by this', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await asService((c) =>
      c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        order.order_id,
        `pending-${order.order_id}`,
      ])
    );

    const result = await abandon(ACTORS.customerAma, order.order_id);
    assert.equal(result.success, false);
    assert.match(result.reason, /still being confirmed/);
  });

  test('somebody else’s order is refused outright', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    const error = await expectRejection(abandon(ACTORS.customerKwesi, order.order_id));
    assert.match(error.message, /not your order/);
    assert.equal((await getOrder(order.order_id)).order_status, 'ACCEPTED');
  });
});

// --- The order history ----------------------------------------------------------

describe('the order history', () => {
  before(resetTransactionalState);

  test('each row carries the store’s picture and a one-line summary of the items', async () => {
    const path = `${VENDORS.one}/${randomUUID()}.jpg`;
    await asService((c) =>
      c.query(
        `insert into public.vendor_images (vendor_id, storage_path, content_type, byte_size, sort_order)
         values ($1, $2, 'image/jpeg', 1000, 0)`,
        [VENDORS.one, path]
      )
    );

    try {
      const order = await submitOrder({
        fulfilment: 'PICKUP',
        items: [
          { menu_item_id: MENU.jollof, quantity: 2 },
          { menu_item_id: MENU.water, quantity: 1 },
        ],
      });

      const rows = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.customer_order_list(50)')).rows
      );
      const row = rows.find((r) => r.order_id === order.order_id);

      assert.equal(row.vendor_image_path, path);
      assert.match(row.items_summary, /^2× .+, .+$/);
      assert.equal('customer_phone' in row, false);
      assert.equal('delivery_code' in row, false);
    } finally {
      await asService((c) =>
        c.query('delete from public.vendor_images where storage_path = $1', [path])
      );
    }
  });
});

// --- One verified phone on one identity ------------------------------------------

describe('a verified phone number reaches the profile', () => {
  const made = [];

  after(async () => {
    await asService((c) => c.query('delete from auth.users where id = any($1::uuid[])', [made]));
  });

  async function emailCustomer(phone = null) {
    const id = randomUUID();
    made.push(id);
    await asService(async (c) => {
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                                 created_at, updated_at)
         values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                 'authenticated', $2::text, now(), now(), now())`,
        [id, `phone.sync.${id}@acity.edu.gh`]
      );
      if (phone) {
        await c.query('update public.users set phone = $2 where id = $1', [id, phone]);
      }
    });
    return id;
  }

  const confirmAuthPhone = (id, phone) =>
    asService((c) =>
      c.query('update auth.users set phone = $2, phone_confirmed_at = now() where id = $1', [
        id,
        phone.replace(/^\+/, ''),
      ])
    );

  const sync = (id) =>
    asUser(
      id,
      async (c) => (await c.query('select * from public.sync_my_verified_phone()')).rows[0],
      {
        commit: true,
      }
    );

  const unique = () =>
    `+23324${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;

  test('an unverified number is refused', async () => {
    const id = await emailCustomer();
    const error = await expectRejection(sync(id));
    assert.match(error.message, /verify the phone number first/);
  });

  test('the same number, now verified, stays on the same profile', async () => {
    const phone = unique();
    const id = await emailCustomer(phone);
    await confirmAuthPhone(id, phone);
    const user = await sync(id);
    assert.equal(user.id, id, 'one identity');
    assert.equal(user.phone, phone);
  });

  test('a different number, once verified, replaces the profile number', async () => {
    const before = unique();
    const after = unique();
    const id = await emailCustomer(before);
    await confirmAuthPhone(id, after);
    const user = await sync(id);
    assert.equal(user.phone, after, 'the number a Partner rings is the verified one');
  });

  test('a number another account holds is refused', async () => {
    const taken = unique();
    await emailCustomer(taken);
    const id = await emailCustomer();
    await confirmAuthPhone(id, taken);
    const error = await expectRejection(sync(id));
    assert.match(error.message, /already used by another/);
  });
});
