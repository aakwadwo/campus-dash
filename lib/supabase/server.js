import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { config } from '@/lib/config';

/**
 * Supabase client for server components, server actions and route handlers.
 *
 * Acts *as the signed-in user*: RLS still applies and `auth.uid()` resolves to
 * them. This is the default choice on the server — reach for the admin client
 * only when an operation genuinely has to cross a user boundary.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(config.supabaseUrl(), config.supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only.
          // Session refresh is handled by middleware.js instead.
        }
      },
    },
  });
}

/**
 * Returns the authenticated user, or null.
 *
 * Always uses getUser() (which revalidates the JWT against the auth server)
 * rather than getSession(), whose contents are attacker-controllable cookies.
 */
export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}
