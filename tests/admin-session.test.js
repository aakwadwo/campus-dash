import './helpers/local-supabase.js';

import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_COOKIE_OPTIONS } from '@supabase/ssr';
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_SECONDS,
  adminAccess,
  adminSessionState,
  isAuthTokenCookie,
  passwordSignedInAt,
  sessionOnly,
} from '../lib/auth/admin-session.js';
import { updateSession } from '../lib/supabase/middleware.js';
import { withRequestCookies } from './helpers/stubs/next-headers.mjs';
import { closePools, ACTORS } from './helpers/db.js';
import {
  AUTH_COOKIE,
  claimsOf,
  otpSession,
  passwordSession,
  sessionCookies,
  temporaryCustomer,
  temporaryVendor,
  SEEDED_ADMIN,
} from './helpers/sessions.js';

/**
 * The administrator session is OPERATIONAL: session-only cookies, a password
 * sign-in, and eight hours. Customer and vendor sessions are PERSISTENT and
 * must stay exactly as they were. Both halves are asserted here, because the
 * cheapest way to break the second is to get the first slightly wrong.
 */

const ADMIN = { authenticated: true, is_admin: true, is_suspended: false };
const HOUR = 60 * 60;
const T0 = 1_800_000_000;
const password = (timestamp) => ({ amr: [{ method: 'password', timestamp }] });

describe('the admin time limit', () => {
  test('is eight hours, as a code-level constant', () => {
    assert.equal(ADMIN_SESSION_MAX_SECONDS, 8 * HOUR);
  });

  test('a password sign-in operates the console inside the limit', () => {
    assert.deepEqual(adminSessionState(password(T0), T0), { ok: true, expiresAt: T0 + 8 * HOUR });
    assert.equal(adminSessionState(password(T0), T0 + 8 * HOUR - 1).ok, true);
  });

  test('and not from the moment the limit is reached', () => {
    assert.deepEqual(adminSessionState(password(T0), T0 + 8 * HOUR), {
      ok: false,
      reason: 'expired',
    });
    assert.equal(adminSessionState(password(T0), T0 + 30 * HOUR).reason, 'expired');
  });

  test('an emailed code is not a password, however recent', () => {
    const otp = { amr: [{ method: 'otp', timestamp: T0 }] };
    assert.deepEqual(adminSessionState(otp, T0), { ok: false, reason: 'password' });
  });

  test('missing or malformed claims are refused, never assumed', () => {
    for (const claims of [
      null,
      undefined,
      {},
      { amr: 'password' },
      { amr: [{ method: 'password' }] },
    ]) {
      assert.deepEqual(adminSessionState(claims, T0), { ok: false, reason: 'password' });
    }
  });

  test('the password proof is found among other methods', () => {
    const mixed = {
      amr: [
        { method: 'totp', timestamp: T0 + 5 },
        { method: 'password', timestamp: T0 },
      ],
    };
    assert.equal(passwordSignedInAt(mixed), T0);
  });
});

describe('who may operate the console', () => {
  const claims = password(T0);

  test('an administrator on a fresh password session', () => {
    assert.deepEqual(adminAccess(ADMIN, claims, T0), { ok: true });
  });

  test('refusals, in order of what is wrong first', () => {
    assert.equal(adminAccess({ authenticated: false }, claims, T0).reason, 'signed-out');
    assert.equal(adminAccess({ ...ADMIN, is_suspended: true }, claims, T0).reason, 'suspended');
    assert.equal(adminAccess({ ...ADMIN, is_admin: false }, claims, T0).reason, 'not-admin');
    assert.equal(
      adminAccess(ADMIN, { amr: [{ method: 'otp', timestamp: T0 }] }, T0).reason,
      'password'
    );
    assert.equal(adminAccess(ADMIN, claims, T0 + 8 * HOUR).reason, 'expired');
  });
});

describe('session-only cookies', () => {
  test('recognises the Supabase auth cookie, chunked or not, and nothing else', () => {
    assert.ok(isAuthTokenCookie('sb-fdznxfglimyikxjouvqb-auth-token'));
    assert.ok(isAuthTokenCookie('sb-127-auth-token.0'));
    assert.ok(!isAuthTokenCookie(ADMIN_SESSION_COOKIE));
    assert.ok(!isAuthTokenCookie('sb-127-auth-token-code-verifier'));
    assert.ok(!isAuthTokenCookie('other'));
  });

  test('strips the lifetime from auth cookies and leaves removals alone', () => {
    const out = sessionOnly([
      { name: 'sb-x-auth-token.0', value: 'a', options: { ...DEFAULT_COOKIE_OPTIONS } },
      { name: 'sb-x-auth-token.1', value: '', options: { ...DEFAULT_COOKIE_OPTIONS, maxAge: 0 } },
      { name: 'unrelated', value: 'b', options: { maxAge: 99 } },
    ]);
    assert.equal(out[0].options.maxAge, undefined);
    assert.equal(out[0].options.path, '/');
    assert.equal(out[1].options.maxAge, 0, 'a chunk deletion must still delete');
    assert.equal(out[2].options.maxAge, 99);
  });
});

/**
 * Against GoTrue itself. A hand-made token would only prove the parser agrees
 * with the person who wrote it.
 */
describe('real sessions from the local stack', () => {
  const verifier = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );

  async function verifiedClaims(session) {
    const { data, error } = await verifier.auth.getClaims(session.access_token);
    assert.ifError(error);
    return data.claims;
  }

  test('the admin password sign-in works and carries a password proof', async () => {
    const session = await passwordSession(SEEDED_ADMIN);
    const claims = await verifiedClaims(session);
    assert.equal(claims.sub, ACTORS.admin);
    const now = Math.floor(Date.now() / 1000);
    assert.deepEqual(adminAccess(ADMIN, claims, now), { ok: true });
    // ...and expires eight hours after that sign-in.
    assert.equal(
      adminAccess(ADMIN, claims, passwordSignedInAt(claims) + 8 * HOUR).reason,
      'expired'
    );
  });

  test('the same administrator signed in by emailed code is refused', async () => {
    const session = await otpSession(SEEDED_ADMIN.email);
    const claims = await verifiedClaims(session);
    assert.equal(claims.sub, ACTORS.admin);
    assert.equal(adminAccess(ADMIN, claims, Math.floor(Date.now() / 1000)).reason, 'password');
  });

  test('refreshing does not reset the clock', async () => {
    const session = await passwordSession(SEEDED_ADMIN);
    const signedInAt = passwordSignedInAt(claimsOf(session.access_token));
    const { data, error } = await verifier.auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    assert.ifError(error);
    assert.equal(passwordSignedInAt(claimsOf(data.session.access_token)), signedInAt);
  });
});

/**
 * The proxy, which renews every session on every request. Each case hands it a
 * session whose access token is marked expired, so it must refresh and write
 * new cookies — the moment a lifetime is decided.
 */
describe('cookie lifetime through the session proxy', () => {
  let customer;
  let vendor;

  before(async () => {
    customer = await temporaryCustomer();
    vendor = await temporaryVendor();
  });

  after(async () => {
    await customer?.remove();
    await vendor?.remove();
    await closePools();
  });

  function staleCookies(session) {
    return sessionCookies({ ...session, expires_at: Math.floor(Date.now() / 1000) - 60 });
  }

  async function throughProxy(cookies) {
    const header = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const request = new NextRequest('http://localhost:3000/order', { headers: { cookie: header } });
    return updateSession(request);
  }

  function authCookies(response) {
    const written = response.cookies.getAll().filter((c) => isAuthTokenCookie(c.name) && c.value);
    assert.ok(written.length > 0, 'the proxy should have rotated the session');
    return written;
  }

  const PERSISTENT = DEFAULT_COOKIE_OPTIONS.maxAge;

  test('a customer session stays persistent', async () => {
    const response = await throughProxy(staleCookies(await otpSession(customer.email)));
    for (const cookie of authCookies(response)) assert.equal(cookie.maxAge, PERSISTENT);
  });

  test('a vendor session stays persistent', async () => {
    // Owns an ACTIVE store and holds no Customer capability.
    const response = await throughProxy(staleCookies(await otpSession(vendor.email)));
    for (const cookie of authCookies(response)) assert.equal(cookie.maxAge, PERSISTENT);
  });

  test('an admin session marked by the admin sign-in is session-only', async () => {
    const response = await throughProxy({
      ...staleCookies(await passwordSession(SEEDED_ADMIN)),
      [ADMIN_SESSION_COOKIE]: ACTORS.admin,
    });
    for (const cookie of authCookies(response)) {
      assert.equal(cookie.maxAge, undefined);
      assert.equal(cookie.expires, undefined);
    }
    assert.equal(response.cookies.get(ADMIN_SESSION_COOKIE), undefined, 'marker left alone');
  });

  test('a stale marker never shortens somebody else’s session', async () => {
    const response = await throughProxy({
      ...sessionCookies(await otpSession(customer.email)),
      [ADMIN_SESSION_COOKIE]: ACTORS.admin,
    });
    for (const cookie of authCookies(response)) assert.equal(cookie.maxAge, PERSISTENT);
    assert.equal(response.cookies.get(ADMIN_SESSION_COOKIE)?.value, '', 'marker deleted');
  });

  test('a marker with no session is cleared', async () => {
    const response = await throughProxy({ [ADMIN_SESSION_COOKIE]: ACTORS.admin });
    assert.equal(response.cookies.get(ADMIN_SESSION_COOKIE)?.value, '');
  });

  test('the server client writes session-only only under the marker', async () => {
    const { createClient: serverClient } = await import('../lib/supabase/server.js');

    const lifetimes = async (extra, session) =>
      withRequestCookies({ ...staleCookies(session), ...extra }, async (jar) => {
        const supabase = await serverClient();
        await supabase.auth.getUser();
        return [...jar]
          .filter(([name, { value }]) => isAuthTokenCookie(name) && value)
          .map(([, { options }]) => options?.maxAge);
      });

    const customerLifetimes = await lifetimes({}, await otpSession(customer.email));
    assert.ok(customerLifetimes.length && customerLifetimes.every((m) => m === PERSISTENT));

    const adminLifetimes = await lifetimes(
      { [ADMIN_SESSION_COOKIE]: ACTORS.admin },
      await passwordSession(SEEDED_ADMIN)
    );
    assert.ok(adminLifetimes.length && adminLifetimes.every((m) => m === undefined));
  });

  test(`the auth cookie name matches what @supabase/ssr reads (${AUTH_COOKIE})`, async () => {
    const response = await throughProxy(staleCookies(await otpSession(customer.email)));
    assert.ok(response.cookies.getAll().some((c) => c.name.startsWith(AUTH_COOKIE)));
  });
});
