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

  // Revalidates the JWT and rotates cookies as a side effect. Do not remove.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A STALE MARKER. The admin session ended without a sign-out and somebody
  // signed in another way in the same browser. Drop the marker and hand the
  // session back its ordinary persistent cookie, so a customer or vendor who
  // happens to follow an administrator on a shared machine is never quietly
  // signed out when the browser closes.
  if (adminMarker && adminMarker !== user?.id) {
    response.cookies.delete(ADMIN_SESSION_COOKIE);
    if (user) {
      request.cookies
        .getAll()
        .filter(({ name, value }) => isAuthTokenCookie(name) && value)
        .forEach(({ name, value }) => response.cookies.set(name, value, DEFAULT_COOKIE_OPTIONS));
    }
  }

  return response;
}
