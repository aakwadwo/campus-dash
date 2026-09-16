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
} from './helpers/db.js';
import { submitOrder, expectRejection } from './helpers/flow.js';

/**
 * A store's own menu.
 *
 * WHAT CHANGED AND WHY. A vendor could mark an item sold out and nothing else:
 * adding a dish, fixing a price or putting a photograph on something meant
 * emailing Campus Dash. The stated reason was that a price must not move under
 * an order somebody is halfway through placing — which price_order() had
 * already made impossible by snapshotting every figure onto the order at
 * submission. The restriction protected nothing and cost a cook the ability to
 * run their own shop.
 *
 * So the first thing this file proves is the property the restriction existed
 * for, and then that a store can do the work.
 *
 * THREE ACTS, KEPT DIFFERENT — sold out, off the menu, deleted. Conflating them
 * is what makes menu management confusing everywhere it is confusing.
 */
describe('vendor menu management', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const asStaff = (sql, params = [], staff = ACTORS.vendor1Staff) =>
    asUser(staff, async (c) => (await c.query(sql, params)).rows[0], { commit: true });

  const menuFor = (vendorId = VENDORS.one, staff = ACTORS.vendor1Staff) =>
    asUser(
      staff,
      async (c) => (await c.query('select * from public.vendor_menu($1)', [vendorId])).rows
    );

  const itemRow = (id) =>
    asService(
      async (c) => (await c.query('select * from public.menu_items where id = $1', [id])).rows[0]
    );

  const create = (overrides = {}) =>
    asStaff(
      'select * from public.vendor_create_menu_item($1, $2, $3, $4, $5)',
      [
        overrides.vendorId ?? VENDORS.one,
        overrides.name ?? 'Banku and Tilapia',
        overrides.price ?? 4200,
        overrides.description ?? null,
        overrides.scanEligible ?? false,
      ],
      overrides.staff ?? ACTORS.vendor1Staff
    );

  // =========================================================================
  // THE PROPERTY THE OLD RESTRICTION EXISTED FOR
  // =========================================================================
  test('changing a price does not move an order that already exists', async () => {
    const order = await submitOrder({
      vendorId: VENDORS.one,
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
      fulfilment: 'PICKUP',
      destination: null,
    });

    const before = await asService(
      async (c) =>
        (
          await c.query('select subtotal_pesewas, total_pesewas from public.orders where id = $1', [
            order.order_id,
          ])
        ).rows[0]
    );
    const lineBefore = await asService(
      async (c) =>
        (
          await c.query(
            'select unit_price_pesewas, line_total_pesewas from public.order_items where order_id = $1',
            [order.order_id]
          )
        ).rows[0]
    );

    // Double the price of the item that order is made of.
    await asStaff('select * from public.vendor_update_menu_item($1, null, $2, null, null)', [
      MENU.jollof,
      7000,
    ]);

    const after = await asService(
      async (c) =>
        (
          await c.query('select subtotal_pesewas, total_pesewas from public.orders where id = $1', [
            order.order_id,
          ])
        ).rows[0]
    );
    const lineAfter = await asService(
      async (c) =>
        (
          await c.query(
            'select unit_price_pesewas, line_total_pesewas from public.order_items where order_id = $1',
            [order.order_id]
          )
        ).rows[0]
    );

    assert.deepEqual(after, before, 'the order keeps what it was quoted');
    assert.deepEqual(lineAfter, lineBefore, 'and so does every line on it');

    // The NEXT order pays the new price, which is the whole point.
    const next = await submitOrder({
      vendorId: VENDORS.one,
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    const nextOrder = await asService(
      async (c) =>
        (await c.query('select subtotal_pesewas from public.orders where id = $1', [next.order_id]))
          .rows[0]
    );
    assert.equal(Number(nextOrder.subtotal_pesewas), 7000);
  });

  // =========================================================================
  // ADDING, EDITING, DELETING
  // =========================================================================
  describe('a store runs its own menu', () => {
    test('adds an item, and it appears to customers straight away', async () => {
      const item = await create({ name: 'Banku and Tilapia', price: 4200 });
      assert.ok(item.id);
      assert.equal(item.name, 'Banku and Tilapia');
      assert.equal(Number(item.price_pesewas), 4200);
      assert.equal(item.is_available, true, 'a new item is on the menu');

      // Through the customer's own read of the table, not the vendor's.
      const visible = await asAnon(
        async (c) =>
          (
            await c.query(
              'select id, price_pesewas from public.menu_items where vendor_id = $1 and id = $2',
              [VENDORS.one, item.id]
            )
          ).rows
      );
      assert.equal(visible.length, 1);
      assert.equal(Number(visible[0].price_pesewas), 4200);
    });

    test('edits a name, a price and a description', async () => {
      const item = await create({ name: 'Wrong Name', price: 1000, description: 'old' });

      await asStaff('select * from public.vendor_update_menu_item($1, $2, $3, $4, null)', [
        item.id,
        'Right Name',
        2500,
        'new',
      ]);

      const after = await itemRow(item.id);
      assert.equal(after.name, 'Right Name');
      assert.equal(Number(after.price_pesewas), 2500);
      assert.equal(after.description, 'new');
    });

    test('deletes an item nobody has ordered', async () => {
      const item = await create({ name: 'A Mistake' });

      const gone = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (await c.query('select public.vendor_delete_menu_item($1) as ok', [item.id])).rows[0].ok,
        { commit: true }
      );
      assert.equal(gone, true);
      assert.equal(await itemRow(item.id), undefined);
    });

    /**
     * REFUSED, WITH A ROUTE OUT. Deleting an item an order references would
     * either orphan those lines or rewrite what somebody was charged for, so
     * the message names the thing that achieves what they actually wanted.
     */
    test('refuses to delete an item somebody has ordered, and says what to do instead', async () => {
      await submitOrder({
        vendorId: VENDORS.one,
        items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
        fulfilment: 'PICKUP',
        destination: null,
      });

      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select public.vendor_delete_menu_item($1)', [MENU.jollof])
        )
      );
      assert.match(error.message, /cannot be deleted/i);
      assert.match(error.message, /take it off the menu/i, 'and the alternative is named');

      // The row survives, so nothing is orphaned.
      assert.ok(await itemRow(MENU.jollof));
    });

    test('the menu reports how many orders reference each item', async () => {
      await submitOrder({
        vendorId: VENDORS.one,
        items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
        fulfilment: 'PICKUP',
        destination: null,
      });

      const menu = await menuFor();
      const jollof = menu.find((m) => m.id === MENU.jollof);
      const fresh = menu.find((m) => m.id === MENU.waakye);

      // The screen offers Delete on one and not the other, rather than letting
      // somebody press it and read an error.
      assert.equal(Number(jollof.order_count), 1);
      assert.equal(Number(fresh.order_count), 0);
    });
  });

  // =========================================================================
  // SOLD OUT vs OFF THE MENU vs DELETED
  // =========================================================================
  describe('three different acts', () => {
    test('sold out keeps the item visible and records why', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'SOLD_OUT',
      ]);

      const row = await itemRow(MENU.jollof);
      assert.equal(row.is_available, false);
      assert.equal(row.unavailable_reason, 'SOLD_OUT');

      // STILL ON THE CUSTOMER'S MENU. A dish that vanishes when it runs out
      // reads as a store that stopped selling it.
      const visible = await asAnon(
        async (c) =>
          (await c.query('select is_available from public.menu_items where id = $1', [MENU.jollof]))
            .rows
      );
      assert.equal(visible.length, 1);
      assert.equal(visible[0].is_available, false);
    });

    test('off the menu is a different reason on the same column', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'WITHDRAWN',
      ]);
      assert.equal((await itemRow(MENU.jollof)).unavailable_reason, 'WITHDRAWN');
    });

    /**
     * THE ONE BEHAVIOUR THE DISTINCTION IS FOR. Running out of jollof is a fact
     * about a service and clears itself; taking a dish off the menu is a
     * decision and does not.
     */
    test('reopening the store clears sold out and leaves withdrawn alone', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'SOLD_OUT',
      ]);
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.waakye,
        'WITHDRAWN',
      ]);

      await asStaff('select * from public.vendor_set_accepting_orders($1, false)', [VENDORS.one]);
      await asStaff('select * from public.vendor_set_accepting_orders($1, true)', [VENDORS.one]);

      assert.equal((await itemRow(MENU.jollof)).is_available, true, 'sold out clears');
      assert.equal((await itemRow(MENU.waakye)).is_available, false, 'withdrawn stays');
      assert.equal((await itemRow(MENU.waakye)).unavailable_reason, 'WITHDRAWN');
    });

    test('putting an item back clears the reason', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'WITHDRAWN',
      ]);
      await asStaff('select * from public.vendor_set_menu_item_available($1, true, $2)', [
        MENU.jollof,
        'SOLD_OUT',
      ]);

      const row = await itemRow(MENU.jollof);
      assert.equal(row.is_available, true);
      assert.equal(row.unavailable_reason, null, 'an available item has no reason to be otherwise');
    });

    test('an unavailable item cannot be ordered, whatever the reason', async () => {
      for (const reason of ['SOLD_OUT', 'WITHDRAWN']) {
        await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
          MENU.jollof,
          reason,
        ]);

        const error = await expectRejection(
          submitOrder({
            vendorId: VENDORS.one,
            items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
            fulfilment: 'PICKUP',
            destination: null,
          })
        );
        assert.match(error.message, /unavailable/i, `${reason} is refused at submission`);

        await asStaff('select * from public.vendor_set_menu_item_available($1, true, $2)', [
          MENU.jollof,
          'SOLD_OUT',
        ]);
      }
    });
  });

  // =========================================================================
  // THE PHOTOGRAPH
  // =========================================================================
  describe('a photograph on a dish', () => {
    test('attaching one, and replacing it, hands back the path that was replaced', async () => {
      const item = await create({ name: 'Photogenic' });

      const first = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (
            await c.query('select public.vendor_set_menu_item_image($1,$2,$3,$4) as previous', [
              item.id,
              'vendor/one/dish-1.jpg',
              'image/jpeg',
              2048,
            ])
          ).rows[0].previous,
        { commit: true }
      );
      assert.equal(first, null, 'there was nothing to replace');

      const second = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (
            await c.query('select public.vendor_set_menu_item_image($1,$2,$3,$4) as previous', [
              item.id,
              'vendor/one/dish-2.jpg',
              'image/jpeg',
              4096,
            ])
          ).rows[0].previous,
        { commit: true }
      );
      // WITHOUT THIS, every retaken photo leaves its predecessor in the bucket
      // for ever — a storage bill that grows with nothing to show for it.
      assert.equal(second, 'vendor/one/dish-1.jpg');

      assert.equal((await itemRow(item.id)).image_path, 'vendor/one/dish-2.jpg');
    });

    test('clearing one hands back the path so the object can go too', async () => {
      const item = await create({ name: 'Briefly Photogenic' });
      await asStaff('select public.vendor_set_menu_item_image($1,$2,$3,$4)', [
        item.id,
        'vendor/one/dish-3.jpg',
        'image/jpeg',
        2048,
      ]);

      const cleared = await asUser(
        ACTORS.vendor1Staff,
        async (c) =>
          (await c.query('select public.vendor_clear_menu_item_image($1) as previous', [item.id]))
            .rows[0].previous,
        { commit: true }
      );
      assert.equal(cleared, 'vendor/one/dish-3.jpg');

      const row = await itemRow(item.id);
      assert.equal(row.image_path, null);
      assert.equal(row.image_content_type, null, 'the three columns move together');
      assert.equal(row.image_byte_size, null);
    });

    /**
     * A path with no content type renders as a broken image on every
     * storefront, so the three columns are held together by a constraint rather
     * than by every writer remembering.
     */
    test('a half-set image is refused by the constraint', async () => {
      const item = await create({ name: 'Half' });
      const error = await expectRejection(
        asService((c) =>
          c.query('update public.menu_items set image_path = $1 where id = $2', ['x.jpg', item.id])
        )
      );
      assert.match(error.message, /menu_items_image_complete/);
    });
  });

  // =========================================================================
  // AUTHORISATION
  // =========================================================================
  describe('authorisation', () => {
    test('a vendor cannot touch another store’s menu, by any route', async () => {
      const calls = [
        [
          'select * from public.vendor_update_menu_item($1, $2, null, null, null)',
          [MENU.jollof, 'Hijacked'],
        ],
        [
          'select * from public.vendor_set_menu_item_available($1, false, $2)',
          [MENU.jollof, 'SOLD_OUT'],
        ],
        ['select public.vendor_delete_menu_item($1)', [MENU.jollof]],
        ['select public.vendor_clear_menu_item_image($1)', [MENU.jollof]],
        [
          'select public.vendor_set_menu_item_image($1,$2,$3,$4)',
          [MENU.jollof, 'x.jpg', 'image/jpeg', 10],
        ],
      ];

      for (const [sql, params] of calls) {
        const error = await expectRejection(
          asUser(ACTORS.vendor2Staff, (c) => c.query(sql, params))
        );
        assert.match(error.message, /not authorised/i, sql);
      }

      assert.equal((await itemRow(MENU.jollof)).name, 'Jollof Rice with Chicken', 'untouched');
    });

    test('a vendor cannot add an item to another store', async () => {
      const error = await expectRejection(
        create({ vendorId: VENDORS.two, staff: ACTORS.vendor1Staff })
      );
      assert.match(error.message, /not authorised for this store/i);
    });

    test('a customer cannot reach any of it', async () => {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.vendor_set_menu_item_available($1, false, $2)', [
            MENU.jollof,
            'SOLD_OUT',
          ])
        )
      );
      assert.match(error.message, /not authorised/i);
    });

    test('a vendor sees only their own menu through vendor_menu()', async () => {
      const theirs = await menuFor(VENDORS.one, ACTORS.vendor2Staff);
      assert.deepEqual(theirs, [], 'another store’s menu is not theirs to read');

      const mine = await menuFor(VENDORS.one, ACTORS.vendor1Staff);
      assert.ok(mine.length > 0);
    });

    test('anon cannot reach the management functions at all', async () => {
      for (const fn of [
        'vendor_menu',
        'vendor_create_menu_item',
        'vendor_update_menu_item',
        'vendor_delete_menu_item',
      ]) {
        const reachable = await asService(
          async (c) =>
            (
              await c.query(
                `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = $1
                    and has_function_privilege('anon', p.oid, 'EXECUTE')`,
                [fn]
              )
            ).rows
        );
        assert.deepEqual(reachable, [], `${fn} must not be anon-callable`);
      }
    });
  });

  // =========================================================================
  // VALIDATION
  // =========================================================================
  describe('what is refused', () => {
    test('an item with no name or no price', async () => {
      assert.match((await expectRejection(create({ name: '   ' }))).message, /name/i);
      assert.match((await expectRejection(create({ price: 0 }))).message, /price/i);
      assert.match((await expectRejection(create({ price: -100 }))).message, /price/i);
    });

    test('a price that is obviously a mistake', async () => {
      // GHS 1000 is the ceiling. Somebody typing a price in pesewas by mistake
      // lands well above it, which is the error this catches.
      const error = await expectRejection(create({ price: 3500000 }));
      assert.match(error.message, /price looks wrong/i);
    });

    test('editing to a nonsense price', async () => {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select * from public.vendor_update_menu_item($1, null, $2, null, null)', [
            MENU.jollof,
            0,
          ])
        )
      );
      assert.match(error.message, /sensible price/i);
    });

    test('an unknown unavailability reason', async () => {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select * from public.vendor_set_menu_item_available($1, false, $2)', [
            MENU.jollof,
            'BECAUSE',
          ])
        )
      );
      assert.match(error.message, /unknown reason/i);
    });
  });
});
