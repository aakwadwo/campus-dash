import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asService, asUser, closePools, CATEGORIES } from './helpers/db.js';

// CATEGORIES.snacks, not .meals: `meals-food` exists in the seed but is
// is_active = false, and vendor_signup() refuses an inactive category before it
// gets anywhere near the behaviour under test.

/**
 * A customer becomes a vendor WITHOUT a second Auth identity.
 *
 * THE PRODUCTION FAILURE THIS GUARDS. A customer signs in by email and puts
 * their phone on their profile, so public.users.phone holds it while
 * auth.users.phone is NULL. Vendor sign-up asked Supabase for a phone OTP,
 * which found no identity for that number and minted a SECOND one. Confirming
 * it collided with the customer's row on users_phone_key, and GoTrue reported
 * the aborted transaction as `500 Error confirming user`.
 *
 * The model was never the problem: identity is auth.users.id, and CUSTOMER and
 * VENDOR are additive rows on top of it. vendor_signup() already reads the
 * phone from the caller's PROFILE row rather than from an auth credential, so
 * an authenticated customer can take the vendor capability on the identity they
 * already have. These assertions pin that down so it cannot regress.
 *
 * Run through asUser(), which is the transaction PostgREST would open for a
 * signed-in caller — so vendor_signup() sees exactly the auth.uid() a real
 * request would give it.
 */
describe('an existing customer becomes a vendor on the same identity', () => {
  const made = [];

  const phoneFor = (n) => `+2332${String(Date.now()).slice(-6)}${String(n).padStart(2, '0')}`;

  /** A customer exactly as onboarding leaves one: email identity, profile phone. */
  async function makeCustomer(phone) {
    const id = randomUUID();
    made.push(id);
    const email = `becomes.vendor.${randomUUID()}@acity.edu.gh`;

    await asService(async (c) => {
      // Signs in by EMAIL, so auth.users.phone stays NULL — the shape that
      // made the old flow mint a second identity.
      await c.query(
        `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                                 created_at, updated_at)
         values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                 'authenticated', $2::text, now(), now(), now())`,
        [id, email]
      );
      // The phone is a PROFILE field for a customer, not a credential.
      await c.query(
        `update public.users set phone = $2::text, first_name = 'Ama', last_name = 'Owusu'
          where id = $1::uuid`,
        [id, phone]
      );
      await c.query(
        `insert into public.customer_profiles (user_id, level) values ($1::uuid, '200')
         on conflict (user_id) do nothing`,
        [id]
      );
    });

    return { id, email };
  }

  async function vendorTerms() {
    return asService(
      async (c) =>
        (
          await c.query(
            `select id from public.terms_documents
              where audience = 'VENDOR' and published_at is not null
              order by version desc limit 1`
          )
        ).rows[0].id
    );
  }

  after(async () => {
    if (made.length) {
      await asService(async (c) => {
        await c.query('delete from public.vendors where owner_user_id = any($1)', [made]);
        await c.query('delete from auth.users where id = any($1)', [made]);
      });
    }
    await closePools();
  });

  test('the store attaches to the identity the customer already has', async () => {
    const phone = phoneFor(1);
    const { id, email } = await makeCustomer(phone);
    const terms = await vendorTerms();

    // Exactly what the signed-in path now does: no OTP, no new identity — just
    // vendor_signup() as the authenticated customer.
    await asUser(
      id,
      (c) =>
        c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
          'Ama Owusu',
          'Ama Kitchen',
          true,
          'Home cooking, rice and stews.',
          CATEGORIES.snacks,
          terms,
        ]),
      { commit: true }
    );

    const { rows: vendors } = await asService((c) =>
      c.query('select owner_user_id, phone, status from public.vendors where owner_user_id = $1', [
        id,
      ])
    );

    // 6. the store is created against the EXISTING auth.users.id
    assert.equal(vendors.length, 1, 'exactly one store');
    assert.equal(vendors[0].owner_user_id, id, 'owned by the customer, not by a new identity');
    // and it took the number from the profile row, which is the whole mechanism
    assert.equal(vendors[0].phone, phone);
    assert.equal(vendors[0].status, 'PENDING_APPROVAL');

    // 5 + 8. ONE identity for this person, and none carrying the phone as an
    // auth credential — an OTP was never requested, so none was ever minted.
    const { rows: identities } = await asService((c) =>
      c.query(
        `select count(*)::int as n from auth.users
          where id = $1::uuid or phone = replace($2::text, '+', '')`,
        [id, phone]
      )
    );
    assert.equal(identities[0].n, 1, 'one person, one Auth identity');

    const { rows: holders } = await asService((c) =>
      c.query('select count(*)::int as n from public.users where phone = $1::text', [phone])
    );
    assert.equal(holders[0].n, 1, 'and one profile row carrying that number');

    // 7. the customer is untouched
    const { rows: profile } = await asService((c) =>
      c.query(
        `select u.email, u.phone, u.first_name,
                (select count(*)::int from public.customer_profiles c where c.user_id = u.id) as customer
           from public.users u where u.id = $1::uuid`,
        [id]
      )
    );
    assert.equal(profile[0].email, email, 'their address survives');
    assert.equal(profile[0].phone, phone, 'their number survives');
    assert.equal(profile[0].first_name, 'Ama');
    assert.equal(profile[0].customer, 1, 'and they are still a customer');
  });

  test('both capabilities are reported for the one account', async () => {
    const phone = phoneFor(2);
    const { id } = await makeCustomer(phone);
    const terms = await vendorTerms();

    await asUser(
      id,
      (c) =>
        c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
          'Ama Owusu',
          'Ama Snacks',
          true,
          'Chips and cold drinks.',
          CATEGORIES.snacks,
          terms,
        ]),
      { commit: true }
    );

    const caps = await asUser(
      id,
      async (c) => (await c.query('select public.my_capabilities()')).rows[0].my_capabilities
    );

    assert.equal(caps.authenticated, true);
    assert.ok(caps.can_order, 'CUSTOMER survives becoming a vendor');
    assert.ok(caps.vendor_id, 'and VENDOR is now held by the same identity');
  });

  /**
   * THE NEGATIVE CONTROL, which is what makes the assertions above mean
   * something. This reconstructs the OLD behaviour — a second Auth identity
   * minted for a number the customer already holds — and shows it can no longer
   * produce a store. If vendor_signup() ever went back to running against a
   * freshly-created identity, this is where it would show up.
   */
  test('a second identity minted for the same number cannot create the store', async () => {
    const phone = phoneFor(3);
    const { id: customer } = await makeCustomer(phone);
    const terms = await vendorTerms();

    // What the old vendor sign-up did: a phone-credential identity for a number
    // public.users already carries. Confirmation no longer raises (see
    // tests/phone-collision.test.js) but the profile row is provisioned WITHOUT
    // the contested number.
    const intruder = randomUUID();
    made.push(intruder);
    await asService((c) =>
      c.query(
        `insert into auth.users (id, instance_id, aud, role, phone, phone_confirmed_at,
                                 created_at, updated_at)
         values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                 'authenticated', replace($2::text, '+', ''), now(), now(), now())`,
        [intruder, phone]
      )
    );

    const { rows: intruderRow } = await asService((c) =>
      c.query('select phone from public.users where id = $1::uuid', [intruder])
    );
    assert.equal(intruderRow[0].phone, null, 'the number is not reassigned to the new identity');

    // vendor_signup() reads the phone from the caller's own profile row, so the
    // second identity has nothing to register with and is refused.
    let refused = null;
    try {
      await asUser(
        intruder,
        (c) =>
          c.query('select public.vendor_signup($1, $2, $3, $4, $5, $6)', [
            'Not Ama',
            'Impostor Kitchen',
            true,
            'Should never exist.',
            CATEGORIES.snacks,
            terms,
          ]),
        { commit: true }
      );
    } catch (error) {
      refused = error;
    }

    assert.ok(refused, 'a second identity must not be able to register the store');
    assert.match(String(refused.message), /verify your phone number/i);

    // And the customer still owns nothing they did not ask for.
    const { rows } = await asService((c) =>
      c.query('select count(*)::int as n from public.vendors where phone = $1::text', [phone])
    );
    assert.equal(rows[0].n, 0, 'no store was created by the wrong identity');
    assert.ok(customer, 'customer id used');
  });
});
