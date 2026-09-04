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
 * ORDER IS PRECEDENCE, NOT EXCLUSIVITY. This is the single most misread thing
 * in the application, so it is worth being blunt: an administrator who is also
 * a customer lands on /admin because that is the job they signed in to do. They
 * have not lost the customer capability and they are not blocked from /order —
 * every area carries a link to the others (see AreaSwitcher), because the
 * account genuinely holds all of them.
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

  // A verified phone is an IDENTITY. Ordering is a CAPABILITY, and it is
  // acquired by completing student onboarding. Someone who has done neither is
  // sent to do the one thing that unlocks everything else on this side of the
  // app.
  if (!capabilities.can_order) return '/onboarding';

  return '/order';
}

/**
 * Every area this account may enter, in the same precedence order.
 *
 * The routing above sends a multi-capability account to ONE place. This is what
 * lets it reach the others — an administrator who also orders lunch, an
 * approved Partner who also staffs a stall. Derived from the same capabilities
 * the database computed, so it can never offer an area the destination would
 * bounce them out of.
 */
export function areasFor(capabilities) {
  if (!capabilities?.authenticated || capabilities.is_suspended) return [];

  const areas = [];
  if (capabilities.is_admin) areas.push({ href: '/admin', label: 'Admin' });
  if (capabilities.vendor_ids?.length) areas.push({ href: '/vendor', label: 'Vendor' });
  if (capabilities.is_partner) areas.push({ href: '/partner', label: 'Partner' });
  if (capabilities.can_order) areas.push({ href: '/order', label: 'Order' });
  areas.push({ href: '/account', label: 'Account' });
  return areas;
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
