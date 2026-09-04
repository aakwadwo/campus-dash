import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, asUser, closePools, ACTORS, VENDORS } from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * ONE ACCOUNT, SEVERAL CAPABILITIES.
 *
 * Campus Dash has one identity per person — one phone number, one row in
 * public.users — and capabilities are ADDITIVE on top of it. The same account
 * may be an administrator, staff a stall, carry deliveries and order lunch, all
 * at once. my_capabilities() is where that is decided, and it is recomputed
 * from the database on every request.
 *
 * Nothing in the seed exercises this: every seeded actor holds exactly one
 * role, so the interaction between roles on a single account had no coverage at
 * all. That gap is why an administrator with no vendor link visiting /vendor
 * looked like a routing bug.
 *
 * These tests pin both directions:
 *   - holding one capability must not confer another (a vendor is not an admin)
 *   - holding several must not cancel any out (an admin who staffs a stall is
 *     still a customer)
 */
describe('one account, several capabilities', () => {
  /** The multi-role account is built here rather than seeded, then unwound. */
  before(async () => {
    await asService(async (c) => {
      // The administrator now also staffs vendor one...
      await c.query(
        `insert into public.vendor_users (vendor_id, user_id) values ($1, $2)
         on conflict do nothing`,
        [VENDORS.one, ACTORS.admin]
      );
      // ...and is a Customer. This step is NOT optional and that is the point:
      // partner_requires_customer is a foreign key, so even a service-role
      // insert cannot make somebody a Partner without the Customer capability
      // underneath. PARTNER ⇒ CUSTOMER is enforced by the schema, not by a
      // convention a fixture could skip.
      await c.query(
        `insert into public.customer_profiles
           (user_id, student_id_number, class_year, student_id_image_path)
         values ($1, 'TEST-STU-MULTI-1', 'Class of 2027', 'x/id.jpg')
         on conflict (user_id) do nothing`,
        [ACTORS.admin]
      );
      // ...and is an approved Partner. APPROVED requires a recorded decision.
      await c.query(
        `insert into public.partner_profiles
           (user_id, status, face_image_path, is_available, reviewed_at, reviewed_by)
         values ($1, 'APPROVED', 'x/face.jpg', true, now(), $1)
         on conflict (user_id) do update
            set status = 'APPROVED', is_available = true,
                reviewed_at = now(), reviewed_by = $1`,
        [ACTORS.admin]
      );
    });
  });

  after(async () => {
    await asService(async (c) => {
      await c.query('delete from public.vendor_users where vendor_id = $1 and user_id = $2', [
        VENDORS.one,
        ACTORS.admin,
      ]);
      // Partner before Customer: the foreign key is ON DELETE RESTRICT, which
      // is exactly the invariant being unwound here.
      await c.query('delete from public.partner_profiles where user_id = $1', [ACTORS.admin]);
      await c.query('delete from public.customer_profiles where user_id = $1', [ACTORS.admin]);
    });
    await closePools();
  });

  const capabilities = (userId) =>
    asUser(userId, async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c);

  const board = (userId, vendorId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.vendor_order_board($1)', [vendorId])).rows
    );

  // =========================================================================
  // Additive
  // =========================================================================
  test('one account holds admin, vendor, Partner and customer capabilities at once', async () => {
    const caps = await capabilities(ACTORS.admin);

    assert.equal(caps.authenticated, true);
    assert.equal(caps.is_admin, true, 'still an administrator');
    assert.deepEqual(caps.vendor_ids, [VENDORS.one], 'and staffs exactly one stall');
    assert.equal(caps.is_partner, true, 'and is an approved Partner');
    assert.equal(caps.is_customer, true, 'and holds the Customer capability');
    assert.equal(caps.can_order, true, 'and has lost nothing as a customer');
  });

  test('the Customer capability cannot be pulled out from under a Partner', async () => {
    // ON DELETE RESTRICT. "A Partner is always also a Customer" is not a rule
    // somebody has to remember when writing a cleanup script — the database
    // refuses. This is the invariant that makes the upgrade path safe.
    const error = await expectRejection(
      asService((c) =>
        c.query('delete from public.customer_profiles where user_id = $1', [ACTORS.admin])
      )
    );
    assert.match(error.message, /partner_requires_customer/);
  });

  test('vendor membership lists only the stalls actually linked, never all of them', async () => {
    const caps = await capabilities(ACTORS.admin);
    assert.ok(!caps.vendor_ids.includes(VENDORS.two), 'being an admin is not a membership');
    assert.equal(caps.vendor_ids.length, 1);
  });

  // =========================================================================
  // One capability does not confer another
  // =========================================================================
  test('a vendor is not an administrator', async () => {
    const caps = await capabilities(ACTORS.vendor1Staff);
    assert.equal(caps.is_admin, false);
    assert.deepEqual(caps.vendor_ids, [VENDORS.one]);

    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.admin_add_vendor_user($1, $2, $3)', [
          VENDORS.one,
          '+233200000099',
          'trying it on',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });

  test("a vendor cannot read another vendor's board", async () => {
    assert.ok((await board(ACTORS.vendor1Staff, VENDORS.one)).length >= 0, 'their own is allowed');
    assert.deepEqual(
      await board(ACTORS.vendor1Staff, VENDORS.two),
      [],
      'somebody else’s returns nothing at all'
    );
  });

  test('a customer is neither vendor nor administrator', async () => {
    const caps = await capabilities(ACTORS.customerAma);
    assert.equal(caps.is_admin, false);
    assert.deepEqual(caps.vendor_ids, [], 'no stall');
    assert.equal(caps.can_order, true, 'but they can still order');
    assert.equal(caps.is_partner, false, 'and a Customer is NOT thereby a Partner');
    assert.equal(caps.partner_status, 'NOT_APPLIED');

    assert.deepEqual(await board(ACTORS.customerAma, VENDORS.one), [], 'no vendor board');

    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_set_vendor_status($1, $2, $3)', [
          VENDORS.one,
          'SUSPENDED',
          'trying it on',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);
  });

  test('an approved Partner is not thereby a vendor or an administrator', async () => {
    const caps = await capabilities(ACTORS.partnerYaw);
    assert.equal(caps.is_partner, true);
    assert.equal(caps.can_order, true, 'a Partner is always also a Customer');
    assert.equal(caps.is_admin, false);
    assert.deepEqual(caps.vendor_ids, []);
    assert.deepEqual(await board(ACTORS.partnerYaw, VENDORS.one), []);
  });

  // =========================================================================
  // The admin override, pinned deliberately
  // =========================================================================
  test('an administrator may read any vendor board, membership or not', async () => {
    // vendor_order_board is guarded by `is_vendor_staff(...) or is_admin()`.
    // Support cannot help a stall it is not allowed to look at. This is pinned
    // so that widening — or accidentally removing — it is a visible change.
    //
    // The UI does NOT lean on this: getMyVendors() filters by vendor_users, so
    // /vendor lists only stalls the account genuinely staffs.
    assert.deepEqual(
      (await capabilities(ACTORS.admin)).vendor_ids,
      [VENDORS.one],
      'membership stays narrow'
    );
    await board(ACTORS.admin, VENDORS.two); // reachable: no rejection
  });
});
