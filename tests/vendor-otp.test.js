import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools } from './helpers/db.js';

/**
 * The vendor phone OTP, end to end, against the local Supabase stack.
 *
 * WHY THIS EXISTS. Vendor sign-up was failing in production with "that code is
 * not valid or has expired" on codes that had just arrived. The cause was not
 * expiry: the flow had no resend, so a vendor waiting on a slow SMS resubmitted
 * the details form — which issues a NEW code and invalidates the previous one —
 * and then typed whichever message they read first. The properties below are
 * the ones that failure turned on, and the unit suite cannot assert any of
 * them, because Supabase generates and checks every code and a stub of that
 * would be a test of the stub.
 *
 * NO REAL SMS LEAVES THE MACHINE. The local stack's Send SMS Hook is the
 * application's own route, so codes are read from /dev/inbox — exactly where a
 * developer reads them. That is why this suite needs `npm run dev`: the
 * plaintext exists only in the running app, never in the database (GoTrue
 * stores a hash) and never on a network.
 *
 * ALWAYS THE LOCAL STACK, never whatever `.env.local` names, for the same
 * reason customer-otp-e2e.test.js says so: pointing the two halves at different
 * projects would test nothing.
 */
const SUPABASE = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const APP = process.env.TEST_APP_URL || 'http://127.0.0.1:3000';
const ANON =
  process.env.TEST_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

/**
 * The project's minimum interval between messages — `auth.sms.max_frequency`.
 * Asking again inside it is refused with a 429 and no new code, which is a real
 * behaviour the resend cooldown exists to stay clear of.
 */
const MIN_INTERVAL_MS = 6000;

async function reachable(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

const ready =
  (await reachable(`${SUPABASE}/auth/v1/settings`, { headers: { apikey: ANON } })) &&
  (await reachable(`${APP}/api/health`)) &&
  (await reachable(`${APP}/dev/inbox`));

describe(
  'vendor phone OTP end to end',
  {
    skip: ready ? false : 'needs the local Supabase stack and `npm run dev` with SMS_PROVIDER=fake',
  },
  () => {
    // A range the seed never uses, so these accounts cannot collide with a
    // fixture and are trivially identifiable for cleanup.
    let seq = 0;
    const numbers = [];
    const phone = () => {
      const n = `+2332${String(Date.now()).slice(-6)}${String(seq++).padStart(2, '0')}`;
      numbers.push(n);
      return n;
    };

    after(async () => {
      if (numbers.length) {
        await asService((c) =>
          c.query('delete from auth.users where phone = any($1)', [
            numbers.map((n) => n.replace('+', '')),
          ])
        );
      }
      await closePools();
    });

    /** Asks Supabase for a code, exactly as startVendorSignUpAction does. */
    function requestCode(to) {
      return fetch(`${SUPABASE}/auth/v1/otp`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: to }),
      });
    }

    /**
     * The newest code the fake provider "sent" to this number.
     *
     * GoTrue hashes the token in auth.users, so the database is not an option;
     * the plaintext exists only in the message that was delivered.
     */
    async function codeFor(to) {
      const html = await (await fetch(`${APP}/dev/inbox`)).text();
      const text = html.replace(/<[^>]*>/g, ' ');
      const needle = to.replace('+', '');
      const at = text.indexOf(needle);
      if (at === -1) return null;
      return text.slice(at, at + 400).match(/\b(\d{6})\b/)?.[1] ?? null;
    }

    async function verify(to, token) {
      const res = await fetch(`${SUPABASE}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'sms', phone: to, token }),
      });
      return { status: res.status, body: await res.json() };
    }

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    test('a requested code is delivered, and it is six digits', async () => {
      const to = phone();
      assert.equal((await requestCode(to)).status, 200);
      await wait(600);

      const code = await codeFor(to);
      assert.match(
        code ?? '',
        /^\d{6}$/,
        'auth.sms.otp_length is 6 and the OTP input accepts exactly 6'
      );
    });

    test('the six-digit code verifies and issues a session', async () => {
      const to = phone();
      await requestCode(to);
      await wait(600);

      const { body } = await verify(to, await codeFor(to));
      assert.ok(body.access_token, 'verification must produce a real session');
      assert.equal(body.user?.phone, to.replace('+', ''));
    });

    test('a wrong code issues no session', async () => {
      const to = phone();
      await requestCode(to);
      await wait(600);

      const { status, body } = await verify(to, '000000');
      assert.equal(status, 403);
      assert.ok(!body.access_token, 'a guessed code must never produce a session');
    });

    /**
     * THE REGRESSION, reproduced. Asking for a second code invalidates the
     * first. Before the flow had a resend, the only way to get another code was
     * to resubmit the details form — so a vendor did exactly this without
     * realising, and the code in their hand stopped working. The fix is not to
     * keep the old one alive; it is to offer a resend that SAYS the previous one
     * is dead, and to verify against the newest.
     */
    test('a resend invalidates the previous code, and the newest one works', async () => {
      const to = phone();
      await requestCode(to);
      await wait(600);
      const first = await codeFor(to);

      // Past the project's minimum interval, or the resend is refused outright.
      await wait(MIN_INTERVAL_MS);
      assert.equal((await requestCode(to)).status, 200, 'the resend itself must be accepted');
      await wait(600);
      const second = await codeFor(to);

      assert.match(second ?? '', /^\d{6}$/);
      assert.notEqual(first, second, 'a resend must actually issue a different code');

      const stale = await verify(to, first);
      assert.equal(stale.status, 403, 'the superseded code must be refused');
      assert.ok(!stale.body.access_token);

      const fresh = await verify(to, second);
      assert.ok(fresh.body.access_token, 'the newest code is the one that must work');
    });

    /**
     * The number that receives a code and the number that verifies it must be
     * the same string. The code screen now carries the E.164 number the message
     * went to rather than re-deriving it from what was typed; this asserts the
     * property that carrying exists to guarantee.
     */
    test('a code is bound to the exact number it was sent to', async () => {
      const to = phone();
      await requestCode(to);
      await wait(600);
      const code = await codeFor(to);

      const other = phone();
      await requestCode(other);
      await wait(600);

      const crossed = await verify(other, code);
      assert.ok(!crossed.body.access_token, "one number's code must not verify another's");
    });
  }
);
