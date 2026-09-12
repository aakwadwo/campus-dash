'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { config } from '@/lib/config';

/**
 * Administrator password recovery.
 *
 * WHY THIS EXISTS AT ALL, WHEN NOTHING ELSE HAS A PASSWORD
 * -------------------------------------------------------
 * Administrators are the one door with no code behind it, so they are also the
 * one door somebody can be locked out of. `npm run admin:password` recovers an
 * account from a terminal with the service-role key, which is right for
 * bootstrapping and wrong as the everyday answer: it requires a checkout, a
 * key, and a person who knows both. This is the everyday answer.
 *
 * WHAT KEEPS IT FROM BEING A WAY IN
 * ---------------------------------
 * 1. A LINK IS ONLY EVER SENT TO AN ADMINISTRATOR. The address is checked
 *    against `public.users.is_admin` with the service-role client before
 *    Supabase is asked for anything, so a customer or a vendor cannot be handed
 *    a password — a credential their account is not supposed to have.
 * 2. THE ANSWER IS THE SAME EITHER WAY. One sentence for an address that got a
 *    link and an address that did not, because telling them apart would confirm
 *    which addresses are administrators — the same reason adminSignIn returns
 *    one message for every failure.
 * 3. THE RECOVERY SESSION IS SPENT ON THE PASSWORD AND THROWN AWAY. Setting the
 *    password signs the session out, so following a link never lands anybody in
 *    the console; they arrive back at /login/admin and prove the new password.
 * 4. is_admin IS RE-DERIVED FROM THE DATABASE at every step, never carried in
 *    the link or the session, exactly as my_capabilities() does everywhere else.
 *
 * Supabase Auth issues and validates the recovery token. We never generate,
 * store or check one, which keeps that surface in one audited place.
 */

/** One sentence, whatever happened. See note 2 above. */
const SENT = 'If that address belongs to an administrator, a reset link is on its way to it.';

/**
 * Where the link in the email should land.
 *
 * PUBLIC_APP_URL when it is set, because that is the origin this deployment
 * actually answers on. The request's own origin is the fallback so a developer
 * on localhost — and a preview deployment nobody set the variable on — still
 * gets a working link rather than one pointing at production.
 */
async function recoveryRedirectUrl() {
  const configured = config.publicAppUrl();
  if (configured) return `${configured}/login/admin/recover`;

  const headerList = await headers();
  const host = headerList.get('host');
  const protocol =
    headerList.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  return host ? `${protocol}://${host}/login/admin/recover` : null;
}

/**
 * Is this address an administrator we are willing to email a link to?
 *
 * Uses the service-role client because it has to read a row that belongs to
 * somebody who is not signed in. It reads `is_admin` and `is_suspended` from
 * public.users — the same column every admin_* function re-checks — rather than
 * inferring anything from the auth record.
 */
async function isRecoverableAdmin(email) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from('users')
    .select('id, is_admin, is_suspended')
    .ilike('email', email)
    .maybeSingle();

  if (error) {
    console.error('[auth] admin recovery lookup failed:', error.message);
    return false;
  }
  if (data?.is_admin && !data.is_suspended) return true;

  // public.users.email is NULL on administrators created before the column
  // existed, so fall back to the auth record — which is where an admin's
  // address has always lived — and re-check is_admin on the profile it names.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listError) {
    console.error('[auth] admin recovery auth lookup failed:', listError.message);
    return false;
  }

  const match = list?.users?.find((u) => (u.email ?? '').toLowerCase() === email);
  if (!match) return false;

  const { data: profile } = await admin
    .from('users')
    .select('is_admin, is_suspended')
    .eq('id', match.id)
    .maybeSingle();

  return Boolean(profile?.is_admin && !profile.is_suspended);
}

/** Step one: ask for a link. */
export async function requestAdminPasswordReset(_prevState, formData) {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: 'Enter the email address you sign in with.' };
  }

  if (!(await isRecoverableAdmin(email))) {
    // Nothing is sent, and the caller cannot tell. Logged so an administrator
    // who swears they asked for a link can be told what actually happened.
    console.warn(`[auth] password reset requested for a non-administrator address: ${email}`);
    return { sent: true, notice: SENT };
  }

  const redirectTo = await recoveryRedirectUrl();
  if (!redirectTo) {
    console.error('[auth] cannot build a recovery redirect: no PUBLIC_APP_URL and no host header');
    return { error: 'Password reset is unavailable right now.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  if (error) {
    console.error('[auth] resetPasswordForEmail failed:', error.message);
    if (error.status === 429) {
      return { error: 'Too many reset emails requested. Wait a moment and try again.' };
    }
    return { error: 'Could not send the reset email. Try again shortly.' };
  }

  return { sent: true, notice: SENT };
}

/**
 * Step two: set the new password, on the session the recovery link produced.
 *
 * The session is NOT trusted to say who this is. is_admin is read back from
 * public.users, and a session that does not belong to an administrator is
 * signed out without the password ever being set — so a recovery link issued
 * for some other kind of account cannot mint an admin credential.
 */
export async function setAdminPassword(_prevState, formData) {
  const password = String(formData.get('password') ?? '');
  const confirmation = String(formData.get('confirm_password') ?? '');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'That reset link has expired. Ask for a new one.', expired: true };
  }

  const { data: capabilities } = await supabase.rpc('my_capabilities');
  if (!capabilities?.is_admin || capabilities?.is_suspended) {
    await supabase.auth.signOut();
    return { error: 'That account does not have administrator access.', expired: true };
  }

  // The same bar scripts/reset-admin-password.mjs holds, for the same reason:
  // this account can cancel orders and move money.
  if (password.length < 12) {
    return { error: 'Use at least 12 characters.' };
  }
  if (password !== confirmation) {
    return { error: 'The two passwords did not match.' };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    console.error('[auth] admin password update failed:', error.message);
    // Supabase refuses a password it considers weak, or one identical to the
    // current one. Both are worth saying plainly to somebody who is locked out.
    return { error: error.message || 'That password was not accepted.' };
  }

  // SPENT. The recovery link proved control of the mailbox and bought exactly
  // one password change; it does not also buy a session in the console.
  await supabase.auth.signOut();

  redirect('/login/admin?reset=done');
}
