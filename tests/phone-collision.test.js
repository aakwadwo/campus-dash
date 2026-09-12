import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asService, closePools } from './helpers/db.js';

/**
 * A phone number already held by one identity must never break another
 * identity's auth confirmation.
 *
 * THE PRODUCTION FAILURE. A customer signs in by EMAIL and gives their phone as
 * a profile field, so public.users.phone holds it while auth.users.phone is
 * NULL. Vendor sign-up asked Supabase for a phone OTP, which found no identity
 * and made a SECOND one. Confirming it fired on_auth_user_confirmed →
 * handle_new_auth_user_for(), whose insert carried the same phone into
 * users_phone_key. `on conflict (id) do nothing` does not absorb a conflict on
 * PHONE, so 23505 escaped, aborted GoTrue's transaction, and surfaced as
 * `500 Error confirming user` — naming neither the constraint nor the column.
 *
 * These run against the local stack as the service role, driving auth.users
 * directly, because the trigger is the unit under test and GoTrue is only the
 * thing that happens to call it.
 */
describe('phone collisions during auth provisioning', () => {
  const made = [];

  async function makeAuthUser({ phone = null, email = null, confirmed = true }) {
    const id = randomUUID();
    made.push(id);
    await asService((c) =>
      c.query(
        `insert into auth.users (id, instance_id, aud, role, phone, email,
                                 phone_confirmed_at, email_confirmed_at,
                                 created_at, updated_at)
         values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                 $2::text, $3::text,
                 case when $2::text is not null and $4::boolean then now() end,
                 case when $3::text is not null and $4::boolean then now() end,
                 now(), now())`,
        [id, phone, email, confirmed]
      )
    );
    return id;
  }

  after(async () => {
    if (made.length) {
      await asService((c) => c.query('delete from auth.users where id = any($1)', [made]));
    }
    await closePools();
  });

  /** A number nothing else in the database uses. */
  const freshPhone = () =>
    `+2332${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;

  test('a fresh number provisions a profile carrying that number', async () => {
    const phone = freshPhone();
    const id = await makeAuthUser({ phone: phone.replace('+', '') });

    const { rows } = await asService((c) =>
      c.query('select phone from public.users where id = $1', [id])
    );
    assert.equal(rows.length, 1, 'the identity must get a profile row');
    assert.equal(rows[0].phone, phone, 'and it keeps its own number');
  });

  /**
   * D. The regression. Confirming a second identity on a number a customer
   * already holds must NOT raise — that raise is what GoTrue turns into a 500.
   */
  test('confirming a second identity on a taken number does not raise', async () => {
    const phone = freshPhone();

    // The customer: signs in by email, phone is a profile field.
    const customer = await makeAuthUser({ email: `cust.${randomUUID()}@acity.edu.gh` });
    await asService((c) =>
      c.query('update public.users set phone = $2 where id = $1', [customer, phone])
    );

    // A second identity on the same number, confirmed — exactly what vendor
    // sign-up used to create. This is the statement that used to throw 23505.
    let raised = null;
    let second;
    try {
      second = await makeAuthUser({ phone: phone.replace('+', '') });
    } catch (error) {
      raised = error;
    }

    assert.equal(raised, null, 'confirmation must never raise — GoTrue reports it as a 500');

    // C. And it must not have produced a duplicate row carrying the number.
    const { rows: holders } = await asService((c) =>
      c.query('select id from public.users where phone = $1', [phone])
    );
    assert.equal(holders.length, 1, 'exactly one identity may hold a number');
    assert.equal(holders[0].id, customer, 'and it stays with the customer who had it');

    // The second identity still exists and is usable; it simply has no phone.
    const { rows: secondRow } = await asService((c) =>
      c.query('select phone from public.users where id = $1', [second])
    );
    assert.equal(secondRow.length, 1, 'the identity is still provisioned');
    assert.equal(secondRow[0].phone, null, 'without the contested number');
  });

  test('the customer keeps their number, profile and capabilities', async () => {
    const phone = freshPhone();
    const customer = await makeAuthUser({ email: `keep.${randomUUID()}@acity.edu.gh` });
    await asService((c) =>
      c.query('update public.users set phone = $2 where id = $1', [customer, phone])
    );

    await makeAuthUser({ phone: phone.replace('+', '') });

    const { rows } = await asService((c) =>
      c.query('select phone, email from public.users where id = $1', [customer])
    );
    assert.equal(rows[0].phone, phone, 'the customer is untouched by the collision');
    assert.ok(rows[0].email, 'including their address');
  });

  test('users_phone_key is still enforced — the fix did not relax it', async () => {
    const phone = freshPhone();
    const a = await makeAuthUser({ phone: phone.replace('+', '') });

    let failed = null;
    try {
      await asService((c) =>
        c.query('update public.users set phone = $2 where id <> $1 and phone is null', [a, phone])
      );
    } catch (error) {
      failed = error;
    }
    // Either nothing matched, or the constraint refused it. What must never
    // happen is two rows ending up with the same number.
    const { rows } = await asService((c) =>
      c.query('select count(*)::int as n from public.users where phone = $1', [phone])
    );
    assert.equal(rows[0].n, 1, 'one number, one identity — still true');
    if (failed) assert.match(String(failed.message), /users_phone_key|duplicate key/);
  });
});
