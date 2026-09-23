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

  const setActive = (id, active, staff = ACTORS.vendor1Staff) =>
    asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_set_menu_item_active($1, $2)', [id, active]))
          .rows[0],
      { commit: true }
    );

  const setOpen = (open, vendorId = VENDORS.one) =>
    asStaff('select * from public.vendor_set_accepting_orders($1, $2)', [vendorId, open]);

  const storeOpen = (vendorId = VENDORS.one) =>
    asService(
      async (c) =>
        (await c.query('select is_accepting_orders from public.vendors where id = $1', [vendorId]))
          .rows[0].is_accepting_orders
    );

  const activeIds = (vendorId = VENDORS.one) =>
    asService(async (c) =>
      (
        await c.query(
          'select id from public.menu_items where vendor_id = $1 and is_active order by sort_order',
          [vendorId]
        )
      ).rows.map((r) => r.id)
    );

  const customerSees = (vendorId = VENDORS.one) =>
    asAnon(async (c) =>
      (
        await c.query('select id from public.menu_items where vendor_id = $1 order by sort_order', [
          vendorId,
        ])
      ).rows.map((r) => r.id)
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
    /**
     * A NEW ITEM JOINS THE CATALOGUE, NOT THE SERVICE. Adding a dish is not the
     * same decision as starting to sell it — and a default of ON would open a
     * closed store from the menu screen, which is the one thing a vendor
     * building a catalogue at eleven at night must not do by accident.
     */
    test('adds an item, off the menu until the store turns it on', async () => {
      const item = await create({ name: 'Banku and Tilapia', price: 4200 });
      assert.ok(item.id);
      assert.equal(item.name, 'Banku and Tilapia');
      assert.equal(Number(item.price_pesewas), 4200);
      assert.equal(item.is_active, false, 'in the catalogue, not on the menu');
      assert.equal(item.is_available, true, 'and NOT sold out — those are different things');

      // Through the customer's own read of the table, not the vendor's.
      assert.equal((await customerSees()).includes(item.id), false, 'so no customer sees it yet');

      await setActive(item.id, true);
      const visible = await asAnon(
        async (c) =>
          (
            await c.query(
              'select id, price_pesewas from public.menu_items where vendor_id = $1 and id = $2',
              [VENDORS.one, item.id]
            )
          ).rows
      );
      assert.equal(visible.length, 1, 'and sees it the moment it is turned on');
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
  // OFF vs SOLD OUT vs DELETED
  // =========================================================================
  // Three states a customer experiences completely differently, and conflating
  // any two of them is what makes menu management confusing everywhere it is
  // confusing:
  //
  //   OFF              the customer does not see it at all
  //   ON + SOLD OUT    the customer sees it, marked, and cannot order it
  //   ON + AVAILABLE   the customer sees it and can order it
  //
  describe('three different states', () => {
    test('sold out keeps the item ON the menu and records why', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'SOLD_OUT',
      ]);

      const row = await itemRow(MENU.jollof);
      assert.equal(row.is_available, false);
      assert.equal(row.unavailable_reason, 'SOLD_OUT');
      assert.equal(row.is_active, true, 'sold out is NOT off the menu');

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

    test('off the menu hides the item and does NOT mark it sold out', async () => {
      await setActive(MENU.jollof, false);

      const row = await itemRow(MENU.jollof);
      assert.equal(row.is_active, false);
      assert.equal(row.is_available, true, 'off is not a kind of unavailable');
      assert.equal(row.unavailable_reason, null);

      assert.equal((await customerSees()).includes(MENU.jollof), false);
    });

    test('off deletes nothing', async () => {
      const before = await itemRow(MENU.jollof);
      await setActive(MENU.jollof, false);

      const after = await itemRow(MENU.jollof);
      assert.ok(after, 'the row is still there');
      assert.equal(after.name, before.name);
      assert.equal(after.price_pesewas, before.price_pesewas);
      assert.equal(after.description, before.description);
      assert.equal(after.scan_eligible, before.scan_eligible);

      // And the store still sees it, because the catalogue is what the store
      // owns. Only the customer's view narrows.
      const menu = await menuFor();
      assert.ok(menu.some((m) => m.id === MENU.jollof));
    });

    test('an item that is off cannot be ordered even from a stale basket', async () => {
      await setActive(MENU.jollof, false);

      const error = await expectRejection(
        submitOrder({
          vendorId: VENDORS.one,
          items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
          fulfilment: 'PICKUP',
          destination: null,
        })
      );
      assert.match(error.message, /unavailable/i);
    });

    test('an item that is sold out cannot be ordered either', async () => {
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.jollof,
        'SOLD_OUT',
      ]);

      const error = await expectRejection(
        submitOrder({
          vendorId: VENDORS.one,
          items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
          fulfilment: 'PICKUP',
          destination: null,
        })
      );
      assert.match(error.message, /unavailable/i);
    });

    test('a quote is refused for an item that is off, exactly as submission is', async () => {
      await setActive(MENU.jollof, false);
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select * from public.quote_order($1, $2::jsonb, $3)', [
            VENDORS.one,
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
            'PICKUP',
          ])
        )
      );
      assert.match(error.message, /unavailable/i);
    });

    test('sold out is the only unavailability reason there is', async () => {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select * from public.vendor_set_menu_item_available($1, false, $2)', [
            MENU.jollof,
            'WITHDRAWN',
          ])
        )
      );
      assert.match(error.message, /sold out is the only reason/i);
      assert.match(error.message, /turn it off/i, 'and it names the control that does mean that');
    });

    test('turning an item back on does not clear a sold-out mark on a store already open', async () => {
      // The reset belongs to the CLOSED → OPEN transition, not to every switch.
      await asStaff('select * from public.vendor_set_menu_item_available($1, false, $2)', [
        MENU.waakye,
        'SOLD_OUT',
      ]);
      await setActive(MENU.jollof, false);
      await setActive(MENU.jollof, true);

      assert.equal(await storeOpen(), true, 'it never closed');
      assert.equal((await itemRow(MENU.waakye)).is_available, false, 'the mark is left alone');
    });
  });

  // =========================================================================
  // THE STORE IS OPEN IF AND ONLY IF SOMETHING IS ON
  // =========================================================================
  describe('open and closed follow the active menu', () => {
    test('turning one of several off leaves the rest on, and the store open', async () => {
      const before = await activeIds();
      assert.ok(before.length > 2, 'the fixture has several');

      const result = await setActive(MENU.jollof, false);
      assert.equal(result.is_active, false);
      assert.equal(result.store_open, true);

      const after = await activeIds();
      assert.equal(after.includes(MENU.jollof), false);
      assert.equal(after.length, before.length - 1, 'nothing else moved');
      assert.equal(await storeOpen(), true);
    });

    test('turning the LAST one off closes the store', async () => {
      const ids = await activeIds();
      for (const id of ids.slice(0, -1)) await setActive(id, false);
      assert.equal(await storeOpen(), true, 'still one to go');

      const last = await setActive(ids[ids.length - 1], false);
      assert.equal(last.store_open, false);
      assert.equal(await storeOpen(), false);

      // AND THE CATALOGUE IS WHOLE. Closing is not deleting.
      const menu = await menuFor();
      assert.equal(menu.length, ids.length, 'every item is still there');
    });

    test('turning an item on while closed opens the store', async () => {
      await setOpen(false);
      assert.equal(await storeOpen(), false);

      const result = await setActive(MENU.jollof, true);
      assert.equal(result.store_open, true);
      assert.equal(await storeOpen(), true);
      assert.deepEqual(await customerSees(), [MENU.jollof], 'and only that item is on offer');
    });

    test('closing the store turns every active item off and keeps the catalogue', async () => {
      const before = await menuFor();
      await setOpen(false);

      assert.deepEqual(await activeIds(), []);
      assert.equal(await storeOpen(), false);
      assert.equal((await menuFor()).length, before.length, 'nothing was deleted');
      assert.deepEqual(await customerSees(), [], 'and a closed store offers nothing');
    });

    test('closing preserves everything about each item except whether it is on', async () => {
      const before = await itemRow(MENU.jollof);
      await setOpen(false);
      const after = await itemRow(MENU.jollof);

      assert.equal(after.is_active, false);
      assert.equal(after.name, before.name);
      assert.equal(after.price_pesewas, before.price_pesewas);
      assert.equal(after.scan_eligible, before.scan_eligible);
      assert.equal(after.sort_order, before.sort_order);
    });

    test('opening with nothing on is refused, and says what to do', async () => {
      await setOpen(false);

      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select * from public.vendor_set_accepting_orders($1, true)', [VENDORS.one])
        )
      );
      assert.match(error.message, /turn at least one item on/i);
      assert.equal(await storeOpen(), false, 'and the store really is still closed');
      assert.deepEqual(await activeIds(), [], 'nothing was turned on on the vendor’s behalf');
    });

    test('a closed store cannot be ordered from, whatever a stale page shows', async () => {
      await setOpen(false);
      const error = await expectRejection(
        submitOrder({
          vendorId: VENDORS.one,
          items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
          fulfilment: 'PICKUP',
          destination: null,
        })
      );
      assert.match(error.message, /not accepting orders/i);
    });

    test('deleting the last active item closes the store too', async () => {
      const item = await create({ name: 'The Only Thing', price: 1200 });
      await setOpen(false);
      await setActive(item.id, true);
      assert.equal(await storeOpen(), true);

      await asUser(
        ACTORS.vendor1Staff,
        (c) => c.query('select public.vendor_delete_menu_item($1) as ok', [item.id]),
        { commit: true }
      );
      assert.equal(await storeOpen(), false, 'there is nothing left to sell');
    });

    test('one store’s switches never reach another’s', async () => {
      await setOpen(false);
      assert.equal(await storeOpen(VENDORS.one), false);
      assert.equal(await storeOpen(VENDORS.two), true, 'the grill is still trading');
      assert.ok((await activeIds(VENDORS.two)).length > 0);
    });

    /**
     * TWO TAPS IN THE SAME SECOND. A phone and a tablet on one counter is the
     * realistic race, and the invariant has to survive it: the store must not
     * end up open with nothing on, or closed with something on.
     *
     * Every transition takes the vendor row with SELECT … FOR UPDATE before it
     * reads the count, so these serialise rather than both seeing "one other
     * item is still on".
     */
    test('concurrent switches cannot leave an impossible state', async () => {
      const ids = await activeIds();
      for (const id of ids.slice(2)) await setActive(id, false);
      const [a, b] = await activeIds();

      await Promise.all([setActive(a, false), setActive(b, false)]);

      assert.deepEqual(await activeIds(), [], 'both went off');
      assert.equal(await storeOpen(), false, 'and the store followed them');
    });

    test('a close racing a switch-on still agrees with the menu', async () => {
      await Promise.all([setOpen(false), setActive(MENU.waakye, true)]);

      const open = await storeOpen();
      const active = await activeIds();
      assert.equal(open, active.length > 0, 'open if and only if something is on');
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
      assert.match(error.message, /sold out is the only reason/i);
    });

    test('the column itself refuses any reason but sold out', async () => {
      const error = await expectRejection(
        asService((c) =>
          c.query(
            'update public.menu_items set is_available = false, unavailable_reason = $2 where id = $1',
            [MENU.jollof, 'WITHDRAWN']
          )
        )
      );
      assert.match(error.message, /menu_items_unavailable_reason_shape/);
    });
  });
});
