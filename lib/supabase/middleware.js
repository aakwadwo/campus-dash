import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';

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

  const supabase = createServerClient(config.supabaseUrl(), config.supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  // Revalidates the JWT and rotates cookies as a side effect. Do not remove.
  await supabase.auth.getUser();

  return response;
}
