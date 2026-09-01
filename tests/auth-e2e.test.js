import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools } from './helpers/db.js';
import { signWebhook } from '../lib/auth/webhook-signature.js';

/**
 * End-to-end phone OTP, against the running dev server and Supabase stack.
 *
 * Skips itself when the app is not running, so `npm test` stays usable without
 * `npm run dev`. Run both and these cover the join between Supabase Auth, our
 * Send SMS Hook and the SmsProvider abstraction.
 */
const APP = process.env.TEST_APP_URL || 'http://127.0.0.1:3000';
const SUPABASE = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const HOOK_SECRET = process.env.SEND_SMS_HOOK_SECRET;

/**
 * Two tests below drive Supabase Auth and then read auth.users through the test
 * pool, which always points at the LOCAL stack. Once .env.local names a hosted
 * project those are two different databases, so the assertion would be looking
 * for a user in the wrong place. Skip rather than fail: pointing the app at
 * hosted Supabase is a supported configuration, not a broken one.
 */
const localStack = /(^https?:\/\/)?(127\.0\.0\.1|localhost)(:|\/|$)/.test(SUPABASE);
const HOSTED = 'skipped: NEXT_PUBLIC_SUPABASE_URL is a hosted project, not the local stack';

async function appIsRunning() {
  try {
    const res = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

const running = await appIsRunning();

describe(
  'phone OTP end to end',
  { skip: running ? false : 'dev server not running at ' + APP },
  () => {
    after(async () => {
      await asService((c) => c.query("delete from auth.users where phone like '23320998%'"));
      await closePools();
    });

    test('the hook rejects an unsigned request', async () => {
      const res = await fetch(`${APP}/api/auth/hooks/send-sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: { phone: '233209980001' }, sms: { otp: '123456' } }),
      });
      assert.equal(res.status, 401, 'an unsigned caller must not be able to send SMS');
    });

    test('the hook rejects a request signed with the wrong secret', async () => {
      const body = JSON.stringify({ user: { phone: '233209980001' }, sms: { otp: '123456' } });
      const headers = signWebhook({
        body,
        secret: 'v1,whsec_d3Jvbmctc2VjcmV0LXZhbHVlLWZvci10ZXN0',
      });
      const res = await fetch(`${APP}/api/auth/hooks/send-sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      assert.equal(res.status, 401);
    });

    test('the hook accepts a correctly signed request', async (t) => {
      if (!HOOK_SECRET) return t.skip('SEND_SMS_HOOK_SECRET not in this process env');
      const body = JSON.stringify({ user: { phone: '233209980002' }, sms: { otp: '424242' } });
      const headers = signWebhook({ body, secret: HOOK_SECRET });
      const res = await fetch(`${APP}/api/auth/hooks/send-sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      assert.equal(res.status, 200, 'a genuine Supabase call must be delivered');
    });

    test('the hook refuses a payload with no phone or code', async (t) => {
      if (!HOOK_SECRET) return t.skip('SEND_SMS_HOOK_SECRET not in this process env');
      const body = JSON.stringify({ user: {}, sms: {} });
      const headers = signWebhook({ body, secret: HOOK_SECRET });
      const res = await fetch(`${APP}/api/auth/hooks/send-sms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
      assert.equal(res.status, 400);
    });

    test('requesting an OTP drives Supabase Auth through our hook', async (t) => {
      if (!ANON) return t.skip('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not in this process env');
      if (!localStack) return t.skip(HOSTED);
      const phone = '+233209980003';

      const res = await fetch(`${SUPABASE}/auth/v1/otp`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ phone, create_user: true }),
      });
      assert.equal(res.status, 200, 'phone login must be enabled and the hook must succeed');

      // GoTrue records that a code went out. Delivery itself is asserted by the
      // hook tests above; the OTP is not readable from here by design.
      const sent = await asService(
        async (c) =>
          (
            await c.query('select confirmation_sent_at from auth.users where phone = $1', [
              phone.replace('+', ''),
            ])
          ).rows[0]
      );
      assert.ok(sent?.confirmation_sent_at, 'a verification code was issued');
    });

    test('an incorrect code does not produce a session', async (t) => {
      if (!ANON) return t.skip('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not in this process env');
      if (!localStack) return t.skip(HOSTED);
      const res = await fetch(`${SUPABASE}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '+233209980003', token: '000000', type: 'sms' }),
      });
      const body = await res.json();
      assert.ok(!body.access_token, 'a wrong code must never issue a session');
    });

    test('an unauthenticated visitor is redirected away from the account page', async () => {
      const res = await fetch(`${APP}/account`, { redirect: 'manual' });
      assert.ok(
        [302, 307].includes(res.status),
        `expected a redirect to /login, got ${res.status}`
      );
      assert.match(res.headers.get('location') ?? '', /\/login/);
    });

    test('the login page renders', async () => {
      const res = await fetch(`${APP}/login`);
      const html = await res.text();
      assert.equal(res.status, 200);
      assert.match(html, /Sign in/);
    });
  }
);
