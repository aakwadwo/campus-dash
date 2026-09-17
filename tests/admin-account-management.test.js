import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  CATEGORIES,
} from './helpers/db.js';
import { expectRejection, submitOrder } from './helpers/flow.js';

/**
 * Adding and removing accounts from the console.
 *
 * THREE FUNCTIONS AND ONE IDEA. An administrator can create a store that has an
 * account, delete a store that never traded, and delete an account that never
 * ordered — and each one refuses, loudly and by name, the moment deleting would
 * take a money record with it. The refusals are the interesting half of this
 * file: a console button that could remove an order is a hole in the books.
 *
 * WHAT IS NOT TESTED HERE because it is not in SQL: the auth identity itself.
 * lib/admin provisions it through the GoTrue admin API and passes the id in, so
 * these tests create the auth row directly, exactly as the trigger would see it.
 */
describe('admin — creating and deleting accounts', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  /** Every identity this file invents, removed however the test ended. */
  const created = [];

  after(async () => {
    await asService((c) =>
      c.query('delete from public.vendors where owner_user_id = any($1::uuid[])', [created])
    );
    await asService((c) => c.query('delete from auth.users where id = any($1::uuid[])', [created]));
    await resetTransactionalState();
    await closePools();
  });

  let nextPhone = 233209940000;

  /**
   * An identity of the kind GoTrue makes for a confirmed phone sign-in. The
   * trigger provisions public.users from it, which is the state
   * admin_create_vendor_account() expects to be handed.
   */
  async function newPhoneIdentity() {
    const id = await asService(
      async (c) =>
        (
          await c.query(
            `insert into auth.users (id, instance_id, aud, role, phone, phone_confirmed_at,
                                     created_at, updated_at)
             values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                     'authenticated', 'authenticated', $1, now(), now(), now())
             returning id`,
            [String(++nextPhone)]
          )
        ).rows[0].id
    );
    created.push(id);
    return id;
  }

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

  const vendorRow = (id) =>
    asService(
      async (c) => (await c.query('select * from public.vendors where id = $1', [id])).rows[0]
    );

  const userExists = async (id) =>
    asService(
      async (c) =>
        (await c.query('select count(*)::int as n from auth.users where id = $1', [id])).rows[0].n
    );

  // =========================================================================
  // CREATING A STORE THAT HAS AN ACCOUNT
  // =========================================================================
  describe('creating a vendor account', () => {
    /**
     * IT DOES NOT APPROVE ANYTHING. The store lands PENDING_APPROVAL in the
     * same queue an application lands in, so the existing review — and the
     * welcome SMS that goes with it — is what makes it ACTIVE. Creating a store
     * and approving one are two decisions and stay two audit rows.
     */
    test('creates a store awaiting approval, owned by the account given', async () => {
      const owner = await newPhoneIdentity();

      const vendor = await admin(
        'select * from public.admin_create_vendor_account($1,$2,$3,$4,$5,$6,$7)',
        [
          owner,
          'TEST-ADMIN Recruited Kitchen',
          'recruited at the gate',
          'Kofi Owner',
          CATEGORIES.meals,
          'Waakye and jollof',
          true,
        ]
      );

      assert.equal(vendor.status, 'PENDING_APPROVAL', 'it joins the review queue');
      assert.equal(vendor.is_accepting_orders, false, 'and is never open on creation');
      assert.equal(vendor.owner_user_id, owner);
      assert.equal(vendor.applicant_name, 'Kofi Owner');
      assert.ok(vendor.submitted_at, 'it reads as an application, because it is one');

      // The CREDENTIAL is read from the identity, never taken as a parameter.
      const phone = await asService(
        async (c) =>
          (await c.query('select phone from public.users where id = $1', [owner])).rows[0].phone
      );
      assert.equal(vendor.phone, phone);

      const audit = await auditFor(vendor.id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].action, 'VENDOR_ACCOUNT_CREATE');
      assert.equal(audit[0].admin_user_id, ACTORS.admin);
    });

    test('one account owns at most one store', async () => {
      const owner = await newPhoneIdentity();
      await admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
        owner,
        'TEST-ADMIN First Store',
        'recruited at the gate',
      ]);

      const error = await expectRejection(
        admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
          owner,
          'TEST-ADMIN Second Store',
          'recruited at the gate',
        ])
      );
      assert.match(error.message, /already owns a store/i);
    });

    test('an administrator cannot be made a shopkeeper', async () => {
      const error = await expectRejection(
        admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
          ACTORS.admin,
          'TEST-ADMIN Conflicted Kitchen',
          'recruited at the gate',
        ])
      );
      assert.match(error.message, /administrator account cannot own a store/i);
    });

    test('a name and a reason are both required', async () => {
      const owner = await newPhoneIdentity();

      for (const [args, expected] of [
        [[owner, '  ', 'a reason'], /store name is required/i],
        [[owner, 'TEST-ADMIN Nameless', '  '], /reason is required/i],
      ]) {
        const error = await expectRejection(
          admin('select * from public.admin_create_vendor_account($1,$2,$3)', args)
        );
        assert.match(error.message, expected);
      }
    });

    test('a customer cannot create a store for anybody', async () => {
      const owner = await newPhoneIdentity();
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select public.admin_create_vendor_account($1,$2,$3)', [
            owner,
            'TEST-ADMIN Not Theirs',
            'trying it on',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });
  });

  // =========================================================================
  // DELETING A STORE
  // =========================================================================
  describe('deleting a vendor', () => {
    test('a store that never traded goes, and its owner goes with it', async () => {
      const owner = await newPhoneIdentity();
      const vendor = await admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
        owner,
        'TEST-ADMIN Disposable Kitchen',
        'created by mistake',
      ]);

      const result = await admin('select public.admin_delete_vendor($1,$2) as r', [
        vendor.id,
        'created by mistake',
      ]);

      assert.equal(result.r.counts.vendors, 1);
      assert.equal(result.r.counts.owner_account_deleted, true);
      assert.equal(await vendorRow(vendor.id), undefined, 'the store is gone');
      assert.equal(await userExists(owner), 0, 'and so is the identity that owned only it');

      const audit = await auditFor(vendor.id);
      assert.equal(audit.at(-1).action, 'VENDOR_DELETE');
      assert.ok(audit.at(-1).before_state, 'the row it removed is in the audit trail');
    });

    /**
     * ONE CAPABILITY, NOT THE PERSON. Somebody who also buys lunch keeps their
     * account and simply stops having a store — deleting the identity would
     * take a customer with it.
     */
    test('an owner who is also a customer keeps their account', async () => {
      const vendor = await admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
        ACTORS.customerAma,
        'TEST-ADMIN Side Business',
        'she also cooks',
      ]);

      const result = await admin('select public.admin_delete_vendor($1,$2) as r', [
        vendor.id,
        'closing the side business',
      ]);

      assert.equal(result.r.counts.owner_account_deleted, false);
      assert.equal(await userExists(ACTORS.customerAma), 1);
    });

    test('the menu and photographs go with the store, and the paths come back', async () => {
      const owner = await newPhoneIdentity();
      const vendor = await admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
        owner,
        'TEST-ADMIN Stocked Kitchen',
        'created by mistake',
      ]);

      await asService(async (c) => {
        await c.query(
          `insert into public.menu_items (vendor_id, name, price_pesewas, is_available)
           values ($1, 'Test Item', 1000, true)`,
          [vendor.id]
        );
        await c.query(
          `insert into public.vendor_images (vendor_id, storage_path, content_type, byte_size, sort_order)
           values ($1, 'vendor-images/test/one.jpg', 'image/jpeg', 1024, 0)`,
          [vendor.id]
        );
      });

      const result = await admin('select public.admin_delete_vendor($1,$2) as r', [
        vendor.id,
        'created by mistake',
      ]);

      assert.equal(result.r.counts.menu_items, 1);
      assert.equal(result.r.counts.vendor_images, 1);
      // STORAGE IS NOT DELETED IN SQL. storage.objects refuses a SQL delete by
      // design, so the paths are handed back and lib/admin removes them after.
      assert.deepEqual(result.r.storage_paths['vendor-images'], ['vendor-images/test/one.jpg']);

      const left = await asService(
        async (c) =>
          (
            await c.query(
              `select (select count(*)::int from public.menu_items where vendor_id = $1) as items,
                      (select count(*)::int from public.vendor_images where vendor_id = $1) as images`,
              [vendor.id]
            )
          ).rows[0]
      );
      assert.deepEqual(left, { items: 0, images: 0 });
    });

    /**
     * THE REFUSAL THAT MATTERS. An order carries payments and allocations, and
     * those are what reconcile the bank account. Suspension is the control for
     * a store that has traded.
     */
    test('a store with orders is refused, and nothing about it changes', async () => {
      await submitOrder();

      const error = await expectRejection(
        admin('select public.admin_delete_vendor($1,$2) as r', [VENDORS.one, 'tidying up'])
      );
      assert.match(error.message, /order\(s\) belong to this store/i);
      assert.match(error.message, /Suspend the store instead/i);

      assert.ok(await vendorRow(VENDORS.one), 'the store is untouched');
      assert.deepEqual(await auditFor(VENDORS.one), [], 'and a refusal is not an admin action');
    });

    test('a reason is required, because it is what the audit log shows', async () => {
      const owner = await newPhoneIdentity();
      const vendor = await admin('select * from public.admin_create_vendor_account($1,$2,$3)', [
        owner,
        'TEST-ADMIN Reasonless',
        'created by mistake',
      ]);

      const error = await expectRejection(
        admin('select public.admin_delete_vendor($1,$2) as r', [vendor.id, '   '])
      );
      assert.match(error.message, /reason is required/i);
      assert.ok(await vendorRow(vendor.id));
    });

    test('a vendor cannot delete their own store, or anybody else’s', async () => {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select public.admin_delete_vendor($1,$2)', [VENDORS.one, 'closing up'])
        )
      );
      assert.match(error.message, /admin privileges required/i);
    });
  });

  // =========================================================================
  // DELETING AN ACCOUNT
  // =========================================================================
  describe('deleting a customer', () => {
    /** A sign-up that should not have happened: no orders, nothing to keep. */
    async function newCustomer() {
      const id = await asService(
        async (c) =>
          (
            await c.query(
              `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                                       created_at, updated_at)
               values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                       'authenticated', 'authenticated',
                       'delete.me.' || floor(random() * 1e9)::text || '@acity.edu.gh',
                       now(), now(), now())
               returning id`
            )
          ).rows[0].id
      );
      created.push(id);
      await asService((c) =>
        c.query(
          `insert into public.customer_profiles (user_id, affiliation, graduation_year, gender)
           values ($1, 'STUDENT', 2028, 'FEMALE')`,
          [id]
        )
      );
      return id;
    }

    test('an account that never ordered goes, with every capability row on it', async () => {
      const id = await newCustomer();

      const result = await admin('select public.admin_delete_customer($1,$2) as r', [
        id,
        'duplicate sign-up',
      ]);

      assert.equal(result.r.counts.customer_profiles, 1);
      assert.equal(result.r.counts.auth_users, 1);
      assert.equal(await userExists(id), 0);

      const profile = await asService(
        async (c) =>
          (await c.query('select * from public.customer_profiles where user_id = $1', [id])).rows[0]
      );
      assert.equal(profile, undefined, 'the capability went with the identity');

      const audit = await auditFor(id);
      assert.equal(audit.at(-1).action, 'CUSTOMER_DELETE');
    });

    /**
     * PARTNER BEFORE CUSTOMER. partner_requires_customer is ON DELETE RESTRICT,
     * and a cascade from public.users gives no ordering between the two — which
     * is exactly the foreign key that would fail if this deleted them in the
     * order they happen to appear.
     */
    test('a Partner application goes before the customer row it upgrades', async () => {
      const id = await newCustomer();
      await asService((c) =>
        c.query(
          `insert into public.partner_profiles (user_id, status, student_id_image_path)
           values ($1, 'PENDING_REVIEW', $2)`,
          [id, `partner-docs/${id}/student-id.jpg`]
        )
      );

      const result = await admin('select public.admin_delete_customer($1,$2) as r', [
        id,
        'withdrew the application',
      ]);

      assert.equal(result.r.counts.partner_profiles, 1);
      assert.equal(result.r.counts.customer_profiles, 1);
      assert.deepEqual(
        result.r.storage_paths['partner-documents'],
        [`partner-docs/${id}/student-id.jpg`],
        'the document path comes back so the object can be removed after the commit'
      );
      assert.equal(await userExists(id), 0);
    });

    test('an account with orders is refused', async () => {
      await submitOrder();

      const error = await expectRejection(
        admin('select public.admin_delete_customer($1,$2) as r', [ACTORS.customerAma, 'tidying up'])
      );
      assert.match(error.message, /order\(s\) involve this account/i);
      assert.match(error.message, /Suspend the account instead/i);
      assert.equal(await userExists(ACTORS.customerAma), 1);
    });

    test('an administrator is refused, and so is the caller themselves', async () => {
      const error = await expectRejection(
        admin('select public.admin_delete_customer($1,$2) as r', [ACTORS.admin, 'tidying up'])
      );
      // The self check answers first, and either sentence is a refusal.
      assert.match(error.message, /cannot delete their own account/i);
      assert.equal(await userExists(ACTORS.admin), 1);
    });

    test('a store owner is refused until the store is gone', async () => {
      const error = await expectRejection(
        admin('select public.admin_delete_customer($1,$2) as r', [
          ACTORS.vendor1Staff,
          'tidying up',
        ])
      );
      assert.match(error.message, /owns a store/i);
      assert.equal(await userExists(ACTORS.vendor1Staff), 1);
    });

    test('a customer cannot delete another customer', async () => {
      const id = await newCustomer();
      const error = await expectRejection(
        asUser(ACTORS.customerKwesi, (c) =>
          c.query('select public.admin_delete_customer($1,$2)', [id, 'because I can'])
        )
      );
      assert.match(error.message, /admin privileges required/i);
      assert.equal(await userExists(id), 1);
    });
  });
});
