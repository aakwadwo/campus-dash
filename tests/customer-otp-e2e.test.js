import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools } from './helpers/db.js';

/**
 * The customer email OTP, end to end, against the local Supabase stack.
 *
 * NOT MOCKED, AND NO REAL EMAIL LEAVES THE MACHINE. Supabase generates and
 * checks every code — nothing in Campus Dash does — so a stub of that would be
 * a test of the stub. The local stack delivers to Mailpit on 54324, which is
 * where the code is read from here exactly as a developer reads it.
 *
 * WHAT THIS PROVES THAT THE UNIT SUITE CANNOT:
 *
 *   * the email carries a NUMERIC TOKEN and no link, which is a property of the
 *     templates in supabase/templates/ and of nothing in the application
 *   * a FIRST-TIME address gets Confirm Signup and a returning one gets Magic
 *     Link — two templates, one flow, and the first is the half that silently
 *     breaks if only Magic Link carries {{ .Token }}
 *   * verifyOtp with type 'email' issues a real session
 *   * a wrong code issues none
 *   * the address is confirmed BY the verification, not at account creation
 *
 * ALWAYS THE LOCAL STACK, never whatever `.env.local` happens to name. Every
 * assertion below reads auth.users through the test pool, which connects to
 * 127.0.0.1:54322 unconditionally — so reading the URL from the app's own
 * environment would point the two halves at different databases the moment
 * somebody set up a hosted project. The anon key is the deterministic local
 * demo JWT for the same reason; both are overridable for an unusual setup.
 */
const SUPABASE = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const MAILPIT = process.env.TEST_MAILPIT_URL || 'http://127.0.0.1:54324';
const ANON =
  process.env.TEST_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

async function mailpitIsRunning() {
  try {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=1`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const running = await mailpitIsRunning();

describe(
  'customer email OTP end to end',
  {
    skip: running ? false : 'needs the local Supabase stack and Mailpit — run `npm run db:start`',
  },
  () => {
    // A domain the seed never uses, so these accounts cannot collide with a
    // fixture and are trivially identifiable for cleanup.
    const address = (tag) => `otp.${tag}.${Date.now()}@acity.edu.gh`;
    const created = [];

    before(async () => {
      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
    });

    after(async () => {
      await asService((c) =>
        c.query("delete from auth.users where email like 'otp.%@acity.edu.gh'")
      );
      await closePools();
    });

    /** Asks Supabase for a code, exactly as `signInWithOtp()` does. */
    async function requestCode(email, { createUser = true } = {}) {
      const res = await fetch(`${SUPABASE}/auth/v1/otp`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email, create_user: createUser }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    /**
     * Reads the newest message for an address out of Mailpit.
     *
     * POLLS, because delivery is asynchronous. GoTrue answers the HTTP request
     * as soon as it has queued the mail, so a single read races the SMTP hop
     * and fails intermittently — the worst kind of test.
     */
    async function inbox(email, { timeoutMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let match;

      while (!match) {
        const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
        const { messages = [] } = await res.json();
        match = messages.find((m) =>
          (m.To ?? []).some((t) => t.Address?.toLowerCase() === email.toLowerCase())
        );
        if (match) break;
        if (Date.now() > deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      const full = await (await fetch(`${MAILPIT}/api/v1/message/${match.ID}`)).json();
      const body = `${full.Text ?? ''}${full.HTML ?? ''}`;
      return {
        subject: match.Subject,
        body,
        token: (body.match(/\b\d{6}\b/) ?? [null])[0],
        // The template each email came from, told apart by its own copy.
        template: /finish creating your account/i.test(body)
          ? 'confirm-signup'
          : /already have open/i.test(body)
            ? 'magic-link'
            : 'unknown',
      };
    }

    async function verify(email, token) {
      const res = await fetch(`${SUPABASE}/auth/v1/verify`, {
        method: 'POST',
        headers: { apikey: ANON, 'content-type': 'application/json' },
        body: JSON.stringify({ email, token, type: 'email' }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    // =====================================================================
    // First-time sign-up
    // =====================================================================

    test('a first-time address gets the Confirm Signup template, with a code and no link', async () => {
      const email = address('first');
      created.push(email);

      const sent = await requestCode(email);
      assert.equal(sent.status, 200, 'email sign-up must be enabled on the project');

      const mail = await inbox(email);
      assert.ok(mail, 'an email was delivered');
      assert.equal(
        mail.template,
        'confirm-signup',
        'the FIRST email is Confirm Signup — the half that breaks when only Magic Link carries the token'
      );
      assert.match(mail.token ?? '', /^\d{6}$/, 'six digits');
      assert.ok(
        !/https?:\/\//i.test(mail.body),
        'no link anywhere: a link opens in whichever browser the mail app picks'
      );
      assert.match(mail.subject, /Campus Dash/);
    });

    test('the code establishes a real session', async () => {
      const email = address('session');
      created.push(email);

      await requestCode(email);
      const mail = await inbox(email);
      const result = await verify(email, mail.token);

      assert.equal(result.status, 200);
      assert.ok(result.body.access_token, 'a session was issued');
      assert.ok(result.body.refresh_token, 'and it can be refreshed, so it persists');
      assert.equal(result.body.user?.email, email);
    });

    test('the address is confirmed BY the verification, not at creation', async () => {
      const email = address('confirm');
      created.push(email);

      await requestCode(email);
      const before = await asService(
        async (c) =>
          (await c.query('select email_confirmed_at from auth.users where email = $1', [email]))
            .rows[0]
      );
      assert.equal(
        before?.email_confirmed_at,
        null,
        'an address nobody has read a code from is not verified'
      );

      const mail = await inbox(email);
      await verify(email, mail.token);

      const after = await asService(
        async (c) =>
          (await c.query('select email_confirmed_at from auth.users where email = $1', [email]))
            .rows[0]
      );
      assert.ok(after?.email_confirmed_at, 'reading the code out of the mailbox is the proof');
    });

    // =====================================================================
    // Returning sign-in
    // =====================================================================

    test('a returning address gets the Magic Link template, also as a code', async () => {
      const email = address('returning');
      created.push(email);

      await requestCode(email);
      const first = await inbox(email);
      await verify(email, first.token);
      assert.equal(first.template, 'confirm-signup');

      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });

      // Sign IN: the account exists, so no account may be created.
      const again = await requestCode(email, { createUser: false });
      assert.equal(again.status, 200);

      const second = await inbox(email);
      assert.equal(second.template, 'magic-link', 'the second email is a different template');
      assert.match(second.token ?? '', /^\d{6}$/, 'and the same six digits');
      assert.ok(!/https?:\/\//i.test(second.body), 'still no link');

      const session = await verify(email, second.token);
      assert.ok(session.body.access_token, 'and it signs them in');
    });

    test('an address that has never signed up cannot sign IN', async () => {
      // `create_user: false` is what makes the sign-in screen a sign-in screen.
      // Without it, "we sent you a code" would build a half-made account for
      // somebody who mistyped their address.
      const email = address('unknown');
      const result = await requestCode(email, { createUser: false });

      const exists = await asService(
        async (c) =>
          (await c.query('select count(*)::int as n from auth.users where email = $1', [email]))
            .rows[0].n
      );
      assert.equal(exists, 0, 'no account was created');
      assert.ok(result.status >= 400 || !result.body.access_token);
    });

    // =====================================================================
    // Wrong codes
    // =====================================================================

    test('a wrong code issues no session', async () => {
      const email = address('wrong');
      created.push(email);

      await requestCode(email);
      const mail = await inbox(email);
      const wrong = String((Number(mail.token) + 1) % 1000000).padStart(6, '0');

      const result = await verify(email, wrong);
      assert.ok(!result.body.access_token, 'a guessed code must never issue a session');

      const confirmed = await asService(
        async (c) =>
          (await c.query('select email_confirmed_at from auth.users where email = $1', [email]))
            .rows[0]
      );
      assert.equal(confirmed?.email_confirmed_at, null, 'and confirms nothing');
    });

    test('a code cannot be spent twice', async () => {
      const email = address('replay');
      created.push(email);

      await requestCode(email);
      const mail = await inbox(email);

      const first = await verify(email, mail.token);
      assert.ok(first.body.access_token, 'the first use works');

      const second = await verify(email, mail.token);
      assert.ok(!second.body.access_token, 'the second does not');
    });

    test('a new code replaces the previous one', async () => {
      // The reason the form puts a cooldown in front of the resend button: a
      // second code kills the one somebody is halfway through typing.
      const email = address('resend');
      created.push(email);

      await requestCode(email);
      const first = await inbox(email);
      assert.ok(first?.token, 'the first code arrived');
      await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });

      // auth.email.max_frequency throttles how often one address may be sent
      // to. Waiting past it is the point of the cooldown the form shows.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const resent = await requestCode(email);
      assert.equal(resent.status, 200, 'a second code was accepted');
      const second = await inbox(email);
      assert.ok(second?.token, 'a second code arrived');

      if (second.token !== first.token) {
        const stale = await verify(email, first.token);
        assert.ok(!stale.body.access_token, 'the older code no longer works');
      }

      const fresh = await verify(email, second.token);
      assert.ok(fresh.body.access_token, 'and the newer one does');
    });
  }
);
