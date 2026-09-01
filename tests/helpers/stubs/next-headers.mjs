/**
 * Stands in for `next/headers` under the plain Node test runner.
 *
 * `next/headers` only exists inside a request. Modules like
 * lib/supabase/server.js import it at the top level, so importing anything that
 * transitively reaches them — lib/orders/transitions.js, for instance — fails
 * outright outside Next.
 *
 * It throws rather than returning an empty cookie store on purpose. A test that
 * genuinely needs a signed-in user's client should fail loudly and be rewritten
 * around the service-role path, not quietly get a session belonging to nobody.
 */
export function cookies() {
  throw new Error(
    'next/headers is not available outside a request. A test reaching for a ' +
      'user-scoped Supabase client should use tests/helpers/db.js instead.'
  );
}

export function headers() {
  throw new Error('next/headers is not available outside a request.');
}

export function draftMode() {
  return { isEnabled: false };
}
