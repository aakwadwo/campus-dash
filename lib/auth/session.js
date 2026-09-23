import 'server-only';

import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { areasFor, landingFor, vendorOnlyHome } from './landing';
import { adminAccess } from './admin-session';
import { ERROR_KIND } from '@/lib/errors';

/**
 * Server-side session and capability access.
 *
 * Capabilities are DERIVED FROM THE DATABASE on every request, never read from
 * a client-supplied value. The browser is told what it may do so the UI renders
 * correctly; it is never believed. Each RPC and RLS policy re-derives the same
 * facts independently, so a tampered client changes nothing but its own display.
 *
 * ONCE PER REQUEST, NEVER ACROSS REQUESTS. A single page render used to ask
 * Supabase Auth who the caller was three or four times — the layout, the page,
 * the site header and the area switcher each asked for themselves, one after
 * another. getUser(), getCapabilities() and the admin claims check are wrapped
 * in React's cache(), which memoises within ONE server render and nothing more:
 * each request gets its own scope, so one person's session can never answer for
 * another's. Outside a render — a Server Action body, a Route Handler — cache()
 * passes straight through, so an action that has just changed somebody's
 * capabilities reads them fresh, and the render that follows starts a new scope.
 */

/**
 * The authenticated user, or null.
 * Uses getUser(), which revalidates the JWT against the auth server, rather
 * than getSession(), whose contents are attacker-controllable cookies.
 */
export const getUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
});

const SIGNED_OUT = Object.freeze({ authenticated: false });

/**
 * Capabilities for the signed-in account. Safe to render into the page.
 *
 * ONE ROUND TRIP, NOT TWO. This used to ask Supabase Auth who the caller was
 * (getUser) and only then ask the database what they may do. The database
 * question is the one that matters, and PostgREST verifies the same JWT before
 * my_capabilities() runs — auth.uid() inside it is that verified subject — so
 * the Auth round trip decided nothing the database was not already deciding.
 * getClaims() checks the token locally (asymmetric signing key, cached) and
 * only stops a signed-out visitor from making the call at all.
 */
export const getCapabilities = cache(async () => {
  const supabase = await createClient();
  const { data: session } = await supabase.auth.getClaims();
  if (!session?.claims?.sub) return SIGNED_OUT;

  const { data, error } = await supabase.rpc('my_capabilities');
  if (error) {
    console.error('[auth] my_capabilities failed:', error.message);
    return SIGNED_OUT;
  }
  // A confirmed phone with no profile row yet (the trigger runs on
  // confirmation) reads as signed out rather than as a half-built account.
  return data?.authenticated ? data : SIGNED_OUT;
});

/** Redirects to the login page when there is no session. */
export async function requireUser(returnTo = '/account') {
  const capabilities = await getCapabilities();
  if (!capabilities.authenticated) {
    redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  }
  if (capabilities.is_suspended) {
    redirect('/suspended');
  }
  return capabilities;
}

/** The route this account belongs on, derived from the database. */
export async function myLanding() {
  return landingFor(await getCapabilities());
}

/** Every area this account may enter. Drives the switcher in each layout. */
export async function myAreas() {
  return areasFor(await getCapabilities());
}

/**
 * These guards exist so a page cannot forget to check. They are NOT the
 * security boundary — RLS and the SECURITY DEFINER functions are. A user who
 * bypassed one of these would reach a page that renders nothing they are
 * entitled to, because every query underneath still filters by auth.uid().
 *
 * Someone who fails a check is sent to the area they DO belong in rather than
 * to a generic page. There is no loop in that: landingFor only ever returns a
 * route the capability check it is derived from would accept.
 */
/**
 * ADMINISTRATORS HAVE THEIR OWN DOOR, so this guard does not go through
 * requireUser().
 *
 * requireUser() sends a signed-out visitor to /login, which is the CUSTOMER
 * screen: it asks for an @acity.edu.gh address and emails a code. An
 * administrator has no customer profile and, deliberately, may not even have a
 * school address — the credential is a password, and operational access must
 * not depend on a message arriving. Sending them there offered a proof they
 * cannot give and left the console unreachable.
 *
 * `next` is carried through so a deep link into the console survives the
 * sign-in; adminSignIn re-derives is_admin from the database before honouring
 * it, and safeNext() keeps it a path on this application.
 *
 * AN ADMINISTRATOR IS NOT ENOUGH; THE SESSION MUST BE AN ADMIN SESSION. It has
 * to come from a password, proved within ADMIN_SESSION_MAX_SECONDS, read from
 * the verified JWT. An administrator signed in with an emailed code, or whose
 * password sign-in is too old, is sent back to /login/admin to prove it again.
 * See lib/auth/admin-session.js.
 */
const adminDecision = cache(async () => {
  const capabilities = await getCapabilities();
  if (!capabilities.authenticated || capabilities.is_suspended || !capabilities.is_admin) {
    return { capabilities, access: adminAccess(capabilities, null) };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) console.error('[auth] admin getClaims failed:', error.message);
  return { capabilities, access: adminAccess(capabilities, error ? null : data?.claims) };
});

export async function requireAdmin(returnTo = '/admin') {
  const { capabilities, access } = await adminDecision();
  if (access.ok) return capabilities;

  const next = encodeURIComponent(returnTo);
  if (access.reason === 'signed-out') redirect(`/login/admin?next=${next}`);
  if (access.reason === 'suspended') redirect('/suspended');
  if (access.reason === 'not-admin') redirect(landingFor(capabilities));
  // 'password' or 'expired'. /login/admin renders for anybody and never
  // redirects, so this cannot loop.
  redirect(`/login/admin?next=${next}&reason=${access.reason}`);
}

const SESSION_ENDED = 'Your administrator session has ended. Sign in again at /login/admin.';

const ADMIN_ACTION_REFUSALS = {
  'signed-out': SESSION_ENDED,
  expired: SESSION_ENDED,
  password: 'Sign in with your administrator password at /login/admin to do this.',
  suspended: 'This account is suspended.',
  'not-admin': 'This account does not have administrator access.',
};

/**
 * The same decision for a SERVER ACTION, which is a public POST endpoint in its
 * own right: the admin layout does not run in front of it. Returns null when
 * the caller may proceed, and otherwise the refusal to return to the form, in
 * the `{ ok, message }` shape every admin action already uses.
 *
 * Service-role paths (settlement, payouts) have no is_admin() in the database
 * to fall back on, so for them this is the check, not a courtesy.
 */
export async function authoriseAdminAction() {
  const { access } = await adminDecision();
  if (access.ok) return null;
  return { ok: false, kind: ERROR_KIND.FORBIDDEN, message: ADMIN_ACTION_REFUSALS[access.reason] };
}

/**
 * A VENDOR-ONLY ACCOUNT has no customer screens. Somebody who runs a store and
 * does not hold the Customer capability is sent to their store from the
 * homepage and from every marketplace route, rather than being shown a
 * marketplace they cannot order from. Student vendors (can_order) browse as
 * normal. The decision is landing.js's vendorOnlyHome(); this only acts on it.
 *
 * Pass capabilities a page already fetched to save a round trip.
 */
export async function redirectVendorOnlyAccount(capabilities = null) {
  const me = capabilities ?? (await getCapabilities());
  const home = vendorOnlyHome(me);
  if (home) redirect(home);
  return me;
}

export async function requirePartner() {
  const capabilities = await requireUser('/partner');
  if (!capabilities.is_partner) redirect(landingFor(capabilities));
  return capabilities;
}

/**
 * The CUSTOMER capability, for the screens that spend it.
 *
 * Sends someone to /signup rather than to landingFor(), which is the one
 * case where those two answers differ: an administrator with no customer
 * profile would be bounced to /admin by landingFor(), which is not an answer to
 * "you wanted to order something". Onboarding is the thing they can actually do
 * about it, and it is open to every signed-in account.
 */
export async function requireCustomer(returnTo = '/order') {
  const capabilities = await requireUser(returnTo);
  if (!capabilities.can_order) {
    redirect(`/signup?next=${encodeURIComponent(returnTo)}`);
  }
  return capabilities;
}

/**
 * An OPERABLE store. A pending or rejected applicant is not one.
 *
 * They are sent to /vendor/application rather than bounced by landingFor(),
 * which is the one case where those two answers differ: an applicant belongs on
 * the page that tells them where their application stands, and for a rejection
 * that page is the only place the reason exists.
 */
export async function requireVendorStaff() {
  const capabilities = await requireUser('/vendor');
  if (!capabilities.vendor_ids?.length) {
    if (capabilities.vendor_status && capabilities.vendor_status !== 'NOT_APPLIED') {
      redirect('/vendor/application');
    }
    redirect(landingFor(capabilities));
  }
  return capabilities;
}
