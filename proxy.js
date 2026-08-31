import { updateSession } from '@/lib/supabase/middleware';

/**
 * Runs before every matched request. Its ONLY job is refreshing the Supabase
 * auth session and rotating cookies — Server Components cannot set cookies, so
 * without this a long-lived session silently expires mid-order.
 *
 * Authorisation is never enforced here. It lives in Row Level Security and in
 * explicit checks inside route handlers.
 *
 * (Next 16 renamed the `middleware` file convention to `proxy`.)
 */
export default async function proxy(request) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and image files.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
