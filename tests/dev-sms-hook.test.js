import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asService, asUser, asAnon, closePools, ACTORS } from './helpers/db.js';

/**
 * The Postgres Send SMS Hook used when developing against a HOSTED Supabase
 * project (supabase/dev/sms-hook.sql).
 *
 * It writes one-time passcodes to a table, which is the kind of thing that is
 * fine right up until it is not. So the file is tested here even though it is
 * never installed by a migration: it is applied, exercised, checked and dropped
 * inside this suite, so the canonical schema is unchanged either way.
 *
 * What has to hold:
 *   - Supabase Auth's payload produces a readable message.
 *   - A malformed payload fails the sign-in rather than silently swallowing it.
 *   - Nothing accumulates.
 *   - No client role can read the table or call the function.
 */

const SQL = readFileSync(new URL('../supabase/dev/sms-hook.sql', import.meta.url), 'utf8');

describe('hosted development Send SMS Hook', () => {
  before(() => asService((c) => c.query(SQL)));

  after(async () => {
    await asService(async (c) => {
      await c.query('drop function if exists public.dev_send_sms_hook(jsonb)');
      await c.query('drop table if exists public.dev_sms_outbox');
    });
    await closePools();
  });

  test('a Supabase Auth payload becomes a readable message', async () => {
    const row = await asService(async (c) => {
      await c.query('truncate table public.dev_sms_outbox');
      const { rows } = await c.query(`select public.dev_send_sms_hook($1::jsonb) as result`, [
        JSON.stringify({ user: { phone: '233200000021' }, sms: { otp: '424242' } }),
      ]);
      assert.deepEqual(rows[0].result, {}, 'an empty object tells GoTrue delivery succeeded');
      return (await c.query('select phone, message, tag from public.dev_sms_outbox')).rows[0];
    });

    // GoTrue stores phone numbers without the '+'; our E.164 form keeps it.
    assert.equal(row.phone, '+233200000021');
    assert.equal(row.tag, 'AUTH_OTP');
    assert.match(row.message, /424242/);
  });

  test('a payload with no code fails the sign-in instead of passing silently', async () => {
    const result = await asService(
      async (c) =>
        (
          await c.query(`select public.dev_send_sms_hook($1::jsonb) as result`, [
            JSON.stringify({ user: { phone: '233200000021' }, sms: {} }),
          ])
        ).rows[0].result
    );
    assert.equal(result.error?.http_code, 400, 'GoTrue must be told delivery did not happen');
  });

  test('passcodes do not accumulate', async () => {
    const count = await asService(async (c) => {
      await c.query('truncate table public.dev_sms_outbox');
      for (let i = 0; i < 40; i += 1) {
        await c.query(`select public.dev_send_sms_hook($1::jsonb)`, [
          JSON.stringify({ user: { phone: '233200000021' }, sms: { otp: String(100000 + i) } }),
        ]);
      }
      return Number((await c.query('select count(*) from public.dev_sms_outbox')).rows[0].count);
    });
    assert.ok(count <= 25, `expected at most 25 retained messages, found ${count}`);
  });

  test('an old passcode is dropped even when the buffer is not full', async () => {
    const remaining = await asService(async (c) => {
      await c.query('truncate table public.dev_sms_outbox');
      await c.query(
        `insert into public.dev_sms_outbox (phone, message, created_at)
         values ('+233200000021', 'code 111111', now() - interval '1 hour')`
      );
      await c.query(`select public.dev_send_sms_hook($1::jsonb)`, [
        JSON.stringify({ user: { phone: '233200000021' }, sms: { otp: '222222' } }),
      ]);
      return (await c.query('select message from public.dev_sms_outbox')).rows;
    });
    assert.equal(remaining.length, 1);
    assert.match(remaining[0].message, /222222/);
  });

  test('no client role can read the passcodes', async () => {
    for (const [label, run] of [
      ['a signed-in user', (fn) => asUser(ACTORS.customerAma, fn)],
      ['an anonymous visitor', asAnon],
    ]) {
      await assert.rejects(
        () => run((c) => c.query('select * from public.dev_sms_outbox')),
        /permission denied/i,
        `${label} must not be able to read one-time passcodes`
      );
    }
  });

  test('no client role can call the hook', async () => {
    for (const [label, run] of [
      ['a signed-in user', (fn) => asUser(ACTORS.customerAma, fn)],
      ['an anonymous visitor', asAnon],
    ]) {
      await assert.rejects(
        () => run((c) => c.query(`select public.dev_send_sms_hook('{}'::jsonb)`)),
        /permission denied/i,
        `${label} must not be able to drive the SMS hook`
      );
    }
  });

  test('Supabase Auth itself can call it', async () => {
    const allowed = await asService(
      async (c) =>
        (
          await c.query(
            `select has_function_privilege('supabase_auth_admin',
                      'public.dev_send_sms_hook(jsonb)', 'EXECUTE') as ok`
          )
        ).rows[0].ok
    );
    assert.equal(allowed, true, 'GoTrue must be able to reach the hook it is pointed at');
  });

  test('it is not part of the canonical schema', async () => {
    // The whole safety argument is that production never installs this file.
    // If it ever leaks into schema.sql or a migration, that argument is gone.
    const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(schema, /dev_sms_outbox|dev_send_sms_hook/);
  });
});
