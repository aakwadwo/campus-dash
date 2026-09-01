'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { normaliseGhanaPhone } from '@/lib/sms';
import { landingFor, safeNext } from '@/lib/auth/landing';
import { config } from '@/lib/config';

/**
 * Phone OTP sign-in.
 *
 * Supabase Auth generates and validates the code; our Send SMS Hook delivers it
 * through the SmsProvider abstraction. We never generate, store or check an OTP
 * ourselves, which keeps the whole verification surface in one audited place.
 */

export async function requestOtp(_prevState, formData) {
  const phone = normaliseGhanaPhone(formData.get('phone'));
  if (!phone) {
    return { step: 'phone', error: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ phone });

  if (error) {
    console.error(
      `[auth] signInWithOtp failed (${error.code ?? error.status ?? 'unknown'}):`,
      error.message
    );

    if (error.status === 429) {
      // Supabase's own rate limits are the defence here; surface them plainly.
      return {
        step: 'phone',
        phone,
        error: 'Too many codes requested. Wait a moment and try again.',
      };
    }

    // A misconfigured project and a transient hiccup are completely different
    // problems, and "try again shortly" sent us looking in the wrong place for
    // an afternoon. Phone sign-in being switched off on the project is not a
    // secret and not something waiting fixes, so say so — in development, where
    // the person reading it is the one who can go and turn it on.
    if (error.code === 'phone_provider_disabled' || /phone provider/i.test(error.message)) {
      return {
        step: 'phone',
        phone,
        error: config.isProduction()
          ? 'Sign-in by phone is unavailable right now.'
          : 'Phone sign-in is disabled on this Supabase project. Enable the Phone provider and the Send SMS Hook — see docs/HOSTED-SUPABASE.md.',
      };
    }

    return {
      step: 'phone',
      phone,
      error: 'Could not send a verification code. Try again shortly.',
    };
  }

  return { step: 'code', phone, notice: `We sent a 6-digit code to ${phone}.` };
}

export async function verifyOtp(_prevState, formData) {
  const phone = normaliseGhanaPhone(formData.get('phone'));
  const token = String(formData.get('token') ?? '').trim();
  const requested = safeNext(formData.get('next'));

  if (!phone) return { step: 'phone', error: 'Start again with your phone number.' };
  if (!/^\d{4,8}$/.test(token)) {
    return { step: 'code', phone, error: 'Enter the code from the SMS.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });

  if (error) {
    console.error('[auth] verifyOtp failed:', error.message);
    // One message for a wrong code and an expired one. Telling them apart would
    // say whether a guessed code was ever issued.
    return { step: 'code', phone, error: 'That code is not valid or has expired.' };
  }

  // One sign-in form, four kinds of person. Where they go next is DERIVED from
  // capabilities the database recomputes on this request — never from anything
  // the browser claimed. A deep link that sent them here wins, because they were
  // already going somewhere specific.
  const { data: capabilities } = await supabase.rpc('my_capabilities');
  redirect(requested ?? landingFor(capabilities));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/**
 * Administrator sign-in — email and password.
 *
 * Everyone else signs in by phone. Administrators do not, for a practical
 * reason and a safety one: operational access must not depend on an SMS
 * arriving, and the person who has to intervene at 11pm when an order is stuck
 * should not be locked out by a delivery failure in the very channel they are
 * trying to fix.
 *
 * There is no admin registration path and no password reset flow here. The
 * first administrator is created out-of-band with scripts/create-admin.mjs;
 * `is_admin` is a database column that no client statement can reach, because
 * users hold no UPDATE grant on public.users.
 */
export async function adminSignIn(_prevState, formData) {
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email address and password.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error('[auth] admin signInWithPassword failed:', error.message);
    // One message for every failure. Distinguishing "no such account" from
    // "wrong password" would confirm which email addresses are administrators.
    return { error: 'Those credentials were not accepted.' };
  }

  // A session is not authority. The password proved who this is; the database
  // decides what they may do, and it is asked here rather than trusted from the
  // token — my_capabilities() re-derives is_admin from public.users on every
  // call, and every admin function re-checks it again in its own body.
  const { data: capabilities } = await supabase.rpc('my_capabilities');

  if (!capabilities?.is_admin || capabilities?.is_suspended) {
    await supabase.auth.signOut();
    return { error: 'That account does not have administrator access.' };
  }

  redirect(landingFor(capabilities));
}
