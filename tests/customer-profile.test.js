import { test, describe, before, beforeEach, after } from 'node:test';
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
} from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * Who a customer is, and who may ask.
 *
 * TWO THINGS WERE WRONG with `customer_profiles.level`:
 *
 *   1. IT EXPIRED. Somebody who signed up in first year was level 100 for ever,
 *      because nobody comes back in September to move themselves up — so the
 *      column was wrong for three of the four years it described.
 *   2. IT ASSUMED EVERYONE WAS A STUDENT. Staff eat lunch and staff can be
 *      Partners, and there was no way to be either without claiming a level.
 *
 * A graduation year fixes the first by stating the same fact from the end that
 * does not move. An affiliation fixes the second.
 */
describe('customer profile', () => {
  const THIS_YEAR = new Date().getFullYear();
  let seq = 0;
  const nextEmail = () => `profile.${Date.now()}.${seq++}@acity.edu.gh`;
  const nextPhone = () =>
    `+2332099${String(Date.now()).slice(-5)}${String(seq++).padStart(2, '0')}`;

  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  const created = [];

  /** An auth identity with a confirmed school address, and nothing else. */
  async function newIdentity(email) {
    const id = randomUUID();
    created.push(id);
    await asService((c) =>
      c.query(
        `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                                 raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                                 confirmation_token, recovery_token, email_change_token_new,
                                 email_change, email_change_token_current, phone_change,
                                 phone_change_token, reauthentication_token)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
                 $2, now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(),
                 '', '', '', '', '', '', '', '')`,
        [id, email]
      )
    );
    return id;
  }

  const currentTermsId = () =>
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

  async function onboard(id, overrides = {}) {
    const terms = await currentTermsId();
    return asUser(
      id,
      async (c) =>
        (
          await c.query(
            'select * from public.complete_customer_onboarding($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              overrides.firstName ?? 'Ama',
              overrides.lastName ?? 'Tester',
              overrides.phone ?? nextPhone(),
              overrides.affiliation ?? 'STUDENT',
              // `?? default` would swallow an explicit null, which is exactly
              // the case one test below is about.
              overrides.affiliation === 'STAFF'
                ? null
                : 'graduationYear' in overrides
                  ? overrides.graduationYear
                  : 2028,
              // MALE by default because gender is no longer a question that may
              // be skipped; a test that means to omit it passes null explicitly.
              'gender' in overrides ? overrides.gender : 'MALE',
              terms,
              null,
            ]
          )
        ).rows[0],
      { commit: true }
    );
  }

  after(async () => {
    if (created.length) {
      await asService((c) =>
        c.query('delete from auth.users where id = any($1::uuid[])', [created])
      );
    }
    await resetTransactionalState();
    await closePools();
  });

  // =========================================================================
  // STUDENT AND STAFF
  // =========================================================================
  describe('student or staff', () => {
    test('a student records the year they expect to finish', async () => {
      const id = await newIdentity(nextEmail());
      const profile = await onboard(id, { graduationYear: 2029 });

      assert.equal(profile.affiliation, 'STUDENT');
      assert.equal(profile.graduation_year, 2029);
    });

    /**
     * STAFF ARE FULL CUSTOMERS. This changes what sign-up ASKS, never what the
     * account may then do — capabilities are additive rows on auth.users.id and
     * nothing here touches them.
     */
    test('staff hold the same capability and are asked for no year', async () => {
      const id = await newIdentity(nextEmail());
      const profile = await onboard(id, { affiliation: 'STAFF' });

      assert.equal(profile.affiliation, 'STAFF');
      assert.equal(profile.graduation_year, null, 'staff do not graduate');

      const caps = await asUser(
        id,
        async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
      );
      assert.equal(caps.can_order, true, 'the identical CUSTOMER capability');
    });

    test('staff may become Partners, like any other customer', async () => {
      const id = await newIdentity(nextEmail());
      await onboard(id, { affiliation: 'STAFF' });

      // partner_requires_customer is a foreign key, and a staff member holds
      // the customer row it points at — so nothing special is needed.
      const applied = await asUser(
        id,
        async (c) =>
          (
            await c.query('select * from public.partner_apply($1, $2)', [
              `${id}/partner/student-id.jpg`,
              null,
            ])
          ).rows[0],
        { commit: true }
      );
      assert.ok(applied, 'a staff member can apply');
    });

    /**
     * THE CONSTRAINT, NOT THE FUNCTION. A staff member with a graduation year
     * is a contradiction the table refuses however it is written.
     */
    test('a staff member cannot be given a graduation year by any route', async () => {
      const id = await newIdentity(nextEmail());
      await onboard(id, { affiliation: 'STAFF' });

      const error = await expectRejection(
        asService((c) =>
          c.query('update public.customer_profiles set graduation_year = $1 where user_id = $2', [
            2028,
            id,
          ])
        )
      );
      assert.match(error.message, /customer_graduation_year_shape/);
    });

    test('a student cannot be left without one', async () => {
      const id = await newIdentity(nextEmail());
      const error = await expectRejection(onboard(id, { graduationYear: null }));
      assert.match(error.message, /expect to graduate/i);
    });

    /**
     * FOUR YEARS, AND THE SAME FOUR THE FORM OFFERS. This used to be a range —
     * this year to this year plus ten — which accepted five years belonging to
     * nobody on campus. The years immediately either side of the list are the
     * ones worth asserting: a range would have taken both.
     */
    test('a graduation year outside the four offered is refused', async () => {
      for (const year of [1999, 2026, 2031, THIS_YEAR + 40]) {
        const id = await newIdentity(nextEmail());
        const error = await expectRejection(onboard(id, { graduationYear: year }));
        assert.match(error.message, /years offered/i, String(year));
      }
    });

    test('each of the four is accepted', async () => {
      for (const year of [2027, 2028, 2029, 2030]) {
        const id = await newIdentity(nextEmail());
        const profile = await onboard(id, { graduationYear: year });
        assert.equal(profile.graduation_year, year);
      }
    });
  });

  // =========================================================================
  // GENDER
  // =========================================================================
  describe('gender', () => {
    test('is exactly male or female when given', async () => {
      for (const gender of ['MALE', 'FEMALE']) {
        const id = await newIdentity(nextEmail());
        const profile = await onboard(id, { gender });
        assert.equal(profile.gender, gender);
      }
    });

    /**
     * IT USED TO BE OPTIONAL, with a "prefer not to say" that stored a null.
     * The only reason to hold the column is to count it, and a column a third
     * of the rows decline cannot be counted — so the third option is gone from
     * the form and the null is refused here.
     *
     * THE COLUMN STAYS NULLABLE. An account created before this change has no
     * gender and is still a valid row; nothing backfills one nobody stated.
     */
    test('is required — declining to say is no longer an option', async () => {
      const id = await newIdentity(nextEmail());
      const error = await expectRejection(onboard(id, { gender: null }));
      assert.match(error.message, /male or female/i);

      const caps = await asUser(
        id,
        async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
      );
      assert.equal(caps.can_order, false, 'and the capability was not granted');
    });

    test('a staff member is asked the same question', async () => {
      const id = await newIdentity(nextEmail());
      const error = await expectRejection(onboard(id, { affiliation: 'STAFF', gender: null }));
      assert.match(error.message, /male or female/i);
    });

    test('anything else is refused by the enum', async () => {
      const id = await newIdentity(nextEmail());
      const error = await expectRejection(onboard(id, { gender: 'OTHER' }));
      assert.match(error.message, /customer_gender/i);
    });
  });

  // =========================================================================
  // EDITING AFTERWARDS
  // =========================================================================
  describe('changing it later', () => {
    test('a student who becomes staff loses the graduation year', async () => {
      const id = await newIdentity(nextEmail());
      await onboard(id, { graduationYear: 2028 });

      await asUser(
        id,
        (c) =>
          c.query('select public.update_my_profile($1,$2,$3,$4,$5,$6)', [
            'Ama',
            'Tester',
            null,
            'STAFF',
            null,
            null,
          ]),
        { commit: true }
      );

      const profile = await asService(
        async (c) =>
          (await c.query('select * from public.customer_profiles where user_id = $1', [id])).rows[0]
      );
      assert.equal(profile.affiliation, 'STAFF');
      assert.equal(profile.graduation_year, null);
    });

    /**
     * THE RULE THAT MATTERS MOST IN THIS FUNCTION, and it is unchanged: a
     * vendor's phone number IS their sign-in credential, so a settings form
     * must not be able to move it. That would be an account takeover with a
     * text input.
     */
    test('a vendor still cannot change their own phone number here', async () => {
      const error = await expectRejection(
        asUser(ACTORS.vendor1Staff, (c) =>
          c.query('select public.update_my_profile($1,$2,$3,$4,$5,$6)', [
            'Muni',
            'Owner',
            '+233209999999',
            null,
            null,
            null,
          ])
        )
      );
      assert.match(error.message, /how you sign in/i);
    });

    test('editing a name does not invent a customer profile for somebody without one', async () => {
      // The admin holds no customer_profiles row in the seed, and a settings
      // form must not be able to grant the CUSTOMER capability.
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select public.update_my_profile($1,$2,$3,$4,$5,$6)', [
            'Dev',
            'Admin',
            null,
            'STUDENT',
            2028,
            'MALE',
          ]),
        { commit: true }
      );

      const rows = await asService(
        async (c) =>
          (
            await c.query('select * from public.customer_profiles where user_id = $1', [
              ACTORS.admin,
            ])
          ).rows
      );
      assert.deepEqual(rows, [], 'no capability was granted by a name form');
    });
  });

  // =========================================================================
  // THE VENDOR DOOR
  // =========================================================================
  describe('vendor sign-in is for vendors', () => {
    const statusFor = (phone) =>
      asAnon(
        async (c) =>
          (await c.query('select public.vendor_phone_sign_in_status($1) as status', [phone]))
            .rows[0].status
      );

    /**
     * THE QUESTION IS ASKED OF auth.users, which is the table GoTrue resolves a
     * phone OTP against. public.users.phone is a PROFILE field and the two can
     * genuinely disagree — see the EMAIL_ACCOUNT case below, which is the
     * production bug this function was rewritten for.
     */
    const confirmAuthPhone = (userId, phone) =>
      asService((c) =>
        c.query(
          `update auth.users
              set phone = $2, phone_confirmed_at = now()
            where id = $1`,
          [userId, phone.replace('+', '')]
        )
      );

    test('a number that owns a store may be sent a code', async () => {
      const phone = await asService(
        async (c) =>
          (
            await c.query(
              'select u.phone from public.users u join public.vendors v on v.owner_user_id = u.id where v.id = $1',
              [VENDORS.one]
            )
          ).rows[0].phone
      );
      await confirmAuthPhone(ACTORS.vendor1Staff, phone);
      assert.equal(await statusFor(phone), 'VENDOR');
    });

    /**
     * THE WHOLE POINT. Sending a code to any number typed into the vendor
     * sign-in screen spent Arkesel credit on strangers, made GoTrue provision
     * an auth identity for somebody with no store, and told whoever typed it
     * that Campus Dash was expecting them.
     */
    test('a number with no store may not', async () => {
      assert.equal(await statusFor('+233209999999'), 'NONE', 'a number nobody holds');

      const customerPhone = await asService(
        async (c) =>
          (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma]))
            .rows[0].phone
      );
      assert.equal(await statusFor(customerPhone), 'NONE', 'a customer is not a vendor');
    });

    /**
     * A REJECTED OR PENDING APPLICANT STILL HAS TO GET IN — to read why they
     * were turned down, or that they are still waiting. So this asks "has a
     * store" rather than "has a live one".
     */
    test('an owner whose store is pending or rejected can still sign in', async () => {
      for (const owner of [ACTORS.vendorPendingOwner, ACTORS.vendorRejectedOwner]) {
        const phone = await asService(
          async (c) =>
            (await c.query('select phone from public.users where id = $1', [owner])).rows[0].phone
        );
        await confirmAuthPhone(owner, phone);
        assert.equal(await statusFor(phone), 'VENDOR', owner);
      }
    });

    /**
     * THE PRODUCTION BUG, in one test.
     *
     * A store owner's number sits on their PROFILE while a second, empty auth
     * identity is the one holding it in auth.users — which is what
     * handle_new_auth_user_for() leaves behind when a phone collides, and
     * deliberately so: a contact detail somebody else holds is not the new
     * identity's to take.
     *
     * The old check read public.users and said yes. GoTrue then signed in the
     * EMPTY identity, and a vendor landed on a sign-up screen with no store.
     */
    test('a number confirmed on a DIFFERENT identity is not a vendor sign-in', async () => {
      const phone = await asService(
        async (c) =>
          (await c.query('select phone from public.users where id = $1', [ACTORS.vendor1Staff]))
            .rows[0].phone
      );

      const orphan = '99999999-0000-4000-8000-0000000000a1';
      try {
        // The owner signs in by something else; the number is on their profile.
        await asService((c) =>
          c.query('update auth.users set phone = null, phone_confirmed_at = null where id = $1', [
            ACTORS.vendor1Staff,
          ])
        );
        assert.equal(
          await statusFor(phone),
          'EMAIL_ACCOUNT',
          'a store exists, but a code would not reach it'
        );

        // And with the orphan identity actually present, which is the real shape.
        await asService((c) =>
          c.query(
            `insert into auth.users (id, instance_id, aud, role, phone, phone_confirmed_at,
                                     created_at, updated_at)
             values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                     'authenticated', $2, now(), now(), now())`,
            [orphan, phone.replace('+', '')]
          )
        );
        assert.equal(
          await statusFor(phone),
          'EMAIL_ACCOUNT',
          'the empty identity is never offered a vendor code'
        );
      } finally {
        // THE CREDENTIAL GOES BACK. auth.users is outside
        // resetTransactionalState(), so a file that moves a sign-in number and
        // leaves it moved signs nobody in for the rest of the run.
        await asService((c) => c.query('delete from auth.users where id = $1', [orphan]));
        await confirmAuthPhone(ACTORS.vendor1Staff, phone);
      }
    });

    test('it returns one word and nothing about the account', async () => {
      const result = await asAnon(
        async (c) =>
          (
            await c.query('select public.vendor_phone_sign_in_status($1) as status', [
              '+233200000011',
            ])
          ).rows[0]
      );
      assert.deepEqual(Object.keys(result), ['status'], 'no name, no store, no account id');
      assert.ok(['VENDOR', 'EMAIL_ACCOUNT', 'NONE'].includes(result.status));
    });
  });
});
