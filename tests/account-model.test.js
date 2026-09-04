import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  asService,
  asUser,
  asAnon,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  MENU,
  LOCATIONS,
} from './helpers/db.js';
import { expectRejection, orderReadyForDispatch, partnerAccept } from './helpers/flow.js';

/**
 * IDENTITY IS NOT CAPABILITY.
 *
 * One person, one authenticated identity — auth.users.id, and nothing else is
 * ever the key. On top of that identity sit capabilities that are ADDITIVE and
 * independently granted:
 *
 *   CUSTOMER  a customer_profiles row, earned by completing student onboarding
 *   PARTNER   an APPROVED partner_profiles row, which REQUIRES the above
 *   VENDOR    a vendor_users link to a business
 *   ADMIN     users.is_admin
 *
 * The rules this file exists to pin:
 *
 *   PARTNER ⇒ CUSTOMER      always, enforced by a foreign key
 *   CUSTOMER ⇏ PARTNER      until an administrator approves an application
 *   ADMIN   ⇏ CUSTOMER      an administrator is not thereby a shopper
 *   VENDOR  ⇏ CUSTOMER      a stall is a business, not a student
 *   one email → one identity
 *   the stable key is auth.users.id, never email, phone or student ID
 *
 * Everything here runs against the DATABASE — the RPCs and the constraints, as
 * `authenticator`, the role PostgREST itself uses. None of it asserts what a
 * screen renders. A capability that is only enforced in the UI is not enforced.
 */
describe('account model — identity and capabilities', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await asService((c) => c.query("delete from auth.users where phone like '23320888%'"));
    await resetTransactionalState();
    await closePools();
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /** A brand-new signed-in identity: a confirmed phone and nothing else. */
  async function newIdentity(phoneDigits, fullName = null) {
    const id = randomUUID();
    await asService(async (c) => {
      await c.query(
        `insert into auth.users (instance_id, id, aud, role, phone, phone_confirmed_at,
                                 raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                 confirmation_token, recovery_token, email_change_token_new,
                                 email_change, email_change_token_current, phone_change,
                                 phone_change_token, reauthentication_token)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
                 $2, now(), '{"provider":"phone","providers":["phone"]}', $3, now(), now(),
                 '', '', '', '', '', '', '', '')`,
        [id, phoneDigits, JSON.stringify(fullName ? { full_name: fullName } : {})]
      );
    });
    return id;
  }

  const capabilities = (userId) =>
    asUser(userId, async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c);

  const currentCustomerTermsId = () =>
    asService(
      async (c) =>
        (
          await c.query(
            `select id from public.terms_documents
              where audience = 'CUSTOMER' and published_at is not null
              order by version desc limit 1`
          )
        ).rows[0].id
    );

  /** Runs student onboarding as the given identity, committing the result. */
  async function onboard(
    userId,
    {
      fullName = 'Test Student',
      studentId = `TEST-STU-${Math.floor(Math.random() * 1e9)}`,
      classYear = 'Class of 2029',
      email = `s${Math.floor(Math.random() * 1e9)}@example.com`,
      idImage = 'x/student-id.jpg',
      termsId,
    } = {}
  ) {
    const terms = termsId ?? (await currentCustomerTermsId());
    return asUser(
      userId,
      async (c) =>
        (
          await c.query('select * from public.complete_customer_onboarding($1,$2,$3,$4,$5,$6)', [
            fullName,
            studentId,
            classYear,
            email,
            idImage,
            terms,
          ])
        ).rows[0],
      { commit: true }
    );
  }

  /** Attempts an order as the given account. */
  const tryOrder = (userId) =>
    asUser(userId, (c) =>
      c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
        VENDORS.one,
        'DELIVERY',
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
        LOCATIONS.room204,
        null,
      ])
    );

  // =========================================================================
  // 1. A verified phone is an identity and nothing more
  // =========================================================================
  test('a confirmed phone creates an identity with no capability at all', async () => {
    const id = await newIdentity('233208880001', 'Nana Onboarding');

    const caps = await capabilities(id);
    assert.equal(caps.authenticated, true, 'they are signed in');
    assert.equal(caps.user_id, id, 'and the identity is the auth user id');
    assert.equal(caps.is_customer, false);
    assert.equal(caps.can_order, false);
    assert.equal(caps.customer_status, 'NOT_ONBOARDED');
    assert.equal(caps.is_partner, false);
    assert.equal(caps.is_admin, false);
    assert.deepEqual(caps.vendor_ids, []);

    const error = await expectRejection(tryOrder(id));
    assert.match(error.message, /has not completed student onboarding/);
  });

  test('browsing the marketplace needs no account; ordering does', async () => {
    // The catalogue is readable signed out, by policy, not by accident.
    const vendors = await asAnon(
      async (c) => (await c.query("select id from public.vendors where status = 'ACTIVE'")).rows
    );
    assert.ok(vendors.length > 0, 'an anonymous visitor can see the stalls');

    const menu = await asAnon(
      async (c) =>
        (await c.query('select id from public.menu_items where vendor_id = $1', [VENDORS.one])).rows
    );
    assert.ok(menu.length > 0, 'and the menu');

    // But submit_order is not even callable by anon, let alone permitted.
    const error = await expectRejection(
      asAnon((c) =>
        c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
          VENDORS.one,
          'PICKUP',
          JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
          null,
          null,
        ])
      )
    );
    assert.match(error.message, /permission denied|authentication required/i);
  });

  // =========================================================================
  // 2. Onboarding grants the CUSTOMER capability
  // =========================================================================
  test('completing onboarding grants CUSTOMER on the same identity', async () => {
    const id = await newIdentity('233208880002');

    await onboard(id, { fullName: 'Ama Onboarded', studentId: 'TEST-STU-ONB-1' });

    const caps = await capabilities(id);
    assert.equal(caps.user_id, id, 'the SAME auth user id — nothing new was created');
    assert.equal(caps.is_customer, true);
    assert.equal(caps.can_order, true);
    assert.equal(caps.customer_status, 'ONBOARDED');
    assert.equal(caps.student_id_number, 'TEST-STU-ONB-1');

    const order = await asUser(
      id,
      async (c) =>
        (
          await c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
            VENDORS.one,
            'DELIVERY',
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
            LOCATIONS.room204,
            null,
          ])
        ).rows[0],
      { commit: true }
    );
    assert.ok(order.order_id, 'and they can now place an order');
  });

  test('every required student field is enforced by the database', async () => {
    const id = await newIdentity('233208880003');
    const terms = await currentCustomerTermsId();

    const cases = [
      [['', 'S1', 'Class of 2029', 'a@example.com', 'id.jpg'], /full name is required/],
      [['Name', '', 'Class of 2029', 'a@example.com', 'id.jpg'], /student ID number is required/],
      [['Name', 'S1', '', 'a@example.com', 'id.jpg'], /class year is required/],
      [['Name', 'S1', 'Class of 2029', '', 'id.jpg'], /email address is required/],
      [
        ['Name', 'S1', 'Class of 2029', 'not-an-address', 'id.jpg'],
        /does not look like an address/,
      ],
      [
        ['Name', 'S1', 'Class of 2029', 'a@example.com', ''],
        /photograph of your student ID is required/,
      ],
    ];

    for (const [args, expected] of cases) {
      const error = await expectRejection(
        asUser(id, (c) =>
          c.query('select public.complete_customer_onboarding($1,$2,$3,$4,$5,$6)', [
            ...args,
            terms,
          ])
        )
      );
      assert.match(error.message, expected);
    }

    // None of the failures left a half-built capability behind.
    assert.equal((await capabilities(id)).can_order, false);
  });

  test('terms acceptance is part of onboarding, not a screen that can be skipped', async () => {
    const id = await newIdentity('233208880004');

    // A Partner document is not consent to the customer terms.
    const partnerTerms = await asService(
      async (c) =>
        (
          await c.query(
            "select id from public.terms_documents where audience = 'PARTNER' order by version desc limit 1"
          )
        ).rows[0].id
    );
    const wrongAudience = await expectRejection(
      onboard(id, { studentId: 'TEST-STU-ONB-T1', termsId: partnerTerms })
    );
    assert.match(wrongAudience.message, /customer terms must be accepted/);

    const missing = await expectRejection(
      onboard(id, { studentId: 'TEST-STU-ONB-T2', termsId: randomUUID() })
    );
    assert.match(missing.message, /customer terms must be accepted/);

    // The real thing records the acceptance in the SAME transaction as the
    // capability, so a customer who can order has always agreed to something.
    await onboard(id, { studentId: 'TEST-STU-ONB-T3' });
    const accepted = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.terms_acceptances where user_id = $1 and audience = 'CUSTOMER'",
            [id]
          )
        ).rows
    );
    assert.equal(accepted.length, 1, 'the acceptance landed with the capability');
    assert.equal((await capabilities(id)).can_order, true);
  });

  // =========================================================================
  // 3. Customer → Partner is an UPGRADE, not a second account
  // =========================================================================
  test('becoming a Partner keeps the same auth user, email, phone and student facts', async () => {
    const id = await newIdentity('233208880005');
    await onboard(id, {
      fullName: 'Kofi Upgrade',
      studentId: 'TEST-STU-UP-1',
      classYear: 'Class of 2027',
      email: 'kofi.upgrade@example.com',
    });

    const authCountBefore = await asService(
      async (c) => (await c.query('select count(*)::int as n from auth.users')).rows[0].n
    );
    const before = await capabilities(id);
    const profileBefore = await asService(
      async (c) =>
        (await c.query('select * from public.customer_profiles where user_id = $1', [id])).rows[0]
    );

    // The whole application: one document.
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['kofi/face.jpg']), {
      commit: true,
    });
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [id, 'APPROVED', 'face matches']),
      { commit: true }
    );

    const after = await capabilities(id);
    const authCountAfter = await asService(
      async (c) => (await c.query('select count(*)::int as n from auth.users')).rows[0].n
    );
    const profileAfter = await asService(
      async (c) =>
        (await c.query('select * from public.customer_profiles where user_id = $1', [id])).rows[0]
    );

    // NO SECOND ACCOUNT. This is the assertion the whole refactor exists for.
    assert.equal(authCountAfter, authCountBefore, 'not one new auth user was created');
    assert.equal(after.user_id, before.user_id, 'the same auth.users.id');
    assert.equal(after.email, before.email, 'the same email');
    assert.equal(after.phone, before.phone, 'the same phone');
    assert.deepEqual(profileAfter, profileBefore, 'the student profile is untouched');

    // And the capability is genuinely additive.
    assert.equal(after.is_partner, true, 'Partner gained');
    assert.equal(after.is_customer, true, 'Customer retained');
    assert.equal(after.can_order, true, 'a Partner can still order');

    const rows = await asService(
      async (c) =>
        (await c.query('select count(*)::int as n from public.users where id = $1', [id])).rows[0].n
    );
    assert.equal(rows, 1, 'exactly one profile row for this person');
  });

  test('PARTNER ⇒ CUSTOMER — an account with no student profile cannot apply', async () => {
    const id = await newIdentity('233208880006');
    const error = await expectRejection(
      asUser(id, (c) => c.query('select public.partner_apply($1)', ['face.jpg']))
    );
    assert.match(error.message, /complete your student onboarding/i);

    // And the constraint holds even against a service-role insert that skips
    // the function entirely. This is the difference between a rule and an
    // invariant.
    const violation = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.partner_profiles (user_id, status, face_image_path)
           values ($1, 'PENDING_REVIEW', 'face.jpg')`,
          [id]
        )
      )
    );
    assert.match(violation.message, /partner_requires_customer/);
  });

  test('CUSTOMER ⇏ PARTNER — onboarding alone confers no delivery rights', async () => {
    const id = await newIdentity('233208880007');
    await onboard(id, { studentId: 'TEST-STU-UP-2' });

    const caps = await capabilities(id);
    assert.equal(caps.can_order, true);
    assert.equal(caps.is_partner, false);
    assert.equal(caps.partner_status, 'NOT_APPLIED');

    const error = await expectRejection(
      asUser(id, (c) => c.query('select public.partner_set_availability(true)'))
    );
    assert.match(error.message, /not approved/);

    const order = await orderReadyForDispatch();
    const claim = await expectRejection(partnerAccept(order.order_id, id));
    assert.match(claim.message, /partner is not approved/);
  });

  test('a rejected application grants nothing and takes nothing away', async () => {
    const id = await newIdentity('233208880008');
    await onboard(id, { studentId: 'TEST-STU-UP-3' });
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['face.jpg']), {
      commit: true,
    });
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [id, 'REJECTED', 'blurry photo']),
      { commit: true }
    );

    const caps = await capabilities(id);
    assert.equal(caps.is_partner, false, 'rejection grants no Partner capability');
    assert.equal(caps.partner_status, 'REJECTED');
    assert.equal(caps.can_order, true, 'and the Customer capability is untouched');
  });

  // =========================================================================
  // 4. ADMIN is an elevated capability, not an account type
  // =========================================================================
  test('an administrator is NOT automatically a customer', async () => {
    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_admin, true);
    assert.equal(caps.is_customer, false, 'admin does not imply customer');
    assert.equal(caps.can_order, false);

    const error = await expectRejection(tryOrder(ACTORS.admin));
    assert.match(error.message, /has not completed student onboarding/);
  });

  test('an administrator is NOT automatically a Partner or vendor staff', async () => {
    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_partner, false, 'admin does not imply Partner');
    assert.equal(caps.partner_status, 'NOT_APPLIED');
    assert.deepEqual(caps.vendor_ids, [], 'admin does not imply a stall');
  });

  test('ADMIN + CUSTOMER orders normally, and keeps full admin authority', async () => {
    await onboard(ACTORS.admin, {
      fullName: 'Dev Admin',
      studentId: 'TEST-STU-ADMIN-1',
      email: 'admin.customer@example.com',
    });

    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_admin, true, 'still an administrator');
    assert.equal(caps.can_order, true, 'and now also a customer');

    const order = await asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query('select * from public.submit_order($1, $2, $3::jsonb, $4, $5)', [
            VENDORS.one,
            'DELIVERY',
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
            LOCATIONS.room204,
            null,
          ])
        ).rows[0],
      { commit: true }
    );
    assert.ok(order.order_id, 'an admin who is a customer can order');

    // Administrative authorisation is a SEPARATE check and is unaffected.
    const board = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_order_board()')).rows
    );
    assert.ok(Array.isArray(board), 'admin functions still work');
  });

  test('ADMIN + CUSTOMER + PARTNER holds all three and can perform Partner work', async () => {
    await onboard(ACTORS.admin, {
      fullName: 'Dev Admin',
      studentId: 'TEST-STU-ADMIN-2',
      email: 'admin.partner@example.com',
    });
    await asUser(ACTORS.admin, (c) => c.query('select public.partner_apply($1)', ['face.jpg']), {
      commit: true,
    });
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [
          ACTORS.admin,
          'APPROVED',
          'bootstrap partner',
        ]),
      { commit: true }
    );
    await asUser(ACTORS.admin, (c) => c.query('select public.partner_set_availability(true)'), {
      commit: true,
    });

    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_admin, true);
    assert.equal(caps.is_customer, true);
    assert.equal(caps.is_partner, true);

    // A delivery placed by SOMEBODY ELSE from a stall this account does not
    // staff — so no conflict of interest applies and the offer is real.
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    const offers = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(
      offers.some((o) => o.order_id === order.order_id),
      'an admin who is an approved Partner sees eligible offers'
    );

    const claim = await partnerAccept(order.order_id, ACTORS.admin);
    assert.equal(claim.success, true, 'and can accept them');
  });

  // =========================================================================
  // 5. VENDOR is a separate business identity
  // =========================================================================
  test('a vendor staff account is NOT automatically a customer or a Partner', async () => {
    const caps = await capabilities(ACTORS.vendor1Staff);
    assert.deepEqual(caps.vendor_ids, [VENDORS.one], 'it operates one stall');
    assert.equal(caps.is_customer, false, 'vendor does not imply customer');
    assert.equal(caps.can_order, false);
    assert.equal(caps.is_partner, false, 'vendor does not imply Partner');
    assert.equal(caps.is_admin, false, 'vendor does not imply admin');

    const order = await expectRejection(tryOrder(ACTORS.vendor1Staff));
    assert.match(order.message, /has not completed student onboarding/);

    const apply = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) => c.query('select public.partner_apply($1)', ['face.jpg']))
    );
    assert.match(apply.message, /complete your student onboarding/i);
  });

  test('a vendor link never grants ordering, and removing one never revokes it', async () => {
    // A student who also helps at a stall: both capabilities, independently.
    await onboard(ACTORS.vendor1Staff, {
      fullName: 'Muni Owner (test)',
      studentId: 'TEST-STU-VEND-1',
      email: 'muni.student@example.com',
    });

    let caps = await capabilities(ACTORS.vendor1Staff);
    assert.equal(caps.can_order, true, 'the student side is theirs');
    assert.deepEqual(caps.vendor_ids, [VENDORS.one], 'and so is the stall');

    await asService((c) =>
      c.query('delete from public.vendor_users where user_id = $1', [ACTORS.vendor1Staff])
    );
    caps = await capabilities(ACTORS.vendor1Staff);
    assert.deepEqual(caps.vendor_ids, [], 'the stall link is gone');
    assert.equal(caps.can_order, true, 'and the Customer capability survived it');
  });

  test('vendor terms are asked of vendors; customer terms of customers', async () => {
    await asService((c) => c.query('delete from public.terms_acceptances'));

    const vendor = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select * from public.my_outstanding_terms()')).rows
    );
    assert.deepEqual(
      vendor.map((t) => t.audience),
      ['VENDOR'],
      'a stall is not asked to agree to terms about ordering lunch'
    );
  });

  // =========================================================================
  // 6. ONE EMAIL → ONE IDENTITY
  // =========================================================================
  test('a second identity cannot claim an email already in use', async () => {
    const first = await newIdentity('233208880010');
    await onboard(first, { studentId: 'TEST-STU-EM-1', email: 'shared@example.com' });

    const second = await newIdentity('233208880011');
    const error = await expectRejection(
      onboard(second, { studentId: 'TEST-STU-EM-2', email: 'shared@example.com' })
    );
    assert.match(error.message, /already used by another Campus Dash account/);

    // The refused account gained nothing from the attempt.
    assert.equal((await capabilities(second)).can_order, false);
  });

  test('email uniqueness is case-insensitive, because email is', async () => {
    const first = await newIdentity('233208880012');
    await onboard(first, { studentId: 'TEST-STU-EM-3', email: 'Mixed.Case@Example.com' });

    // Stored normalised, so the address means one thing in our records.
    const stored = await asService(
      async (c) => (await c.query('select email from public.users where id = $1', [first])).rows[0]
    );
    assert.equal(stored.email, 'mixed.case@example.com');

    const second = await newIdentity('233208880013');
    const error = await expectRejection(
      onboard(second, { studentId: 'TEST-STU-EM-4', email: 'MIXED.CASE@example.com' })
    );
    assert.match(error.message, /already used by another Campus Dash account/);
  });

  test('set_my_email cannot be used to take an address off another account', async () => {
    const first = await newIdentity('233208880014');
    await onboard(first, { studentId: 'TEST-STU-EM-5', email: 'taken@example.com' });

    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.set_my_email($1)', ['taken@example.com'])
      )
    );
    assert.match(error.message, /users_email_unique|already/i);
  });

  test('the same identity keeps its own address across a re-run of onboarding', async () => {
    const id = await newIdentity('233208880015');
    await onboard(id, { studentId: 'TEST-STU-EM-6', email: 'mine@example.com' });
    // Re-running with the SAME address is not a collision with itself.
    await onboard(id, { studentId: 'TEST-STU-EM-6', email: 'mine@example.com' });

    const caps = await capabilities(id);
    assert.equal(caps.email, 'mine@example.com');
    assert.equal(caps.can_order, true);
  });

  test('one student ID backs one identity', async () => {
    const first = await newIdentity('233208880016');
    await onboard(first, { studentId: 'TEST-STU-DUP-1', email: 'dup1@example.com' });

    const second = await newIdentity('233208880017');
    const error = await expectRejection(
      onboard(second, { studentId: 'TEST-STU-DUP-1', email: 'dup2@example.com' })
    );
    assert.match(error.message, /student ID number is already registered/);
  });

  // =========================================================================
  // 7. The stable key is auth.users.id — never email, phone or student ID
  // =========================================================================
  test('capabilities are keyed on the auth user id, and survive contact changes', async () => {
    const id = await newIdentity('233208880018');
    await onboard(id, { studentId: 'TEST-STU-KEY-1', email: 'before@example.com' });

    // Changing the email — the thing a future OAuth link would match on — does
    // not move, split or duplicate the identity. This is what makes adding
    // Google sign-in later a linking problem rather than a migration.
    await asUser(id, (c) => c.query('select public.set_my_email($1)', ['after@example.com']), {
      commit: true,
    });

    const caps = await capabilities(id);
    assert.equal(caps.user_id, id, 'the identity did not move');
    assert.equal(caps.email, 'after@example.com');
    assert.equal(caps.can_order, true, 'and the capability came with it');

    const profiles = await asService(
      async (c) =>
        (await c.query('select count(*)::int as n from public.users where id = $1', [id])).rows[0].n
    );
    assert.equal(profiles, 1);
  });

  // =========================================================================
  // 8. Delivery conflict rules — UNCHANGED, and re-pinned here
  // =========================================================================
  // These are asserted in tests/partner.test.js too. They are repeated in this
  // file deliberately: the account-model change is exactly the kind of work
  // that would be tempting to "simplify" them out of, and this is the file
  // somebody will read when they wonder why an account cannot see an offer.
  test('a Partner cannot deliver an order they placed themselves', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.partnerYaw });

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(
      !offers.some((o) => o.order_id === order.order_id),
      'their own order is never offered to them'
    );

    // And knowing the id does not help — this is the control, not the hiding.
    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.partnerYaw));
    assert.match(error.message, /cannot deliver an order you placed yourself/);
  });

  test('a Partner cannot deliver an order from a vendor they staff', async () => {
    // Make an approved Partner staff of the stall the order came from.
    await asService((c) =>
      c.query(
        `insert into public.vendor_users (vendor_id, user_id) values ($1, $2)
         on conflict do nothing`,
        [VENDORS.one, ACTORS.partnerYaw]
      )
    );

    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(
      !offers.some((o) => o.order_id === order.order_id),
      "a stall's own staff are never offered its deliveries"
    );

    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.partnerYaw));
    assert.match(error.message, /cannot deliver an order from a vendor you work for/);
  });

  test('an unrelated approved Partner sees the offer and can take it', async () => {
    // THE CD-01003 SCENARIO, done correctly. Customer A places the order,
    // Partner B is neither the customer nor staff of the vendor, and the offer
    // is therefore real. The fix for "no eligible Partner" is a third account,
    // never a weaker rule.
    await asService((c) =>
      c.query(
        `insert into public.vendor_users (vendor_id, user_id) values ($1, $2)
         on conflict do nothing`,
        [VENDORS.one, ACTORS.partnerYaw]
      )
    );

    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });

    // Partner Yaw is conflicted (vendor staff); Partner Adjoa is not.
    const conflicted = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(!conflicted.some((o) => o.order_id === order.order_id));

    const eligible = await asUser(
      ACTORS.partnerAdjoa,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(
      eligible.some((o) => o.order_id === order.order_id),
      'an unrelated approved Partner sees it'
    );

    const claim = await partnerAccept(order.order_id, ACTORS.partnerAdjoa);
    assert.equal(claim.success, true, 'and can accept it');
  });

  // =========================================================================
  // 9. Verification documents — what is actually enforceable
  // =========================================================================
  // The face photograph must be captured live. The SERVER CANNOT PROVE THAT: it
  // receives bytes, and bytes carry no evidence of a camera. The browser form
  // offers no file input, which is a deterrent, and manual admin review is the
  // real control — both are documented in the code that does it.
  //
  // So these assert the controls that DO hold, rather than a guarantee the
  // architecture does not provide.
  test('an application is impossible without a face photograph on record', async () => {
    const id = await newIdentity('233208880020');
    await onboard(id, { studentId: 'TEST-STU-DOC-1' });

    for (const path of ['', '   ']) {
      const error = await expectRejection(
        asUser(id, (c) => c.query('select public.partner_apply($1)', [path]))
      );
      assert.match(error.message, /live face photograph is required/);
    }

    // The column itself refuses a bare application row.
    const caps = await capabilities(id);
    assert.equal(caps.partner_status, 'NOT_APPLIED', 'no half-application was created');
  });

  test('neither photograph is ever handed back to the person who uploaded it', async () => {
    const id = await newIdentity('233208880021');
    await onboard(id, { studentId: 'TEST-STU-DOC-2', idImage: 'secret/student-id.jpg' });
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['secret/face.jpg']), {
      commit: true,
    });

    const application = await asUser(
      id,
      async (c) => (await c.query('select * from public.my_partner_application()')).rows[0]
    );
    const profile = await asUser(
      id,
      async (c) => (await c.query('select * from public.my_customer_profile()')).rows[0]
    );

    for (const view of [application, profile]) {
      assert.ok(
        !JSON.stringify(view).includes('secret/'),
        'a storage key is never returned to a client'
      );
    }
    assert.equal(profile.has_student_id, true, 'only a boolean says one exists');
    assert.equal(application.has_documents, true);
  });

  test('only an administrator can read a verification document path', async () => {
    // customer_profiles holds the student ID path now, so the policy that
    // matters moved with it.
    const asOwner = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.customer_profiles where user_id = $1', [
            ACTORS.customerAma,
          ])
        ).rows
    );
    assert.equal(asOwner.length, 1, 'the owner may read their own row');

    const asOther = await asUser(
      ACTORS.customerKwesi,
      async (c) =>
        (
          await c.query('select * from public.customer_profiles where user_id = $1', [
            ACTORS.customerAma,
          ])
        ).rows
    );
    assert.equal(asOther.length, 0, "and nobody else's");

    const asAdmin = await asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query('select * from public.customer_profiles where user_id = $1', [
            ACTORS.customerAma,
          ])
        ).rows
    );
    assert.equal(asAdmin.length, 1, 'an administrator reviews applications, so they may read it');
  });

  test('no client role can write a capability directly', async () => {
    // The capability is a row. If a client could insert one, onboarding would
    // be decoration. This is the same guarantee tests/schema.test.js asserts
    // across the whole schema, pinned here where it is load-bearing.
    const id = await newIdentity('233208880022');
    const error = await expectRejection(
      asUser(id, (c) =>
        c.query(
          `insert into public.customer_profiles (user_id, student_id_number, class_year, student_id_image_path)
           values ($1, 'SELF-GRANTED', 'Class of 2029', 'x.jpg')`,
          [id]
        )
      )
    );
    assert.match(error.message, /permission denied/i);
    assert.equal((await capabilities(id)).can_order, false);
  });
});
