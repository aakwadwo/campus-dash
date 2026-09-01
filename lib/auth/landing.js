/**
 * Where a signed-in account belongs.
 *
 * Sign-in is one flow for four kinds of person, so the destination has to be
 * derived rather than chosen by the caller. It is derived from
 * `my_capabilities()`, which the database recomputes on every request — never
 * from anything the browser said about itself. Getting this wrong sends someone
 * somewhere they cannot use; it cannot send them somewhere they are not
 * entitled to, because every one of these routes re-checks on arrival and the
 * data underneath is filtered by RLS regardless.
 *
 * Order is precedence, not preference. An admin who also staffs a stall lands
 * on /admin because that is the job they signed in to do; they can still walk
 * to /vendor.
 *
 * Kept free of server-only imports so it can be tested as the pure decision it
 * is — see tests/auth-landing.test.js.
 */

/** Applied to be a Partner, but not (or no longer) approved to carry deliveries. */
const APPLICATION_IN_PROGRESS = new Set(['PENDING_REVIEW', 'REJECTED', 'SUSPENDED']);

export function landingFor(capabilities) {
  if (!capabilities?.authenticated) return '/login';

  // A suspended account is not routed by capability. It is stopped.
  if (capabilities.is_suspended) return '/suspended';

  if (capabilities.is_admin) return '/admin';
  if (capabilities.vendor_ids?.length) return '/vendor';
  if (capabilities.is_partner) return '/partner';

  // An applicant is not a Partner yet, so /partner would show them nothing they
  // can act on. Their own application status is the useful page — the admin
  // review queue at /admin/partners is somebody else's screen.
  if (APPLICATION_IN_PROGRESS.has(capabilities.partner_status)) return '/partner/apply';

  return '/order';
}

/**
 * A `next` value is caller-supplied, so it is only ever honoured as a path on
 * this application. An absolute URL, a protocol-relative `//evil.example` or a
 * backslash-prefixed variant would all make sign-in an open redirect.
 */
export function safeNext(next) {
  const value = typeof next === 'string' ? next.trim() : '';
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}
