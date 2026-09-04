import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
} from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * Account provisioning and capabilities.
 *
 * These exercise the database side of phone OTP: what happens when Supabase
 * Auth creates and confirms a phone account, and what the application is then
 * allowed to believe about that account.
 */
describe('authentication and capabilities', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await asService((c) => c.query("delete from auth.users where phone like '23320999%'"));
    await closePools();
  });

  /** Mimics GoTrue inserting an auth.users row when an OTP is first requested. */
  async function createUnconfirmedAuthUser(phoneDigits, fullName = null) {
    const id = randomUUID();
    await asService((c) =>
      c.query(
        `insert into auth.users (instance_id, id, aud, role, phone, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
                 '{"provider":"phone","providers":["phone"]}', $3, now(), now())`,
        [id, phoneDigits, JSON.stringify(fullName ? { full_name: fullName } : {})]
      )
    );
    return id;
  }

  async function confirmPhone(id) {
    await asService((c) =>
      c.query('update auth.users set phone_confirmed_at = now() where id = $1', [id])
    );
  }

  async function profileFor(id) {
    return asService(
      async (c) => (await c.query('select * from public.users where id = $1', [id])).rows[0] ?? null
    );
  }

  test('requesting a code does NOT create a profile — an unconfirmed phone claims nothing', async () => {
    const id = await createUnconfirmedAuthUser('233209990001');
    assert.equal(await profileFor(id), null, 'no profile until the number is proven');
  });

  test('confirming the phone provisions the profile automatically', async () => {
    const id = await createUnconfirmedAuthUser('233209990002', 'Nana Test');
    await confirmPhone(id);

    const profile = await profileFor(id);
    assert.ok(profile, 'a profile exists the moment the phone is confirmed');
    assert.equal(profile.phone, '+233209990002', 'stored in E.164 with the leading +');
    assert.equal(profile.full_name, 'Nana Test');
    assert.equal(profile.is_admin, false, 'nobody provisions themselves as an admin');
    assert.equal(profile.is_suspended, false);
  });

  test('a fresh account is an IDENTITY and holds no capability at all', async () => {
    const id = await createUnconfirmedAuthUser('233209990003');
    await confirmPhone(id);

    const caps = await asUser(
      id,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    // A verified phone proves WHO this is. It grants nothing on its own —
    // which is the whole distinction this model rests on.
    assert.equal(caps.authenticated, true);
    assert.equal(caps.can_order, false, 'a verified phone is not a Customer');
    assert.equal(caps.is_customer, false);
    assert.equal(caps.customer_status, 'NOT_ONBOARDED');
    assert.equal(caps.is_partner, false);
    assert.equal(caps.partner_status, 'NOT_APPLIED');
    assert.deepEqual(caps.vendor_ids, []);
    assert.equal(caps.is_admin, false);
  });

  test('one account carries BOTH Customer and Partner capabilities', async () => {
    const caps = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.user_id, ACTORS.partnerYaw, 'the same account id, not a second login');
    assert.equal(caps.can_order, true, 'a Partner is always also a Customer');
    assert.equal(caps.is_customer, true);
    assert.equal(caps.is_partner, true);
    assert.equal(caps.partner_status, 'APPROVED');
  });

  test('capabilities report vendor staff membership', async () => {
    const caps = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.deepEqual(caps.vendor_ids, [VENDORS.one]);
    assert.equal(caps.is_partner, false);
    // Staffing a stall is not shopping. This account has no student profile, so
    // it holds no Customer capability either.
    assert.equal(caps.can_order, false, 'a vendor account is not automatically a customer');
    assert.equal(caps.is_customer, false);
  });

  test('a signed-out caller gets no capabilities', async () => {
    const caps = await asService(
      async (c) => (await c.query(`select (select public.my_capabilities()) as c`)).rows[0].c
    );
    assert.equal(caps.authenticated, false, 'no auth.uid() means no account');
  });

  test('a suspended account is reported as suspended and cannot order', async () => {
    await asService((c) =>
      c.query('update public.users set is_suspended = true where id = $1', [ACTORS.customerAma])
    );
    const caps = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.is_suspended, true);
    assert.equal(caps.can_order, false);
  });

  test('a user cannot make themselves an admin', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.users set is_admin = true where id = $1', [ACTORS.customerAma])
      )
    );
    assert.match(error.message, /permission denied/i);

    // Nor through the one profile function they DO have.
    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.update_my_profile($1)', ['Definitely An Admin']),
      { commit: true }
    );
    const profile = await profileFor(ACTORS.customerAma);
    assert.equal(profile.is_admin, false);
    assert.equal(profile.full_name, 'Definitely An Admin', 'the name change did apply');
  });

  test('a user cannot un-suspend themselves', async () => {
    await asService((c) =>
      c.query('update public.users set is_suspended = true where id = $1', [ACTORS.customerAma])
    );
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.users set is_suspended = false where id = $1', [ACTORS.customerAma])
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test("a user cannot edit anyone else's profile", async () => {
    await asUser(
      ACTORS.customerKwesi,
      (c) => c.query('select public.update_my_profile($1)', ['Kwesi Renamed']),
      { commit: true }
    );
    // update_my_profile is scoped to auth.uid(); Ama is untouched.
    const ama = await profileFor(ACTORS.customerAma);
    assert.equal(ama.full_name, 'Ama Test-Customer');
  });

  test('one phone number cannot back two accounts', async () => {
    const id = await createUnconfirmedAuthUser('233209990005');
    await confirmPhone(id);

    // Enforced at BOTH layers: auth.users has its own unique phone constraint,
    // so a duplicate is refused before it ever reaches our profile table — and
    // public.users.users_phone_key would refuse it even if it did.
    const error = await expectRejection(createUnconfirmedAuthUser('233209990005'));
    assert.match(error.message, /users_phone_key/);
  });

  test('the profile table independently refuses a duplicate phone', async () => {
    const error = await expectRejection(
      asService((c) =>
        c.query(
          `insert into public.users (id, phone, full_name)
           values (gen_random_uuid(), '+233200000021', 'Impostor')`
        )
      )
    );
    assert.match(error.message, /users_phone_key/);
  });

  test('a Partner going online and offline is reflected in capabilities', async () => {
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_set_availability(false)'),
      {
        commit: true,
      }
    );
    let caps = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.partner_available, false);

    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_set_availability(true)'),
      {
        commit: true,
      }
    );
    caps = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.partner_available, true);
  });

  test('a non-Partner cannot mark themselves available', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) => c.query('select public.partner_set_availability(true)'))
    );
    assert.match(error.message, /not approved/);
  });
});
