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
  MENU,
} from './helpers/db.js';
import { expectRejection, submitOrder, getOrder } from './helpers/flow.js';

describe('admin — menus and prices', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const admin = (sql, params) =>
    asUser(ACTORS.admin, async (c) => (await c.query(sql, params)).rows[0], { commit: true });

  const auditFor = (targetId) =>
    asService(
      async (c) =>
        (
          await c.query('select * from public.admin_actions where target_id = $1 order by id', [
            targetId,
          ])
        ).rows
    );

  test('an admin creates a menu item priced in integer pesewas', async () => {
    const item = await admin('select * from public.admin_create_menu_item($1, $2, $3, $4, $5)', [
      VENDORS.one,
      'TEST Banku and Tilapia',
      5500,
      'vendor added this dish',
      'With pepper',
    ]);

    assert.equal(item.name, 'TEST Banku and Tilapia');
    assert.equal(item.price_pesewas, 5500);
    assert.equal(item.is_available, true);

    const audit = await auditFor(item.id);
    assert.equal(audit[0].action, 'MENU_ITEM_CREATE');
    assert.equal(audit[0].reason, 'vendor added this dish');
  });

  test('a zero or negative price is refused', async () => {
    for (const price of [0, -100]) {
      const error = await expectRejection(
        admin('select * from public.admin_create_menu_item($1, $2, $3, $4)', [
          VENDORS.one,
          'TEST Free Lunch',
          price,
          'should fail',
        ])
      );
      assert.match(
        error.message,
        /positive whole number of pesewas|menu_items_price_pesewas_check/
      );
    }
  });

  test('a customer cannot create or reprice a menu item', async () => {
    const create = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_create_menu_item($1, $2, $3, $4)', [
          VENDORS.one,
          'TEST Hack',
          1,
          'trying it on',
        ])
      )
    );
    assert.match(create.message, /admin privileges required/);

    const update = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
          MENU.jollof,
          'cheaper please',
          1,
        ])
      )
    );
    assert.match(update.message, /admin privileges required/);

    const stored = await asService(
      async (c) =>
        (await c.query('select price_pesewas from public.menu_items where id = $1', [MENU.jollof]))
          .rows[0]
    );
    assert.equal(stored.price_pesewas, 3500, 'the price is unchanged');
  });

  test('a vendor cannot reprice their own menu (Phase 4 keeps that with the admin)', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_update_menu_item($1, $2, null, null, $3)', [
          MENU.jollof,
          'raising my price',
          9900,
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });

  test('nobody can write menu_items directly, whatever their role', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.admin]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('update public.menu_items set price_pesewas = 1 where id = $1', [MENU.jollof])
        )
      );
      assert.match(error.message, /permission denied/i);
    }
  });

  // --- THE INVARIANT THAT MATTERS -----------------------------------------
  test('repricing through the admin path does NOT change an order already placed', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    assert.equal(order.total_pesewas, 8200, '2 x GH₵35 + 10% (GH₵7) + GH₵5 delivery');

    await admin('select * from public.admin_update_menu_item($1, $2, null, null, $3)', [
      MENU.jollof,
      'vendor raised the price',
      5000,
    ]);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.subtotal_pesewas, 7000, 'the snapshot holds');
    assert.equal(stored.total_pesewas, 8200);

    const items = await asService(
      async (c) =>
        (await c.query('select * from public.order_items where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(items[0].unit_price_pesewas, 3500, 'the ORIGINAL price is preserved');

    const later = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 2 }] });
    assert.equal(later.total_pesewas, 11500, 'a new order uses the new price');
  });

  test('a price change is audited distinctly, with before and after', async () => {
    await admin('select * from public.admin_update_menu_item($1, $2, null, null, $3)', [
      MENU.jollof,
      'ingredient costs rose',
      4200,
    ]);

    const audit = await auditFor(MENU.jollof);
    const entry = audit.find((a) => a.action === 'MENU_ITEM_PRICE_CHANGE');
    assert.ok(entry, 'a price change is logged as a price change, not a generic update');
    assert.equal(entry.before_state.price_pesewas, 3500);
    assert.equal(entry.after_state.price_pesewas, 4200);
  });

  test('a non-price edit is audited as an ordinary update', async () => {
    await admin('select * from public.admin_update_menu_item($1, $2, $3)', [
      MENU.jollof,
      'clearer name',
      'Jollof Rice & Chicken',
    ]);
    const audit = await auditFor(MENU.jollof);
    assert.ok(audit.some((a) => a.action === 'MENU_ITEM_UPDATE'));
    assert.ok(!audit.some((a) => a.action === 'MENU_ITEM_PRICE_CHANGE'));
  });

  test('disabling an item removes it from ordering but keeps history intact', async () => {
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });

    await admin('select * from public.admin_set_menu_item_available($1, false, $2)', [
      MENU.jollof,
      'out of stock',
    ]);

    const error = await expectRejection(
      submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] })
    );
    assert.match(error.message, /unavailable/);

    const items = await asService(
      async (c) =>
        (await c.query('select * from public.order_items where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(
      items[0].name_snapshot,
      'Jollof Rice with Chicken',
      'the placed order is untouched'
    );

    const audit = await auditFor(MENU.jollof);
    assert.ok(audit.some((a) => a.action === 'MENU_ITEM_DISABLE'));
  });

  test('re-enabling an item makes it orderable again', async () => {
    await admin('select * from public.admin_set_menu_item_available($1, false, $2)', [
      MENU.jollof,
      'out of stock',
    ]);
    await admin('select * from public.admin_set_menu_item_available($1, true, $2)', [
      MENU.jollof,
      'back in stock',
    ]);
    const order = await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    assert.ok(order.order_id);
  });

  test('a disabled item disappears from the public catalogue but the vendor still sees it', async () => {
    await admin('select * from public.admin_set_menu_item_available($1, false, $2)', [
      MENU.jollof,
      'out of stock',
    ]);
    // is_available is a column, not a policy — the row stays readable, and the
    // ordering path is what refuses it. Confirm the vendor can still manage it.
    const vendorView = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select is_available from public.menu_items where id = $1', [MENU.jollof]))
          .rows
    );
    assert.equal(vendorView[0].is_available, false);
  });

  test('an item that has never been ordered can be deleted', async () => {
    const item = await admin('select * from public.admin_create_menu_item($1, $2, $3, $4)', [
      VENDORS.one,
      'TEST Mistake Item',
      100,
      'added by mistake',
    ]);

    const deleted = await admin('select public.admin_delete_menu_item($1, $2) as ok', [
      item.id,
      'removing a mistake',
    ]);
    assert.equal(deleted.ok, true);

    const remaining = await asService(
      async (c) => (await c.query('select * from public.menu_items where id = $1', [item.id])).rows
    );
    assert.equal(remaining.length, 0);

    const audit = await auditFor(item.id);
    assert.ok(audit.some((a) => a.action === 'MENU_ITEM_DELETE'));
  });

  test('an item that HAS been ordered cannot be deleted, and says why', async () => {
    await submitOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });

    const error = await expectRejection(
      admin('select public.admin_delete_menu_item($1, $2)', [MENU.jollof, 'tidying up'])
    );
    assert.match(error.message, /1 order line\(s\) reference this item\. Disable it instead\./);

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.menu_items where id = $1', [MENU.jollof])).rows
    );
    assert.equal(stored.length, 1, 'the item survives');
  });

  test('two items on one vendor cannot share a name', async () => {
    const error = await expectRejection(
      admin('select * from public.admin_create_menu_item($1, $2, $3, $4)', [
        VENDORS.one,
        'jollof rice with chicken',
        4000,
        'duplicate name',
      ])
    );
    assert.match(error.message, /menu_items_vendor_name_unique/);
  });

  test('an anonymous visitor sees the catalogue but cannot change it', async () => {
    const items = await asAnon(
      async (c) => (await c.query('select id from public.menu_items')).rows
    );
    assert.ok(items.length > 0);

    // A WHERE clause is needed to get past PostgREST's blanket-update guard and
    // reach the actual permission check underneath.
    const error = await expectRejection(
      asAnon((c) =>
        c.query('update public.menu_items set price_pesewas = 1 where id = $1', [items[0].id])
      )
    );
    assert.match(error.message, /permission denied/i);
  });
});
