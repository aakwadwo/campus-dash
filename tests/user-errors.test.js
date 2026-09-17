import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { asService, asUser, closePools, ACTORS } from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';
import { toUserError, ERROR_KIND } from '../lib/errors.js';

/**
 * What a person is TOLD when something is refused.
 *
 * The rule the whole module exists for: the detail goes to the server log and a
 * plain sentence goes to the screen. A stack trace, a SQL error, a constraint
 * name or an internal id reaching a customer is the failure this prevents.
 *
 * THE CASE THAT PROMPTED THIS FILE. Somebody signs up as a customer with a phone
 * number that already belongs to a VENDOR account. The database refuses it —
 * `users_phone_key` is a unique index and that has not changed — and the screen
 * used to say "That phone number is already on another Campus Dash account",
 * which answers a question nobody signing up is entitled to ask: type a number,
 * read back whether it is registered. It is the same answer whether the account
 * behind it is a customer's or a store's, which makes the form a directory.
 *
 * So the sentence says the details could not be used and asks them to check.
 * Nothing about the refusal itself changed, and it is still a refusal: no
 * account is created and the screen does not pretend otherwise.
 */
describe('what a refusal says', () => {
  const made = [];

  after(async () => {
    if (made.length) {
      await asService((c) => c.query('delete from auth.users where id = any($1::uuid[])', [made]));
    }
    await closePools();
  });

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

  /** A verified school address with no capability on it yet. */
  async function newSchoolIdentity() {
    const id = randomUUID();
    made.push(id);
    await asService((c) =>
      c.query(
        `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                                 created_at, updated_at)
         values ($1::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
                 'authenticated', $2, now(), now(), now())`,
        [id, `errors.${id.slice(0, 8)}@acity.edu.gh`]
      )
    );
    return id;
  }

  // =========================================================================
  // The real collision, end to end
  // =========================================================================

  /**
   * NOT A HAND-WRITTEN STRING. The error comes from the function that actually
   * raises it, so this cannot drift into asserting a message nothing produces.
   */
  test('a phone number that belongs to a store still refuses the sign-up', async () => {
    const vendorPhone = await asService(
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.vendor1Staff]))
          .rows[0].phone
    );
    const id = await newSchoolIdentity();
    const terms = await currentTermsId();

    const error = await expectRejection(
      asUser(id, (c) =>
        c.query('select public.complete_customer_onboarding($1,$2,$3,$4,$5,$6,$7)', [
          'Kwame',
          'Mensah',
          vendorPhone,
          'STUDENT',
          2028,
          'MALE',
          terms,
        ])
      )
    );

    // THE UNIQUENESS RULE IS UNTOUCHED, and the log still says which detail
    // collided — that is what makes a support call answerable.
    assert.match(error.message, /phone number is already used/i);

    const capability = await asService(
      async (c) =>
        (
          await c.query(
            'select count(*)::int as n from public.customer_profiles where user_id = $1',
            [id]
          )
        ).rows[0].n
    );
    assert.equal(capability, 0, 'and no half-built account is left behind');
  });

  test('and what the person reads names neither the field nor the other account', () => {
    const raised = new Error('that phone number is already used by another Campus Dash account');
    const shown = toUserError(raised, 'customer sign-up');

    assert.equal(shown.kind, ERROR_KIND.CONFLICT);
    assert.equal(shown.status, 409);
    assert.match(shown.message, /problem with the details you entered/i);
    assert.match(shown.message, /check them and try again/i);

    for (const leak of [/phone/i, /email/i, /student ID/i, /another/i, /vendor|store/i]) {
      assert.ok(!leak.test(shown.message), `the sentence must not say ${leak}`);
    }

    // AND IT IS STILL A FAILURE. Nothing here turns a refused sign-up into a
    // success message, which would be the worse bug of the two.
    assert.ok(shown.status >= 400, 'a refusal keeps a failure status');
  });

  test('an address and a student ID collide the same way, and read the same', () => {
    const messages = [
      'that email address is already used by another Campus Dash account',
      'that student ID number is already registered to another account',
    ].map((raw) => toUserError(new Error(raw), 'customer sign-up').message);

    assert.equal(messages[0], messages[1], 'one sentence, so the reply is not an oracle');
    assert.match(messages[0], /problem with the details you entered/i);
  });

  // =========================================================================
  // The rest of the surface
  // =========================================================================

  test('an unmapped error never echoes its own text', () => {
    const shown = toUserError(
      new Error('duplicate key value violates unique constraint "users_phone_key" on table users'),
      'test'
    );
    assert.equal(shown.kind, ERROR_KIND.INTERNAL);
    assert.match(shown.message, /Something went wrong on our side/i);
    assert.ok(!/users_phone_key|constraint|table/i.test(shown.message));
  });

  /**
   * The upload messages are OURS and already written for a person, which is why
   * they are on the list at all: the list is what says a string has been read
   * and carries no provider text, no bucket name and no object path.
   */
  test('an upload refusal keeps the sentence that tells somebody what to do', () => {
    const tooBig = toUserError(new Error('That image is too large. Please use one under 5 MB.'));
    assert.equal(tooBig.kind, ERROR_KIND.USER);
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.message, /under 5 MB/);

    const wrongType = toUserError(new Error('Please use a JPEG, PNG or WebP image.'));
    assert.match(wrongType.message, /JPEG, PNG or WebP/);

    // The storage client's own text is not a sentence anybody wrote for a
    // person, so it becomes one that was.
    const storage = toUserError(new Error('Could not save that image: Bucket not found'));
    assert.equal(storage.kind, ERROR_KIND.TEMPORARY);
    assert.ok(!/bucket/i.test(storage.message));
  });

  test('a forbidden action says so without confirming what exists', () => {
    const shown = toUserError(new Error('admin privileges required'));
    assert.equal(shown.kind, ERROR_KIND.FORBIDDEN);
    assert.equal(shown.status, 403);
    assert.match(shown.message, /do not have access/i);
  });
});
