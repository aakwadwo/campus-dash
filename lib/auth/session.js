import 'server-only';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { landingFor } from './landing';

/**
 * Server-side session and capability access.
 *
 * Capabilities are DERIVED FROM THE DATABASE on every request, never read from
 * a client-supplied value. The browser is told what it may do so the UI renders
 * correctly; it is never believed. Each RPC and RLS policy re-derives the same
 * facts independently, so a tampered client changes nothing but its own display.
 */

/**
 * The authenticated user, or null.
 * Uses getUser(), which revalidates the JWT against the auth server, rather
 * than getSession(), whose contents are attacker-controllable cookies.
 */
export async function getUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user ?? null;
}

const SIGNED_OUT = Object.freeze({ authenticated: false });

/** Capabilities for the signed-in account. Safe to render into the page. */
export async function getCapabilities() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return SIGNED_OUT;

  const { data, error } = await supabase.rpc('my_capabilities');
  if (error) {
    console.error('[auth] my_capabilities failed:', error.message);
    return SIGNED_OUT;
  }
  // A confirmed phone with no profile row yet (the trigger runs on
  // confirmation) reads as signed out rather than as a half-built account.
  return data?.authenticated ? data : SIGNED_OUT;
}

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
export async function requireAdmin() {
  const capabilities = await requireUser('/admin');
  if (!capabilities.is_admin) redirect(landingFor(capabilities));
  return capabilities;
}

export async function requirePartner() {
  const capabilities = await requireUser('/partner');
  if (!capabilities.is_partner) redirect(landingFor(capabilities));
  return capabilities;
}

export async function requireVendorStaff() {
  const capabilities = await requireUser('/vendor');
  if (!capabilities.vendor_ids?.length) redirect(landingFor(capabilities));
  return capabilities;
}
