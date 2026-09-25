// Pins the service-role client at the local stack before anything reads config.
import './helpers/local-supabase.js';

import { test, describe, before, after } from 'node:test';
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
import { paidOrder, expectRejection } from './helpers/flow.js';
import {
  vendorLocationLine,
  hasVendorLocation,
  readVendorLocation,
  LOCATION_DETAILS_MAX,
} from '../lib/util/vendor-location.js';

/**
 * WHERE A STORE SAYS IT IS.
 *
 * On or off campus, and where exactly, in the store's own words. Stores that
 * existed before the question keep NULL until their owner answers it, and
 * NOTHING about them changes in the meantime: status, opening, scans,
 * catalogue and orders are not read from these columns and not written by the
 * function that sets them.
 */

const setLocation = (userId, vendorId, area, details) =>
  asUser(
    userId,
    async (c) =>
      (
        await c.query('select * from public.vendor_update_location($1, $2, $3)', [
          vendorId,
          area,
          details,
        ])
      ).rows[0],
    { commit: true }
  );

const vendorRow = (id) =>
  asService(
    async (c) => (await c.query('select * from public.vendors where id = $1', [id])).rows[0]
  );

/** Everything about a store except the two new columns and its updated_at. */
async function everythingElse(id) {
  return asService(async (c) => {
    const vendor = (await c.query('select * from public.vendors where id = $1', [id])).rows[0];
    delete vendor.location_area;
    delete vendor.location_details;
    delete vendor.updated_at;
    const menu = (
      await c.query('select * from public.menu_items where vendor_id = $1 order by id', [id])
    ).rows;
    const orders = (
      await c.query('select * from public.orders where vendor_id = $1 order by id', [id])
    ).rows;
    return { vendor, menu, orders };
  });
}

const clearLocations = () =>
  asService((c) =>
    c.query('update public.vendors set location_area = null, location_details = null')
  );

const storefront = (id) =>
  asAnon(async (c) => (await c.query('select * from public.storefront_vendor($1)', [id])).rows[0]);

describe('vendor location', () => {
  before(async () => {
    await resetTransactionalState();
    await clearLocations();
  });

  after(async () => {
    await clearLocations();
    await closePools();
  });

  test('an existing store starts with no location and trades as before', async () => {
    const vendor = await vendorRow(VENDORS.one);
    assert.equal(vendor.location_area, null);
    assert.equal(vendor.location_details, null);
    assert.equal(vendor.status, 'ACTIVE');

    // Still orderable, still paid, still on the storefront — just with nothing to say.
    const order = await paidOrder({});
    assert.ok(order.order_id);
    const shown = await storefront(VENDORS.one);
    assert.equal(shown.location_area, null);
    assert.equal(shown.location_details, null);
  });

  test('the owner adds an ON CAMPUS location, and nothing else about the store moves', async () => {
    await paidOrder({});
    const before = await everythingElse(VENDORS.one);

    const row = await setLocation(
      ACTORS.vendor1Staff,
      VENDORS.one,
      'ON_CAMPUS',
      '  Block B, Ground Floor, near the Student Centre  '
    );
    assert.equal(row.location_area, 'ON_CAMPUS');
    assert.equal(row.location_details, 'Block B, Ground Floor, near the Student Centre');

    assert.deepEqual(await everythingElse(VENDORS.one), before);

    const shown = await storefront(VENDORS.one);
    assert.equal(shown.location_area, 'ON_CAMPUS');
    assert.equal(shown.location_details, 'Block B, Ground Floor, near the Student Centre');
  });

  test('the owner can change it later, including to OFF CAMPUS', async () => {
    await setLocation(ACTORS.vendor1Staff, VENDORS.one, 'ON_CAMPUS', 'Block B');
    const row = await setLocation(
      ACTORS.vendor1Staff,
      VENDORS.one,
      'OFF_CAMPUS',
      'East Legon Hills, near the Academic City entrance'
    );
    assert.equal(row.location_area, 'OFF_CAMPUS');
    assert.equal(row.location_details, 'East Legon Hills, near the Academic City entrance');
  });

  test('a store awaiting approval can say where it is, and stays pending', async () => {
    const row = await setLocation(
      ACTORS.vendorPendingOwner,
      VENDORS.pending,
      'OFF_CAMPUS',
      'Ashongman, opposite the fuel station'
    );
    assert.equal(row.location_area, 'OFF_CAMPUS');
    assert.equal(row.status, 'PENDING_APPROVAL');
  });

  test('a scan store keeps taking scans after saving a location', async () => {
    await setLocation(ACTORS.wafflemaniaStaff, VENDORS.wafflemania, 'ON_CAMPUS', 'Food court');
    const vendor = await vendorRow(VENDORS.wafflemania);
    assert.equal(vendor.can_accept_scans, true);
    assert.equal((await storefront(VENDORS.wafflemania)).can_accept_scans, true);
  });

  test('another store cannot set this store’s location', async () => {
    await clearLocations();
    const error = await expectRejection(
      setLocation(ACTORS.vendor2Staff, VENDORS.one, 'ON_CAMPUS', 'Somewhere else')
    );
    assert.equal(error.code, '42501');
    assert.equal((await vendorRow(VENDORS.one)).location_details, null);
  });

  test('a customer, a Partner and an administrator cannot set it either', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.admin]) {
      const error = await expectRejection(
        setLocation(actor, VENDORS.one, 'ON_CAMPUS', 'Somewhere else')
      );
      assert.equal(error.code, '42501', `actor ${actor}`);
    }
    assert.equal((await vendorRow(VENDORS.one)).location_details, null);
  });

  test('anon cannot even call it', async () => {
    const error = await expectRejection(
      asAnon((c) =>
        c.query('select public.vendor_update_location($1, $2, $3)', [VENDORS.one, 'ON_CAMPUS', 'x'])
      )
    );
    assert.equal(error.code, '42501');
  });

  test('both halves are required, the area is one of two, and the text is bounded', async () => {
    for (const [area, details] of [
      [null, 'Block B'],
      ['ON_CAMPUS', null],
      ['ON_CAMPUS', '   '],
      ['NEAR_CAMPUS', 'Block B'],
      ['ON_CAMPUS', 'x'.repeat(LOCATION_DETAILS_MAX + 1)],
    ]) {
      const error = await expectRejection(
        setLocation(ACTORS.vendor1Staff, VENDORS.one, area, details)
      );
      assert.equal(error.code, '23514', `${area} / ${details?.length}`);
    }
  });

  test('the table itself refuses a value outside the two', async () => {
    const error = await expectRejection(
      asService((c) =>
        c.query("update public.vendors set location_area = 'SOMEWHERE' where id = $1", [
          VENDORS.one,
        ])
      )
    );
    assert.equal(error.code, '23514');
  });

  test('the browse list carries it for every store, NULL where not said', async () => {
    await clearLocations();
    await setLocation(ACTORS.vendor1Staff, VENDORS.one, 'ON_CAMPUS', 'Block B');
    const rows = await asAnon(
      async (c) => (await c.query('select * from public.storefront_vendors()')).rows
    );
    const one = rows.find((r) => r.vendor_id === VENDORS.one);
    const two = rows.find((r) => r.vendor_id === VENDORS.two);
    assert.equal(one.location_details, 'Block B');
    assert.equal(two.location_area, null);
    assert.equal(two.location_details, null);
  });

  test('the owner reads it back through their own application', async () => {
    await setLocation(ACTORS.vendor1Staff, VENDORS.one, 'OFF_CAMPUS', 'Haatso');
    const mine = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select * from public.my_vendor_application()')).rows[0]
    );
    assert.equal(mine.location_area, 'OFF_CAMPUS');
    assert.equal(mine.location_details, 'Haatso');
  });
});

describe('the location line a customer reads', () => {
  test('both halves', () => {
    assert.equal(
      vendorLocationLine({ location_area: 'ON_CAMPUS', location_details: 'Block B' }),
      'On campus · Block B'
    );
    assert.equal(
      vendorLocationLine({ location_area: 'OFF_CAMPUS', location_details: 'East Legon Hills' }),
      'Off campus · East Legon Hills'
    );
  });

  test('nothing said is nothing shown, never a placeholder', () => {
    assert.equal(vendorLocationLine({}), null);
    assert.equal(vendorLocationLine({ location_area: null, location_details: '  ' }), null);
    assert.equal(hasVendorLocation({}), false);
  });

  test('half said is half shown, and still counts as unfinished', () => {
    assert.equal(vendorLocationLine({ location_area: 'ON_CAMPUS' }), 'On campus');
    assert.equal(vendorLocationLine({ location_details: 'Block B' }), 'Block B');
    assert.equal(hasVendorLocation({ location_area: 'ON_CAMPUS' }), false);
  });

  test('the form reader asks for both', () => {
    const form = (entries) => new Map(Object.entries(entries));
    assert.equal(readVendorLocation(form({ location_details: 'Block B' })).ok, false);
    assert.equal(readVendorLocation(form({ location_area: 'ON_CAMPUS' })).ok, false);
    assert.deepEqual(
      readVendorLocation(form({ location_area: 'OFF_CAMPUS', location_details: ' Haatso ' })),
      { ok: true, area: 'OFF_CAMPUS', details: 'Haatso' }
    );
  });
});
