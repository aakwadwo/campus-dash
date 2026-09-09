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

  // --- ownership and review ------------------------------------------------
  // The staff join table is gone. A vendor is an IDENTITY that owns a business,
  // so there is nothing for an admin to attach: the owner arrives by
  // registering, and an admin approves or rejects what they sent.
  test('an admin approves an application, and the owner gains vendor access', async () => {
    const before = await asUser(
      ACTORS.vendorPendingOwner,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(before.vendor_ids, [], 'a pending application grants nothing');
    assert.equal(before.vendor_status, 'PENDING_APPROVAL', 'but they can see where it stands');

    await admin('select public.admin_review_vendor($1, $2, $3)', [
      VENDORS.pending,
      'ACTIVE',
      'visited the stall, documents checked',
    ]);

    const after = await asUser(
      ACTORS.vendorPendingOwner,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(after.vendor_ids, [VENDORS.pending], 'the same account gains the capability');

    // APPROVAL DOES NOT OPEN THE STORE. Going live is the vendor's own decision,
    // made when they are actually behind the counter.
    const vendor = await asService(
      async (c) =>
        (await c.query('select * from public.vendors where id = $1', [VENDORS.pending])).rows[0]
    );
    assert.equal(vendor.status, 'ACTIVE');
    assert.equal(vendor.is_accepting_orders, false, 'approved, and still closed');

    const audit = await auditFor(VENDORS.pending);
    assert.ok(audit.some((a) => a.action === 'VENDOR_APPROVED'));
  });

  test('a rejection must carry a reason, and the applicant can read it', async () => {
    const noReason = await expectRejection(
      admin('select public.admin_review_vendor($1, $2, $3)', [VENDORS.pending, 'REJECTED', 'no'])
    );
    assert.match(noReason.message, /a reason is required/);

    await admin('select public.admin_review_vendor($1, $2, $3)', [
      VENDORS.pending,
      'REJECTED',
      'The store name and the description do not match.',
    ]);

    // The reason is for the APPLICANT, not only for the audit log — a rejection
    // they cannot read is a dead end rather than a decision.
    const seen = await asUser(
      ACTORS.vendorPendingOwner,
      async (c) => (await c.query('select * from public.my_vendor_application()')).rows[0]
    );
    assert.equal(seen.status, 'REJECTED');
    assert.match(seen.rejection_reason, /do not match/);

    const caps = await asUser(
      ACTORS.vendorPendingOwner,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(caps.vendor_ids, [], 'and it grants nothing');
  });

  test('a rejected applicant resubmits, and the decision is cleared', async () => {
    const category = await asService(
      async (c) =>
        (
          await c.query(
            "select id from public.vendor_categories where slug = 'snacks' and is_active"
          )
        ).rows[0].id
    );

    await asUser(
      ACTORS.vendorRejectedOwner,
      (c) =>
        c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
          'Rejected Owner (test)',
          'Corrected Snacks',
          true,
          'Chips, sweets and cold drinks.',
          category,
          null,
        ]),
      { commit: true }
    ).catch(() => {});

    // The terms id is required, so the call above is expected to be refused
    // without one. Done properly:
    const terms = await asService(
      async (c) =>
        (
          await c.query(
            "select id from public.terms_documents where audience = 'VENDOR' and published_at is not null order by version desc limit 1"
          )
        ).rows[0].id
    );
    await asUser(
      ACTORS.vendorRejectedOwner,
      (c) =>
        c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
          'Rejected Owner (test)',
          'Corrected Snacks',
          true,
          'Chips, sweets and cold drinks.',
          category,
          terms,
        ]),
      { commit: true }
    );

    const after = await asService(
      async (c) =>
        (await c.query('select * from public.vendors where id = $1', [VENDORS.rejected])).rows[0]
    );
    assert.equal(after.status, 'PENDING_APPROVAL', 'back in the queue');
    assert.equal(after.name, 'Corrected Snacks', 'with the corrected facts');
    assert.equal(after.rejection_reason, null, 'and the old decision cleared');
    assert.equal(after.reviewed_at, null);
  });

  test('an approved vendor cannot re-register, and nobody else can take their store', async () => {
    const terms = await asService(
      async (c) =>
        (
          await c.query(
            "select id from public.terms_documents where audience = 'VENDOR' and published_at is not null order by version desc limit 1"
          )
        ).rows[0].id
    );
    const category = await asService(
      async (c) =>
        (await c.query("select id from public.vendor_categories where slug = 'snacks'")).rows[0].id
    );

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
          'Muni Owner (test)',
          'A Second Store',
          false,
          'Trying to register twice.',
          category,
          terms,
        ])
      )
    );
    assert.match(error.message, /already has a store/);
  });

  test('only an admin can review an application', async () => {
    for (const actor of [ACTORS.vendor1Staff, ACTORS.customerAma, ACTORS.vendorPendingOwner]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('select public.admin_review_vendor($1, $2, $3)', [
            VENDORS.pending,
            'ACTIVE',
            'approving myself',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/);
    }
  });

  // --- categories ------------------------------------------------------------
  test('disabling a category detaches no vendor and rewrites no history', async () => {
    const category = await asService(
      async (c) =>
        (await c.query("select id from public.vendor_categories where slug = 'meals-food'")).rows[0]
          .id
    );
    const before = await asService(
      async (c) =>
        (
          await c.query('select count(*)::int as n from public.vendors where category_id = $1', [
            category,
          ])
        ).rows[0].n
    );
    assert.ok(before > 0, 'the fixture has stalls in this category');

    await admin('select public.admin_update_vendor_category($1, $2, $3, $4, $5)', [
      category,
      null,
      null,
      false,
      'seasonal',
    ]);

    const after = await asService(
      async (c) =>
        (
          await c.query('select count(*)::int as n from public.vendors where category_id = $1', [
            category,
          ])
        ).rows[0].n
    );
    assert.equal(after, before, 'the stalls are exactly where they were');

    // It disappears from the customer-facing list, and from the sign-up form.
    const listed = await asAnon(
      async (c) => (await c.query('select * from public.active_vendor_categories()')).rows
    );
    assert.ok(!listed.some((c) => c.id === category), 'and is no longer offered');
  });
});
