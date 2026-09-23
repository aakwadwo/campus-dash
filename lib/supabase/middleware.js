import { createServerClient, DEFAULT_COOKIE_OPTIONS } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { ADMIN_SESSION_COOKIE, isAuthTokenCookie, sessionOnly } from '@/lib/auth/admin-session';

/**
 * Refreshes the Supabase auth session on every request and writes the rotated
 * cookies onto the response. Server Components cannot set cookies, so without
 * this a long-lived session silently expires mid-order.
 *
 * This is session plumbing ONLY. Authorisation is enforced by RLS and by
 * explicit server-side checks in route handlers — never by middleware alone.
 */
export async function updateSession(request) {
  let response = NextResponse.next({ request });

  // Before Supabase is wired up there is no session to refresh. Pass through
  // rather than failing every request — any route that reads data still throws
  // loudly via config.js.
  if (!config.isSupabaseConfigured()) {
    if (!config.isProduction()) {
      console.warn('[auth] Supabase not configured — skipping session refresh. See .env.example.');
    }
    return response;
  }

  // An administrator sign-in marked this browser. Rotated auth cookies stay
  // session-only for as long as the marker names the signed-in user.
  const adminMarker = request.cookies.get(ADMIN_SESSION_COOKIE)?.value ?? null;

  const supabase = createServerClient(config.supabaseUrl(), config.supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        const scoped = adminMarker ? sessionOnly(cookiesToSet) : cookiesToSet;
        scoped.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        scoped.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Refreshes an expired session and rotates cookies as a side effect. Do not
  // remove.
  //
  // getClaims(), not getUser(). This runs in front of EVERY request — each
  // page, each server action, each status poll — and getUser() is a round trip
  // to Supabase Auth each time. The project signs tokens with an asymmetric
  // key (ES256), so getClaims() verifies the signature locally against the
  // published key set, cached per server instance, and only reaches the network
  // to refresh a token that has expired. Nothing here authorises anything: the
  // claims are used only to recognise the admin marker's owner, and every read
  // and write is still checked by Postgres against the same JWT.
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub ?? null;

  // A STALE MARKER. The admin session ended without a sign-out and somebody
  // signed in another way in the same browser. Drop the marker and hand the
  // session back its ordinary persistent cookie, so a customer or vendor who
  // happens to follow an administrator on a shared machine is never quietly
  // signed out when the browser closes.
  if (adminMarker && adminMarker !== userId) {
    response.cookies.delete(ADMIN_SESSION_COOKIE);
    if (userId) {
      request.cookies
        .getAll()
        .filter(({ name, value }) => isAuthTokenCookie(name) && value)
        .forEach(({ name, value }) => response.cookies.set(name, value, DEFAULT_COOKIE_OPTIONS));
    }
  }

  return response;
}
