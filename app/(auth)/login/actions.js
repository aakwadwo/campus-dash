'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { normaliseGhanaPhone } from '@/lib/sms';
import { landingFor, safeNext } from '@/lib/auth/landing';
import { normaliseSchoolEmail, SCHOOL_DOMAIN } from '@/lib/auth/school-email';
import { isOtpShape, emailOtpError, verifyOtpError } from '@/lib/auth/customer-signup';
import { config } from '@/lib/config';
// TEMPORARY — see lib/observability/otp-trace.js. Remove with the diagnosis.
import { otpTrace } from '@/lib/observability/otp-trace';

/**
 * Three sign-ins, three proofs, one identity table.
 *
 *   CUSTOMER  a code sent to a verified @acity.edu.gh address
 *   VENDOR    a code sent by SMS to the number that IS the store's credential
 *   ADMIN     an email address and a password
 *
 * They are separate because the PROOF is separate, not because the people are.
 * The same auth.users.id can hold all three capabilities, and which screen
 * somebody signed in through has no bearing on what they may then do — that is
 * derived from the database on every request by my_capabilities().
 *
 * Supabase Auth generates and validates every code. We never generate, store or
 * check one ourselves, which keeps the whole verification surface in one
 * audited place.
 */

// --- Customer: a code to a school address ------------------------------------

/**
 * @param {boolean} createUser whether a first-time address may make an account.
 *   FALSE on the sign-in screen: "we sent you a code" for an address that has
 *   never signed up would create a half-built account and teach the person to
 *   expect an email that then makes no sense. TRUE on the sign-up screen, which
 *   is where making an account is the point.
 */
async function sendEmailCode(email, createUser) {
  const supabase = await createClient();
  return supabase.auth.signInWithOtp({
    email,
    // NO emailRedirectTo. Supplying one turns the email into a magic link, and
    // Campus Dash asks for a code that is typed into the tab already open.
    options: { shouldCreateUser: createUser },
  });
}

/**
 * The error mapping is shared with sign-up, in
 * `lib/auth/customer-signup.js`, so somebody hitting the same wall on either
 * screen reads the same sentence. `allowSignup` is the one thing that differs:
 * here an unknown address means "you have not signed up yet", and saying so is
 * not a leak worth guarding — the domain is a single university, and the
 * alternative is a person waiting for an email that is never coming.
 */
export async function requestEmailCode(_prevState, formData) {
  const email = normaliseSchoolEmail(formData.get('email'));
  if (!email) {
    return { step: 'email', error: `Use your Academic City address, ending ${SCHOOL_DOMAIN}.` };
  }

  const { error } = await sendEmailCode(email, false);
  if (error) {
    console.error('[auth] email signInWithOtp failed:', error.message);
    return {
      step: 'email',
      email,
      error: emailOtpError(error, { isProduction: config.isProduction() }),
    };
  }

  return {
    step: 'code',
    email,
    sentAt: Date.now(),
    notice: `We sent a 6-digit code to ${email}.`,
  };
}

/**
 * A second code, on request.
 *
 * Issuing one INVALIDATES the first — Supabase's behaviour, not ours — which is
 * why the form puts a cooldown in front of the button. Supabase's own rate
 * limit is the real defence, and its 429 is surfaced rather than swallowed.
 */
export async function resendEmailCode(_prevState, formData) {
  const email = normaliseSchoolEmail(formData.get('email'));
  if (!email) return { step: 'email', error: 'Start again with your school email address.' };

  const { error } = await sendEmailCode(email, false);
  if (error) {
    console.error('[auth] email resend failed:', error.message);
    return {
      step: 'code',
      email,
      error: emailOtpError(error, { isProduction: config.isProduction() }),
    };
  }

  return {
    step: 'code',
    email,
    sentAt: Date.now(),
    notice: `A new code is on its way to ${email}. The previous one no longer works.`,
  };
}

export async function verifyEmailCode(_prevState, formData) {
  const email = normaliseSchoolEmail(formData.get('email'));
  const token = String(formData.get('token') ?? '').trim();
  const requested = safeNext(formData.get('next'));

  if (!email) return { step: 'email', error: 'Start again with your school email address.' };
  if (!isOtpShape(token)) {
    return { step: 'code', email, error: 'Enter the code from the email.' };
  }

  const supabase = await createClient();
  // 'email' covers both templates: the Confirm Signup code a first-time address
  // gets and the Magic Link code every later sign-in gets. Supabase generates
  // and checks it; nothing here does.
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });

  if (error) {
    console.error('[auth] email verifyOtp failed:', error.message);
    // One message for a wrong code and an expired one. Telling them apart would
    // say whether a guessed code was ever issued.
    return { step: 'code', email, error: verifyOtpError() };
  }

  const { data: capabilities } = await supabase.rpc('my_capabilities');
  redirect(requested ?? landingFor(capabilities));
}

// --- Vendor: a code to the store's phone -------------------------------------

export async function requestOtp(_prevState, formData) {
  const phone = normaliseGhanaPhone(formData.get('phone'));
  if (!phone) {
    return { step: 'phone', error: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
  }

  const trace = otpTrace('action', phone);
  trace('requestOtp.start');

  const supabase = await createClient();
  trace('client.ready');

  const { error } = await supabase.auth.signInWithOtp({ phone });
  trace('signInWithOtp.done', { ok: !error, status: error?.status ?? 200, code: error?.code });

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
          : 'Phone sign-in is disabled on this Supabase project. Enable the Phone provider and the Send SMS Hook. See docs/HOSTED-SUPABASE.md.',
      };
    }

    return {
      step: 'phone',
      phone,
      error: 'Could not send a verification code. Try again shortly.',
    };
  }

  trace('requestOtp.return', { step: 'code' });
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

  // Same tag as the request leg, so the two lines pair up in the log and the
  // gap between them is the ANSWER to "was it expiry?" — how long the customer
  // actually took, measured rather than assumed.
  const trace = otpTrace('action', phone);
  trace('verifyOtp.start', { tokenLen: token.length });

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });
  trace('verifyOtp.done', { ok: !error, status: error?.status ?? 200, code: error?.code });

  if (error) {
    console.error('[auth] verifyOtp failed:', error.message);
    // One message for a wrong code and an expired one. Telling them apart would
    // say whether a guessed code was ever issued.
    return { step: 'code', phone, error: 'That code is not valid or has expired.' };
  }

  // Where they go next is DERIVED from capabilities the database recomputes on
  // this request — never from anything the browser claimed. A deep link that
  // sent them here wins, because they were already going somewhere specific.
  const { data: capabilities } = await supabase.rpc('my_capabilities');
  redirect(requested ?? landingFor(capabilities));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/');
}

/**
 * Administrator sign-in — email and password.
 *
 * Everyone else gets a code. Administrators do not, for a practical reason and
 * a safety one: operational access must not depend on a message arriving, and
 * the person who has to intervene at 11pm when an order is stuck should not be
 * locked out by a delivery failure in the very channel they are trying to fix.
 *
 * AN ADMINISTRATOR HAS NO PHONE NUMBER. Not "does not use it to sign in" —
 * users.phone is NULL on the row, and nothing in the console needs one.
 *
 * There is no admin registration path and no password reset flow here. The
 * first administrator is created out-of-band with scripts/create-admin.mjs;
 * `is_admin` is a database column that no client statement can reach, because
 * users hold no UPDATE grant on public.users. /admin is not linked from any
 * public page, which is not a security control — the checks below and in every
 * admin_* function are — but there is no reason to advertise the door.
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

  redirect('/admin');
}
