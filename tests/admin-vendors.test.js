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
import { expectRejection, submitOrder } from './helpers/flow.js';

/**
 * Admin vendor, staff and menu management.
 *
 * Every mutation is checked three ways: it does the right thing, a non-admin
 * cannot do it at all, and it leaves an audit row.
 */
describe('admin — vendors, staff and menus', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  // Cleanup is scoped by ID, never by name: a test renames a seeded vendor,
  // and a name-matched delete once removed the seed row itself.
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

  // --- create --------------------------------------------------------------
  test('an admin creates a vendor, and it starts closed', async () => {
    const vendor = await admin('select * from public.admin_create_vendor($1, $2, $3)', [
      'TEST-ADMIN Kitchen',
      '+233209970001',
      'recruited in person',
    ]);
    assert.equal(vendor.name, 'TEST-ADMIN Kitchen');

    const stored = await asService(
      async (c) =>
        (await c.query("select * from public.vendors where name = 'TEST-ADMIN Kitchen'")).rows[0]
    );
    assert.equal(stored.status, 'DRAFT', 'a new vendor is never live by default');
    assert.equal(stored.is_accepting_orders, false, 'nor open for orders');

    const audit = await auditFor(stored.id);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'VENDOR_CREATE');
    assert.equal(audit[0].admin_user_id, ACTORS.admin);
    assert.equal(audit[0].reason, 'recruited in person');
  });

  test('a customer cannot create a vendor', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_create_vendor($1, $2, $3)', [
          'TEST-ADMIN Sneaky',
          '+233209970002',
          'trying it on',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);

    const count = await asService(async (c) =>
      Number(
        (await c.query("select count(*) from public.vendors where name = 'TEST-ADMIN Sneaky'"))
          .rows[0].count
      )
    );
    assert.equal(count, 0);
  });

  test('vendor registration is closed: nobody can insert a vendor directly', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query(
          "insert into public.vendors (name, phone) values ('TEST-ADMIN Direct', '+233209970003')"
        )
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test('a vendor cannot be created on a phone number already in use', async () => {
    const error = await expectRejection(
      admin('select public.admin_create_vendor($1, $2, $3)', [
        'TEST-ADMIN Duplicate',
        '+233200000011',
        'duplicate phone',
      ])
    );
    assert.match(error.message, /vendors_phone_key/);
  });

  test('a vendor name is required', async () => {
    const error = await expectRejection(
      admin('select public.admin_create_vendor($1, $2, $3)', ['   ', '+233209970004', 'blank name'])
    );
    assert.match(error.message, /name is required/);
  });

  // --- update --------------------------------------------------------------
  test('an admin edits vendor details, and omitted fields are left alone', async () => {
    await admin('select public.admin_update_vendor($1, $2, $3)', [
      VENDORS.one,
      'corrected after visit',
      'Renamed Kitchen',
    ]);

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.vendors where id = $1', [VENDORS.one])).rows[0]
    );
    assert.equal(stored.name, 'Renamed Kitchen');
    assert.equal(stored.phone, '+233200000011', 'phone untouched because it was not supplied');
    assert.equal(stored.walk_minutes_to_campus, 4, 'walk estimate untouched');

    const audit = await auditFor(VENDORS.one);
    const entry = audit.find((a) => a.action === 'VENDOR_UPDATE');
    assert.ok(entry);
    assert.equal(entry.before_state.name, 'Test Kitchen One');
    assert.equal(entry.after_state.name, 'Renamed Kitchen');
  });

  test('a vendor cannot rename themselves', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_update_vendor($1, $2, $3)', [
          VENDORS.one,
          'self serve',
          'Renamed By Vendor',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });

  // --- status --------------------------------------------------------------
  test('suspending a vendor closes them to new orders and blocks submissions', async () => {
    await admin('select public.admin_set_vendor_status($1, $2, $3)', [
      VENDORS.one,
      'SUSPENDED',
      'hygiene complaint',
    ]);

    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.vendors where id = $1', [VENDORS.one])).rows[0]
    );
    assert.equal(stored.status, 'SUSPENDED');
    assert.equal(
      stored.is_accepting_orders,
      false,
      'a suspended vendor cannot be left taking orders'
    );

    const error = await expectRejection(submitOrder({ vendorId: VENDORS.one }));
    assert.match(error.message, /not accepting orders/);

    const gone = await asAnon(
      async (c) =>
        (await c.query('select id from public.vendors where id = $1', [VENDORS.one])).rows
    );
    assert.equal(gone.length, 0, 'and they disappear from the public catalogue');
  });

  test('a DRAFT vendor cannot be opened for orders', async () => {
    const vendorId = await asService(
      async (c) =>
        (
          await c.query(
            "insert into public.vendors (name, phone, status) values ('TEST-ADMIN Draft', '+233209970005', 'DRAFT') returning id"
          )
        ).rows[0].id
    );
    const error = await expectRejection(
      admin('select public.vendor_set_accepting_orders($1, true)', [vendorId])
    );
    assert.match(error.message, /not active/);
  });

  // --- staff ---------------------------------------------------------------
  test('an admin attaches staff by phone, and that grants vendor access', async () => {
    await admin('select public.admin_add_vendor_user($1, $2, $3)', [
      VENDORS.one,
      '+233200000022',
      'new counter staff',
    ]);

    const caps = await asUser(
      ACTORS.customerKwesi,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(caps.vendor_ids, [VENDORS.one], 'the same account gains vendor capability');

    const visible = await asUser(
      ACTORS.customerKwesi,
      async (c) =>
        (await c.query('select id from public.vendors where id = $1', [VENDORS.one])).rows
    );
    assert.equal(visible.length, 1);
  });

  test('attaching a phone with no Campus Dash account is refused with a usable message', async () => {
    const error = await expectRejection(
      admin('select public.admin_add_vendor_user($1, $2, $3)', [
        VENDORS.one,
        '+233209979999',
        'staff who never signed up',
      ])
    );
    assert.match(error.message, /no Campus Dash account.*sign in once first/s);
  });

  test('attaching the same person twice is idempotent and adds no second audit row', async () => {
    await admin('select public.admin_add_vendor_user($1, $2, $3)', [
      VENDORS.one,
      '+233200000022',
      'first time',
    ]);
    await admin('select public.admin_add_vendor_user($1, $2, $3)', [
      VENDORS.one,
      '+233200000022',
      'again by mistake',
    ]);

    const links = await asService(
      async (c) =>
        (
          await c.query('select * from public.vendor_users where vendor_id = $1 and user_id = $2', [
            VENDORS.one,
            ACTORS.customerKwesi,
          ])
        ).rows
    );
    assert.equal(links.length, 1);

    const audit = await auditFor(VENDORS.one);
    assert.equal(audit.filter((a) => a.action === 'VENDOR_STAFF_ADD').length, 1);
  });

  test('removing staff revokes vendor access immediately', async () => {
    await admin('select public.admin_remove_vendor_user($1, $2, $3)', [
      VENDORS.one,
      ACTORS.vendor1Staff,
      'left the job',
    ]);

    const caps = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(caps.vendor_ids, []);

    const orders = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select id from public.orders where vendor_id = $1', [VENDORS.one])).rows
    );
    assert.equal(orders.length, 0, "and they can no longer read the vendor's orders");

    const audit = await auditFor(VENDORS.one);
    assert.ok(audit.some((a) => a.action === 'VENDOR_STAFF_REMOVE'));
  });

  test('a vendor cannot add staff to their own vendor', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_add_vendor_user($1, $2, $3)', [
          VENDORS.one,
          '+233200000022',
          'my friend',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });

  test('a vendor cannot attach themselves to a DIFFERENT vendor', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_add_vendor_user($1, $2, $3)', [
          VENDORS.two,
          '+233200000011',
          'taking over',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });
});
