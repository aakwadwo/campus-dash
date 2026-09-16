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
 *   CUSTOMER  a customer_profiles row, earned by completing customer sign-up
 *   PARTNER   an APPROVED partner_profiles row, which REQUIRES the above
 *   VENDOR    vendors.owner_user_id pointing at this identity
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
 * THREE PROOFS, ONE IDENTITY TABLE. A customer proves a verified
 * @acity.edu.gh address, a vendor proves a phone number, an administrator
 * proves a password and has NO PHONE AT ALL. Which door somebody came through
 * has no bearing on what they may then do.
 *
 * Everything here runs against the DATABASE — the RPCs and the constraints, as
 * `authenticator`, the role PostgREST itself uses. None of it asserts what a
 * screen renders. A capability that is only enforced in the UI is not enforced.
 */
describe('account model — identity and capabilities', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await asService((c) =>
      c.query(
        "delete from auth.users where phone like '23320888%' or email like 'fixture%@acity.edu.gh'"
      )
    );
    await resetTransactionalState();
    await closePools();
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * A brand-new signed-in identity, proved by a PHONE. This is the vendor's
   * door, and it grants nothing on its own.
   */
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

  /**
   * A brand-new signed-in identity, proved by a VERIFIED SCHOOL ADDRESS. This is
   * the customer's door — and it still grants nothing until sign-up completes.
   *
   * complete_customer_onboarding() reads the address from auth.users rather than
   * taking it as a parameter, so a fixture that only wrote public.users would be
   * testing a path that cannot happen.
   */
  async function newEmailIdentity(email, fullName = null) {
    const id = randomUUID();
    await asService(async (c) => {
      await c.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                                 raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                 confirmation_token, recovery_token, email_change_token_new,
                                 email_change, email_change_token_current, phone_change,
                                 phone_change_token, reauthentication_token)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
                 $2, now(), '{"provider":"email","providers":["email"]}', $3, now(), now(),
                 '', '', '', '', '', '', '', '')`,
        [id, email, JSON.stringify(fullName ? { full_name: fullName } : {})]
      );
    });
    return id;
  }

  // Unique per call, and unique across re-runs: these rows outlive a single
  // test (they are committed) and public.users is unique on BOTH phone and
  // lower(email), so a fixture that reuses either collides on the second run
  // with an error that says nothing about the rule under test.
  let fixtureSeq = 0;
  const fixtureRun = Date.now() % 100000;
  const next = () => ++fixtureSeq;
  const nextSchoolEmail = (local = 'fixture') => `${local}${fixtureRun}.${next()}@acity.edu.gh`;
  const nextPhone = () =>
    `+2332088${String(fixtureRun).padStart(5, '0')}${String(next()).padStart(2, '0')}`;

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

  /**
   * Runs customer sign-up as the given identity, committing the result.
   *
   * NO EMAIL PARAMETER, NO ID PHOTOGRAPH AND NO STUDENT ID NUMBER. The address
   * is read from auth.users, where the verification code put it; the student ID
   * photograph moved to the Partner application, which is the only review that
   * looks at one; and the typed number went away entirely, because the verified
   * @acity.edu.gh address is the school's own record of who somebody is. The
   * phone is collected because a Partner has to be able to ring.
   *
   * The parameter survives with a default so a caller holding a legacy value can
   * still pass one — which is what the uniqueness test below does.
   */
  async function onboard(
    userId,
    {
      fullName = 'Test Student',
      // A GRADUATION YEAR RATHER THAN A LEVEL. A level is wrong for three of
      // the four years it describes, because nobody comes back in September to
      // move themselves up; the year somebody expects to finish stays true.
      affiliation = 'STUDENT',
      graduationYear = new Date().getFullYear() + 2,
      gender = null,
      phone = null,
      termsId,
      // LEGACY, and still passed through: the column and its unique index
      // outlive the question, so an account created with one keeps it.
      studentId = null,
    } = {}
  ) {
    const terms = termsId ?? (await currentCustomerTermsId());
    return asUser(
      userId,
      async (c) =>
        (
          await c.query(
            'select * from public.complete_customer_onboarding($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              String(fullName).split(' ')[0] || 'Test',
              String(fullName).split(' ').slice(1).join(' ') || 'Student',
              phone ?? nextPhone(),
              affiliation,
              affiliation === 'STAFF' ? null : graduationYear,
              gender,
              terms,
              studentId,
            ]
          )
        ).rows[0],
      { commit: true }
    );
  }

  /** Attempts an order as the given account. A vendor and some items, no more. */
  const tryOrder = (userId) =>
    asUser(userId, (c) =>
      c.query("select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)", [
        VENDORS.one,
        JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
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
    assert.match(error.message, /has not completed customer sign-up/);
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
        c.query("select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)", [
          VENDORS.one,
          JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
        ])
      )
    );
    assert.match(error.message, /permission denied|authentication required/i);
  });

  // =========================================================================
  // 2. Onboarding grants the CUSTOMER capability
  // =========================================================================
  test('completing sign-up grants CUSTOMER on the same identity', async () => {
    const email = nextSchoolEmail();
    const id = await newEmailIdentity(email);

    await onboard(id, { fullName: 'Ama Onboarded', studentId: 'TEST-STU-ONB-1' });

    const caps = await capabilities(id);
    assert.equal(caps.user_id, id, 'the SAME auth user id — nothing new was created');
    assert.equal(caps.is_customer, true);
    assert.equal(caps.can_order, true);
    assert.equal(caps.customer_status, 'ONBOARDED');
    assert.equal(caps.student_id_number, 'TEST-STU-ONB-1', 'a legacy value passed in is kept');
    // `level` is HISTORICAL and is never written any more — a graduation year
    // replaced it, because a level is wrong for three of the four years it
    // describes. An account created now has none.
    assert.equal(caps.level, null);
    assert.equal(caps.email, email, 'the VERIFIED address, read from auth rather than typed');

    const order = await asUser(
      id,
      async (c) =>
        (
          await c.query("select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)", [
            VENDORS.one,
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
          ])
        ).rows[0],
      { commit: true }
    );
    assert.ok(order.order_id, 'and they can now place an order');
  });

  test('the school domain is required, exactly', async () => {
    // A lookalike CONTAINS the domain but does not end with it. The check is
    // anchored for that reason.
    for (const domain of ['gmail.com', 'acity.edu.gh.evil.example', 'notacity.edu.gh.co']) {
      const address = `lookalike${fixtureRun}.${next()}@${domain}`;
      const id = await newEmailIdentity(address);
      const error = await expectRejection(onboard(id));
      assert.match(error.message, /@acity\.edu\.gh address/);
      assert.equal((await capabilities(id)).can_order, false);
    }
  });

  test('an unverified address grants nothing, however plausible it looks', async () => {
    // A phone identity has no confirmed address at all, so sign-up refuses
    // before it looks at a single other field.
    const id = await newIdentity('233208880021');
    const error = await expectRejection(onboard(id));
    assert.match(error.message, /verify your Academic City email/i);
  });

  test('every required student field is enforced by the database', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
    const terms = await currentCustomerTermsId();

    // A STUDENT ID NUMBER IS NOT AMONG THEM any more, and its absence is
    // asserted separately below rather than by a missing row here.
    //
    // [first, last, phone, affiliation, graduationYear]
    const thisYear = new Date().getFullYear();
    const cases = [
      [['', 'Mensah', '+233208880031', 'STUDENT', thisYear + 2], /first name is required/],
      [['Kwame', '', '+233208880031', 'STUDENT', thisYear + 2], /last name is required/],
      [['Kwame', 'Mensah', '', 'STUDENT', thisYear + 2], /phone number is required/],
      [['Kwame', 'Mensah', '0201234567', 'STUDENT', thisYear + 2], /valid phone number/],
      // A STUDENT MUST NAME A YEAR, and it has to be one that could be true.
      [['Kwame', 'Mensah', '+233208880031', 'STUDENT', null], /expect to graduate/],
      [['Kwame', 'Mensah', '+233208880031', 'STUDENT', 1999], /does not look right/],
      [['Kwame', 'Mensah', '+233208880031', 'STUDENT', thisYear + 40], /does not look right/],
    ];

    for (const [args, expected] of cases) {
      const error = await expectRejection(
        asUser(id, (c) =>
          c.query('select public.complete_customer_onboarding($1,$2,$3,$4,$5,$6,$7)', [
            ...args,
            null,
            terms,
          ])
        )
      );
      assert.match(error.message, expected);
    }

    // None of the failures left a half-built capability behind.
    assert.equal((await capabilities(id)).can_order, false);
  });

  test('signing up asks for no student ID number, and grants the capability without one', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
    await onboard(id);

    const caps = await capabilities(id);
    assert.equal(caps.can_order, true, 'a number was never the thing that granted this');
    assert.equal(caps.student_id_number, null);

    // The column is still there, still unique when present, and still holding
    // whatever an account created before the change declared.
    const stored = await asService(
      async (c) =>
        (
          await c.query(
            'select student_id_number from public.customer_profiles where user_id = $1',
            [id]
          )
        ).rows[0]
    );
    assert.equal(stored.student_id_number, null);
  });

  test('terms acceptance is part of sign-up, not a screen that can be skipped', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());

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
    const id = await newEmailIdentity(nextSchoolEmail());
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

    // The whole application: two documents, and nothing the account already has.
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['kofi/student-id.jpg']), {
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
      asUser(id, (c) => c.query('select public.partner_apply($1)', ['student-id.jpg']))
    );
    assert.match(error.message, /finish signing up as a customer/i);

    // And the constraint holds even against a service-role insert that skips
    // the function entirely. This is the difference between a rule and an
    // invariant.
    const violation = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.partner_profiles (user_id, status, student_id_image_path, face_image_path)
           values ($1, 'PENDING_REVIEW', 'id.jpg', 'face.jpg')`,
          [id]
        )
      )
    );
    assert.match(violation.message, /partner_requires_customer/);
  });

  test('CUSTOMER ⇏ PARTNER — onboarding alone confers no delivery rights', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
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
    const id = await newEmailIdentity(nextSchoolEmail());
    await onboard(id, { studentId: 'TEST-STU-UP-3' });
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['student-id.jpg']), {
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
    assert.match(error.message, /has not completed customer sign-up/);
  });

  test('an administrator is NOT automatically a Partner or vendor staff', async () => {
    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_partner, false, 'admin does not imply Partner');
    assert.equal(caps.partner_status, 'NOT_APPLIED');
    assert.deepEqual(caps.vendor_ids, [], 'admin does not imply a stall');
  });

  test('ADMIN + CUSTOMER orders normally, and keeps full admin authority', async () => {
    // The dev admin's own address is a school one, which is what makes this
    // combination reachable at all: a customer capability requires a verified
    // @acity.edu.gh address, and the admin identity already holds one.
    await onboard(ACTORS.admin, { fullName: 'Dev Admin', studentId: 'TEST-STU-ADMIN-1' });

    const caps = await capabilities(ACTORS.admin);
    assert.equal(caps.is_admin, true, 'still an administrator');
    assert.equal(caps.can_order, true, 'and now also a customer');

    const order = await asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query("select * from public.submit_order($1, $2::jsonb, 'PICKUP', null, null)", [
            VENDORS.one,
            JSON.stringify([{ menu_item_id: MENU.jollof, quantity: 1 }]),
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
    await onboard(ACTORS.admin, { fullName: 'Dev Admin', studentId: 'TEST-STU-ADMIN-2' });
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.partner_apply($1)', ['student-id.jpg']),
      {
        commit: true,
      }
    );
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
    assert.match(order.message, /has not completed customer sign-up/);

    const apply = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.partner_apply($1)', ['student-id.jpg'])
      )
    );
    assert.match(apply.message, /finish signing up as a customer/i);
  });

  test('owning a store never grants ordering, and losing one never revokes it', async () => {
    // A student who also runs a stall: both capabilities, independently.
    // The vendor identity signs in by phone and has no address of its own, so a
    // school one is attached first — which is the real sequence too: somebody
    // who registered a stall and later signs up as a customer.
    const student = nextSchoolEmail('muni.student');
    await asService((c) =>
      c.query(`update auth.users set email = $2, email_confirmed_at = now() where id = $1`, [
        ACTORS.vendor1Staff,
        student,
      ])
    );
    await onboard(ACTORS.vendor1Staff, {
      fullName: 'Muni Owner (test)',
      studentId: 'TEST-STU-VEND-1',
      phone: '+233200000011',
    });

    let caps = await capabilities(ACTORS.vendor1Staff);
    assert.equal(caps.can_order, true, 'the student side is theirs');
    assert.deepEqual(caps.vendor_ids, [VENDORS.one], 'and so is the stall');

    await asService((c) =>
      c.query('update public.vendors set owner_user_id = null where id = $1', [VENDORS.one])
    );
    caps = await capabilities(ACTORS.vendor1Staff);
    assert.deepEqual(caps.vendor_ids, [], 'the stall is gone');
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
  // The address is no longer something a sign-up form types in — it is the
  // CREDENTIAL, proved by a verification code and read out of auth.users. So
  // uniqueness is enforced twice: GoTrue will not issue a second identity for
  // an address it already knows, and users_email_unique refuses the profile row
  // even if something bypassed GoTrue entirely.
  test('a second identity cannot claim an address already in use', async () => {
    const shared = nextSchoolEmail('shared');
    const first = await newEmailIdentity(shared);
    await onboard(first, { studentId: 'TEST-STU-EM-1' });

    // TWO LAYERS, and the first one is not ours. GoTrue itself will not issue a
    // second identity for an address it already knows, so the collision is
    // refused before any Campus Dash code runs.
    const atAuth = await expectRejection(newEmailIdentity(shared));
    assert.match(atAuth.message, /users_email_partial_key|duplicate key/i);

    // And the profile table refuses it independently, which is what protects us
    // if an identity ever arrives by some other door.
    const second = await newEmailIdentity(nextSchoolEmail('other'));
    await onboard(second, { studentId: 'TEST-STU-EM-1B' });
    const atProfile = await expectRejection(
      asUser(second, (c) => c.query('select public.set_my_email($1)', [shared]))
    );
    assert.match(atProfile.message, /users_email_unique|already/i);
  });

  test('address uniqueness is case-insensitive, because email is', async () => {
    const mixed = nextSchoolEmail('Mixed.Case');
    const first = await newEmailIdentity(mixed);
    await onboard(first, { studentId: 'TEST-STU-EM-3' });

    // Stored normalised, so the address means one thing in our records.
    const stored = await asService(
      async (c) => (await c.query('select email from public.users where id = $1', [first])).rows[0]
    );
    assert.equal(stored.email, mixed.toLowerCase());

    const second = await newEmailIdentity(nextSchoolEmail('other'));
    await onboard(second, { studentId: 'TEST-STU-EM-4' });
    const error = await expectRejection(
      asUser(second, (c) => c.query('select public.set_my_email($1)', [mixed.toUpperCase()]))
    );
    assert.match(error.message, /users_email_unique|already/i);
  });

  test('set_my_email cannot be used to take an address off another account', async () => {
    const taken = nextSchoolEmail('taken');
    const first = await newEmailIdentity(taken);
    await onboard(first, { studentId: 'TEST-STU-EM-5' });

    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) => c.query('select public.set_my_email($1)', [taken]))
    );
    assert.match(error.message, /users_email_unique|already/i);
  });

  test('the same identity keeps its own address across a re-run of sign-up', async () => {
    const mine = nextSchoolEmail('mine');
    const id = await newEmailIdentity(mine);
    await onboard(id, { studentId: 'TEST-STU-EM-6' });
    // Re-running is not a collision with itself.
    await onboard(id, { studentId: 'TEST-STU-EM-6' });

    const caps = await capabilities(id);
    assert.equal(caps.email, mine.toLowerCase());
    assert.equal(caps.can_order, true);
  });

  /**
   * Nothing new writes this column, but the accounts created before it stopped
   * being asked for still carry one — and the uniqueness that guarded it still
   * has to hold, or two legacy rows could collide on a later migration. The
   * index is partial now, so "no number" is not a value that collides.
   */
  test('a legacy student ID still backs exactly one identity', async () => {
    const first = await newEmailIdentity(nextSchoolEmail());
    await onboard(first, { studentId: 'TEST-STU-DUP-1' });

    const second = await newEmailIdentity(nextSchoolEmail());
    const error = await expectRejection(onboard(second, { studentId: 'TEST-STU-DUP-1' }));
    assert.match(error.message, /student ID number is already registered/);
  });

  test('accounts with no student ID number do not collide with one another', async () => {
    const first = await newEmailIdentity(nextSchoolEmail());
    await onboard(first);
    const second = await newEmailIdentity(nextSchoolEmail());
    await onboard(second);

    assert.equal((await capabilities(first)).can_order, true);
    assert.equal((await capabilities(second)).can_order, true);
  });

  test('one phone number backs one identity, even though it is not the credential', async () => {
    // A customer's phone is a profile fact, not a login. It is still unique:
    // one number must not describe two people, or a Partner arriving at a door
    // would have no way to tell whose it is.
    const phone = nextPhone();
    const first = await newEmailIdentity(nextSchoolEmail());
    await onboard(first, { studentId: 'TEST-STU-PH-1', phone });

    const second = await newEmailIdentity(nextSchoolEmail());
    const error = await expectRejection(onboard(second, { studentId: 'TEST-STU-PH-2', phone }));
    assert.match(error.message, /users_phone_key|already/i);
  });

  // =========================================================================
  // 7. The stable key is auth.users.id — never email, phone or student ID
  // =========================================================================
  test('capabilities are keyed on the auth user id, and survive contact changes', async () => {
    const id = await newEmailIdentity(nextSchoolEmail('before'));
    await onboard(id, { studentId: 'TEST-STU-KEY-1' });

    // Changing the email — the thing a future OAuth link would match on — does
    // not move, split or duplicate the identity. This is what makes adding
    // Google sign-in later a linking problem rather than a migration.
    const after = nextSchoolEmail('after');
    await asUser(id, (c) => c.query('select public.set_my_email($1)', [after]), {
      commit: true,
    });

    const caps = await capabilities(id);
    assert.equal(caps.user_id, id, 'the identity did not move');
    assert.equal(caps.email, after.toLowerCase());
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

  test('a Partner cannot deliver an order from a store they own', async () => {
    // The order is walked to READY by the seeded owner FIRST, and only then does
    // the store change hands — handing it over earlier would break the setup
    // rather than the rule under test.
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await asService((c) =>
      c.query('update public.vendors set owner_user_id = $2 where id = $1', [
        VENDORS.one,
        ACTORS.partnerYaw,
      ])
    );

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.ok(
      !offers.some((o) => o.order_id === order.order_id),
      "a stall's own owner is never offered its deliveries"
    );

    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.partnerYaw));
    assert.match(error.message, /cannot deliver an order from a store you own/);
  });

  test('an unrelated approved Partner sees the offer and can take it', async () => {
    // THE CD-01003 SCENARIO, done correctly. Customer A places the order,
    // Partner B is neither the customer nor staff of the vendor, and the offer
    // is therefore real. The fix for "no eligible Partner" is a third account,
    // never a weaker rule.
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await asService((c) =>
      c.query('update public.vendors set owner_user_id = $2 where id = $1', [
        VENDORS.one,
        ACTORS.partnerYaw,
      ])
    );

    // Partner Yaw is conflicted (owns the store); Partner Adjoa is not.
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
  // ONE DOCUMENT, and no face photograph. A Partner already holds the CUSTOMER
  // capability, which means a verified @acity.edu.gh address has established who
  // they are; a second photograph proved nothing that had not and was the most
  // sensitive thing Campus Dash stored.
  //
  // The server cannot prove a photograph was taken now rather than found — it
  // receives bytes, and bytes carry no evidence of a camera. So these assert the
  // controls that DO hold: the document is required, and it never comes back out.
  test('an application is impossible without a student ID on record', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
    await onboard(id, { studentId: 'TEST-STU-DOC-1' });

    for (const path of ['', '   ']) {
      const error = await expectRejection(
        asUser(id, (c) => c.query('select public.partner_apply($1)', [path]))
      );
      assert.match(error.message, /photograph of your student ID is required/);
    }

    // The column itself refuses a bare application row.
    const caps = await capabilities(id);
    assert.equal(caps.partner_status, 'NOT_APPLIED', 'no half-application was created');
  });

  test('a new application stores no face photograph at all', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
    await onboard(id, { studentId: 'TEST-STU-DOC-3' });
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['x/student-id.jpg']), {
      commit: true,
    });

    const row = await asService(
      async (c) =>
        (
          await c.query(
            'select student_id_image_path, face_image_path from public.partner_profiles where user_id = $1',
            [id]
          )
        ).rows[0]
    );
    assert.equal(row.student_id_image_path, 'x/student-id.jpg');
    assert.equal(row.face_image_path, null, 'Campus Dash no longer asks for a face photograph');
  });

  test('the document path is never handed back to the person who uploaded it', async () => {
    const id = await newEmailIdentity(nextSchoolEmail());
    await onboard(id, { studentId: 'TEST-STU-DOC-2' });
    await asUser(id, (c) => c.query('select public.partner_apply($1)', ['secret/student-id.jpg']), {
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
    // The Customer profile carries no document at all — signing up to order
    // lunch never required one. The Partner application carries the student ID,
    // and reports only that it exists.
    assert.ok(!('has_student_id' in profile), 'a customer holds no verification document');
    assert.equal(application.has_documents, true, 'and the applicant is told only that much');
  });

  test('a customer profile is readable only by its owner and an administrator', async () => {
    // The verification documents moved to partner_profiles, but the row itself
    // is still somebody's student ID number and level, and the policy that
    // guards it has not moved.
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
    const id = await newEmailIdentity(nextSchoolEmail());
    const error = await expectRejection(
      asUser(id, (c) =>
        c.query(
          `insert into public.customer_profiles (user_id, student_id_number, level)
           values ($1, 'SELF-GRANTED', '200')`,
          [id]
        )
      )
    );
    assert.match(error.message, /permission denied/i);
    assert.equal((await capabilities(id)).can_order, false);
  });
});
