/**
 * The administrator session: what makes it OPERATIONAL rather than persistent.
 *
 * Customers and vendors stay signed in. Their session cookie lives 400 days and
 * the proxy renews it on every visit, because a vendor with a 60-second answer
 * window must never find the order board signed out. The console is the
 * opposite case: it can cancel orders and move money, so the session behind it
 * should end when the work does.
 *
 * Two independent limits, because neither is enough alone:
 *
 *   SESSION-ONLY COOKIES. A sign-in through /login/admin writes the Supabase
 *   auth cookies with no Max-Age, so closing the browser ends them. Browsers
 *   that restore a session on relaunch keep such cookies alive, which is why
 *   this is not the boundary.
 *
 *   A SERVER-SIDE TIME LIMIT. The console requires the access token to carry a
 *   PASSWORD authentication (the JWT `amr` claim) no older than
 *   ADMIN_SESSION_MAX_SECONDS. The timestamp is the original sign-in and
 *   survives token refresh, so staying active does not extend it. This is also
 *   what keeps an administrator who holds the Customer capability from reaching
 *   the console through an emailed code: that session's method is `otp`.
 *
 * Same Supabase Auth, same identity, same cookie. Nothing here is a second
 * authentication system; it is a narrower reading of the one there is.
 *
 * Kept free of server-only imports so the decisions can be tested directly.
 */

/**
 * How long a password sign-in may operate the console. A code-level
 * authentication constant by decision, not an operational number: it is not in
 * pricing_config and the pilot cannot retune it from /admin/pilot.
 */
export const ADMIN_SESSION_MAX_SECONDS = 8 * 60 * 60;

/**
 * Set by adminSignIn, holding the administrator's user id. While it is present
 * and names the signed-in user, auth cookies are written session-only.
 *
 * Forging it gains nothing: all it can do is shorten your own cookie's life.
 * It is never read as authority. The console checks the JWT, not this.
 */
export const ADMIN_SESSION_COOKIE = 'cd-admin-session';

/** The Supabase auth cookie family, chunked (`.0`, `.1`) or not. */
export function isAuthTokenCookie(name) {
  return typeof name === 'string' && /^sb-.+-auth-token(\.\d+)?$/.test(name);
}

/**
 * The same cookies with their lifetime removed, so the browser drops them when
 * it closes.
 *
 * @supabase/ssr forces Max-Age to 400 days whatever cookieOptions it is given,
 * so this has to happen in our own setAll. A REMOVAL (Max-Age 0) is left
 * exactly as it is: stripping that would turn "delete this chunk" into "keep
 * this empty chunk until the browser closes".
 */
export function sessionOnly(cookiesToSet) {
  return cookiesToSet.map((cookie) => {
    if (!isAuthTokenCookie(cookie.name)) return cookie;
    const options = { ...(cookie.options ?? {}) };
    if (options.maxAge === 0) return cookie;
    delete options.maxAge;
    delete options.expires;
    return { ...cookie, options };
  });
}

/** When this session last proved a password, in epoch seconds, or null. */
export function passwordSignedInAt(claims) {
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  const stamps = amr
    .filter((entry) => entry?.method === 'password' && Number.isFinite(entry.timestamp))
    .map((entry) => entry.timestamp);
  return stamps.length ? Math.max(...stamps) : null;
}

/**
 * Whether these verified JWT claims may operate the console right now.
 *
 * @returns {{ ok: true, expiresAt: number } | { ok: false, reason: 'password' | 'expired' }}
 */
export function adminSessionState(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  const signedInAt = passwordSignedInAt(claims);
  if (signedInAt === null) return { ok: false, reason: 'password' };

  const expiresAt = signedInAt + ADMIN_SESSION_MAX_SECONDS;
  if (nowSeconds >= expiresAt) return { ok: false, reason: 'expired' };

  return { ok: true, expiresAt };
}

/**
 * The whole console decision: who is asking, and on what session.
 *
 * Capabilities come from my_capabilities(); claims from a VERIFIED token
 * (getClaims). Neither is taken from anything the browser said.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'signed-out' | 'suspended' | 'not-admin' | 'password' | 'expired' }}
 */
export function adminAccess(capabilities, claims, nowSeconds) {
  if (!capabilities?.authenticated) return { ok: false, reason: 'signed-out' };
  if (capabilities.is_suspended) return { ok: false, reason: 'suspended' };
  if (!capabilities.is_admin) return { ok: false, reason: 'not-admin' };

  const session = adminSessionState(claims, nowSeconds);
  return session.ok ? { ok: true } : session;
}
