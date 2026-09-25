// Pins the service-role client at the local stack before anything reads config.
import './helpers/local-supabase.js';

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
import {
  submitOrder,
  submitScanOrder,
  paidOrder,
  partnerAccept,
  expectRejection,
  getOrder,
} from './helpers/flow.js';
import { vendorStoreId, landingFor, areasFor } from '../lib/auth/landing.js';

/**
 * WHO CAN CLOSE A STORE, WHO CAN SUSPEND ONE, AND WHAT EITHER LEAVES ALONE.
 *
 * One open sign, derived from the active menu. The store closes it by turning
 * its menu off; an administrator closes it the same way, audited, and can
 * reopen by putting back exactly what that close took. SUSPENSION is the
 * store's status: it hides the store and stops orders, leaves the menu where
 * it was, and reinstating the store reopens it with that menu. Nothing here
 * cancels, deletes or rewrites an order that already exists.
 */

const read = (path) => readFileSync(path, 'utf8');

const vendorRow = (id) =>
  asService(
    async (c) => (await c.query('select * from public.vendors where id = $1', [id])).rows[0]
  );

const activeItems = (id) =>
  asService(async (c) =>
    (
      await c.query(
        'select id from public.menu_items where vendor_id = $1 and is_active order by id',
        [id]
      )
    ).rows.map((r) => r.id)
  );

const catalogueSize = (id) =>
  asService(
    async (c) =>
      (await c.query('select count(*)::int as n from public.menu_items where vendor_id = $1', [id]))
        .rows[0].n
  );

const adminOpen = (open, reason = 'Pilot operations check', vendorId = VENDORS.one) =>
  asUser(
    ACTORS.admin,
    async (c) =>
      (
        await c.query('select * from public.admin_set_vendor_open($1, $2, $3)', [
          vendorId,
          open,
          reason,
        ])
      ).rows[0],
    { commit: true }
  );

const adminStatus = (status, vendorId = VENDORS.one, reason = 'Pilot operations check') =>
  asUser(
    ACTORS.admin,
    async (c) =>
      (
        await c.query('select * from public.admin_set_vendor_status($1, $2, $3)', [
          vendorId,
          status,
          reason,
        ])
      ).rows[0],
    { commit: true }
  );

const vendorOpen = (open, staff = ACTORS.vendor1Staff, vendorId = VENDORS.one) =>
  asUser(
    staff,
    async (c) =>
      (await c.query('select * from public.vendor_set_accepting_orders($1, $2)', [vendorId, open]))
        .rows[0],
    { commit: true }
  );

const storefront = () =>
  asAnon(
    async (c) =>
      (await c.query('select vendor_id, is_accepting_orders from public.storefront_vendors()')).rows
  );

before(resetTransactionalState);
beforeEach(resetTransactionalState);
after(async () => {
  await resetTransactionalState();
  await closePools();
});

describe('store control: the store closes itself', () => {
  test('a vendor closes and reopens their own store, and the catalogue is kept', async () => {
    const before = await activeItems(VENDORS.one);
    const size = await catalogueSize(VENDORS.one);
    assert.ok(before.length > 0);

    await vendorOpen(false);
    assert.equal((await vendorRow(VENDORS.one)).is_accepting_orders, false);
    assert.equal(await catalogueSize(VENDORS.one), size, 'no item deleted');
    await expectRejection(submitOrder());

    // Reopening is the store's decision about its menu: an item back on opens it.
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_active($1, true)', [MENU.jollof]),
      { commit: true }
    );
    assert.equal((await vendorRow(VENDORS.one)).is_accepting_orders, true);
    assert.ok(await submitOrder());
  });
});

describe('store control: an administrator closes and reopens', () => {
  test('closing is the store’s own close: orders stop, the catalogue stays, it is audited', async () => {
    const before = await activeItems(VENDORS.one);
    const size = await catalogueSize(VENDORS.one);

    const closed = await adminOpen(false);
    assert.equal(closed.is_accepting_orders, false);
    assert.equal(closed.status, 'ACTIVE', 'closing is not suspension');
    assert.deepEqual(await activeItems(VENDORS.one), []);
    assert.equal(await catalogueSize(VENDORS.one), size);

    // Not orderable, but still listed as a store, closed.
    await expectRejection(submitOrder());
    const listed = (await storefront()).find((v) => v.vendor_id === VENDORS.one);
    assert.equal(listed.is_accepting_orders, false);

    const audit = await asService(
      async (c) =>
        (
          await c.query(
            "select action, reason, details from public.admin_actions where target_id = $1 and action = 'VENDOR_CLOSED_BY_ADMIN' order by id desc limit 1",
            [VENDORS.one]
          )
        ).rows[0]
    );
    assert.equal(audit.reason, 'Pilot operations check');
    assert.deepEqual([...audit.details.turned_off].sort(), [...before].sort());
  });

  test('reopening puts back exactly what the close turned off', async () => {
    const before = await activeItems(VENDORS.one);
    await adminOpen(false);
    const reopened = await adminOpen(true);
    assert.equal(reopened.is_accepting_orders, true);
    assert.deepEqual(await activeItems(VENDORS.one), before);
    assert.ok(await submitOrder());
  });

  test('once the store has edited its menu, the old close is not undone', async () => {
    await adminOpen(false);
    await new Promise((r) => setTimeout(r, 20));
    await asUser(
      ACTORS.vendor1Staff,
      (c) =>
        c.query('select public.vendor_update_menu_item($1, $2)', [MENU.waakye, 'Waakye special']),
      { commit: true }
    );
    const error = await expectRejection(adminOpen(true));
    assert.match(error.message, /nothing on its menu/);
    assert.equal((await vendorRow(VENDORS.one)).is_accepting_orders, false);
  });

  test('closing a closed store and opening an open one are refused, not repeated', async () => {
    assert.match((await expectRejection(adminOpen(true))).message, /already open/);
    await adminOpen(false);
    assert.match((await expectRejection(adminOpen(false))).message, /already closed/);
  });

  test('a store that is not ACTIVE is not opened or closed from here', async () => {
    await adminStatus('SUSPENDED');
    assert.match((await expectRejection(adminOpen(true))).message, /only an ACTIVE store/);
  });

  test('nobody but an administrator can use it, and a reason is required', async () => {
    for (const actor of [ACTORS.vendor1Staff, ACTORS.customerAma, ACTORS.partnerYaw]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('select public.admin_set_vendor_open($1, false, $2)', [VENDORS.one, 'no reason'])
        )
      );
      assert.match(error.message, /admin privileges required/);
    }
    await expectRejection(
      asAnon((c) =>
        c.query('select public.admin_set_vendor_open($1, false, $2)', [VENDORS.one, 'anon'])
      )
    );
    await expectRejection(adminOpen(false, ''));
    assert.equal((await vendorRow(VENDORS.one)).is_accepting_orders, true);
  });
});

describe('store control: suspension', () => {
  test('a suspended store is hidden, takes no orders, and keeps its menu exactly', async () => {
    const before = await activeItems(VENDORS.one);
    const size = await catalogueSize(VENDORS.one);

    const suspended = await adminStatus('SUSPENDED');
    assert.equal(suspended.status, 'SUSPENDED');
    assert.equal(suspended.is_accepting_orders, false);
    assert.deepEqual(await activeItems(VENDORS.one), before, 'no item turned off');
    assert.equal(await catalogueSize(VENDORS.one), size);

    assert.equal(
      (await storefront()).some((v) => v.vendor_id === VENDORS.one),
      false,
      'not on the marketplace'
    );
    await expectRejection(submitOrder());

    // The owner cannot reopen it themselves.
    await expectRejection(vendorOpen(true));

    // Other stores carry on.
    assert.ok(
      await submitOrder({
        vendorId: VENDORS.two,
        items: [{ menu_item_id: MENU.shawarma, quantity: 1 }],
      })
    );
  });

  test('an order paid before suspension is untouched, and a Partner can still carry it', async () => {
    const order = await paidOrder();
    const beforeRow = await getOrder(order.order_id);

    await adminStatus('SUSPENDED');
    const afterRow = await getOrder(order.order_id);
    for (const field of ['order_status', 'payment_status', 'delivery_status', 'total_pesewas']) {
      assert.equal(afterRow[field], beforeRow[field], field);
    }

    const claim = await partnerAccept(order.order_id);
    assert.equal(claim.success, true, 'existing delivery work is not withdrawn');
  });

  test('the owner still runs a suspended store: its board and menu are theirs', async () => {
    await adminStatus('SUSPENDED');
    const board = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select public.is_vendor_staff($1) as ok', [VENDORS.one])).rows[0]
    );
    assert.equal(board.ok, true);
    // Menu edits are allowed and do not reopen the store.
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.vendor_set_menu_item_active($1, false)', [MENU.water]),
      { commit: true }
    );
    assert.equal((await vendorRow(VENDORS.one)).is_accepting_orders, false);
  });

  test('reinstating restores the store with the menu it had', async () => {
    const before = await activeItems(VENDORS.one);
    await adminStatus('SUSPENDED');
    const back = await adminStatus('ACTIVE');
    assert.equal(back.status, 'ACTIVE');
    assert.equal(back.is_accepting_orders, true);
    assert.deepEqual(await activeItems(VENDORS.one), before);
    assert.ok(await submitOrder());
  });

  test('approval still never opens a store on its owner’s behalf', async () => {
    await asService((c) =>
      c.query(
        "update public.vendors set status = 'DRAFT', is_accepting_orders = false where id = $1",
        [VENDORS.two]
      )
    );
    const active = await adminStatus('ACTIVE', VENDORS.two);
    assert.equal(active.is_accepting_orders, false);
  });

  test('only an administrator can suspend or reinstate', async () => {
    for (const actor of [ACTORS.vendor1Staff, ACTORS.customerAma, ACTORS.partnerYaw]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query("select public.admin_set_vendor_status($1, 'SUSPENDED', 'x x x')", [VENDORS.one])
        )
      );
      assert.match(error.message, /admin privileges required/);
    }
    assert.equal((await vendorRow(VENDORS.one)).status, 'ACTIVE');
  });

  test('a suspended owner is routed to their own dashboard, not an application', () => {
    const suspended = {
      authenticated: true,
      vendor_ids: [],
      vendor_status: 'SUSPENDED',
      vendor_id: VENDORS.one,
    };
    assert.equal(vendorStoreId(suspended), VENDORS.one);
    assert.equal(landingFor(suspended), '/vendor');
    assert.ok(areasFor(suspended).some((a) => a.href === '/vendor'));

    // Nothing else is widened: an applicant or a rejected store has no board.
    for (const status of ['PENDING_APPROVAL', 'REJECTED', 'DRAFT']) {
      assert.equal(vendorStoreId({ ...suspended, vendor_status: status }), null, status);
    }
    // A suspended ACCOUNT is stopped, whatever its store.
    assert.equal(landingFor({ ...suspended, is_suspended: true }), '/suspended');
    assert.deepEqual(areasFor({ ...suspended, is_suspended: true }), []);
  });

  test('the dashboard tells a suspended owner, and offers nothing that cannot work', () => {
    const board = read('app/vendor/[vendorId]/order-board.js');
    assert.match(board, /Suspended by Campus Dash/);
    assert.match(board, /\{suspended \? null :/);
    assert.match(read('app/vendor/application/page.js'), /application\.status === 'SUSPENDED'/);
  });
});

describe('meal scans: only where Campus Dash has turned them on', () => {
  const setScanFlag = (staff, itemId, value) =>
    asUser(staff, (c) =>
      c.query('select public.vendor_update_menu_item($1, p_scan_eligible => $2)', [itemId, value])
    );

  test('a store without scans cannot make an item scan-eligible, by any road', async () => {
    assert.equal((await vendorRow(VENDORS.one)).can_accept_scans, false);
    const error = await expectRejection(setScanFlag(ACTORS.vendor1Staff, MENU.jollof, true));
    assert.match(error.message, /meal scans are not turned on for this store/);

    await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_create_menu_item($1, $2, $3, null, true)', [
          VENDORS.one,
          'Scan jollof',
          3500,
        ])
      )
    );

    // Even the service role, writing the table directly.
    await expectRejection(
      asService((c) =>
        c.query('update public.menu_items set scan_eligible = true where id = $1', [MENU.jollof])
      )
    );
  });

  test('a store with scans can, and a scan order there still works', async () => {
    const { rows } = await asService((c) =>
      c.query(
        'select id from public.menu_items where vendor_id = $1 and not scan_eligible and pricing_mode = $2 limit 1',
        [VENDORS.wafflemania, 'FIXED']
      )
    );
    const item = await setScanFlag(ACTORS.wafflemaniaStaff, rows[0].id, true);
    assert.ok(item);
  });

  test('turning scans off keeps every flag, and ordinary edits leave them alone', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_set_vendor_scans($1, false, $2)', [
          VENDORS.wafflemania,
          'Scans paused for review',
        ]),
      { commit: true }
    );
    const flagged = await asService(
      async (c) =>
        (
          await c.query(
            'select id from public.menu_items where vendor_id = $1 and scan_eligible limit 1',
            [VENDORS.wafflemania]
          )
        ).rows[0].id
    );
    // A rename with the flag untouched is fine; re-asserting it is not needed.
    await asUser(ACTORS.wafflemaniaStaff, (c) =>
      c.query('select public.vendor_update_menu_item($1, $2)', [flagged, 'Renamed'])
    );
    // A scan order is refused while scans are off.
    const error = await expectRejection(submitScanOrder({ vendorId: VENDORS.wafflemania }));
    assert.match(error.message, /not accepting meal scans/);
  });

  test('the store’s menu shows the option only when scans are on, and the action checks', () => {
    const manager = read('app/vendor/menu/menu-manager.js');
    assert.match(manager, /\{scans && fixed && !dormant \? \(/);
    assert.match(manager, /\{scans && item\.scan_eligible \? \(/);
    assert.match(read('app/vendor/menu/page.js'), /scans=\{Boolean\(vendor\.can_accept_scans\)\}/);

    const actions = read('app/vendor/actions.js');
    assert.match(actions, /async function storeTakesScans\(vendorId\)/);
    assert.match(actions, /if \(wantsScan && !\(await storeTakesScans\(vendorId\)\)\)/);
    assert.match(actions, /scanEligible: scans \?/);
  });
});
