'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { actionFailure } from '@/lib/errors';
import { completeOnboarding } from '@/lib/customer';
import { safeNext } from '@/lib/auth/landing';
import { config } from '@/lib/config';
import {
  validateSignUpDetails,
  isOtpShape,
  emailOtpError,
  verifyOtpError,
} from '@/lib/auth/customer-signup';

const CONTEXT = 'customer sign-up';

/**
 * Customer sign-up — the one action that grants the CUSTOMER capability.
 *
 * THREE STEPS, AND THE THIRD ONE IS THE INTERESTING ONE.
 *
 *   details   everything is collected first, because a verification code is a
 *             thing you ask for once somebody has decided to be here
 *   code      a six-digit code, typed into the tab that is already open. Never
 *             a link: a link opens in whichever browser the mail app picks,
 *             which on a phone is routinely not the one holding this form
 *   complete  ONLY reached when verification SUCCEEDED and onboarding did not.
 *             A phone number already on another account is the case that
 *             matters: the code has been spent and the session is real, so
 *             asking for another code would ask for one that cannot exist.
 *             This step keeps the session and lets them correct the field.
 *
 * The details ride the code step in hidden fields, so a mistyped code costs one
 * field rather than the whole form.
 *
 * NOTHING HERE GRANTS ANYTHING. Every field is handed to
 * complete_customer_onboarding(), which validates them, anchors the school
 * domain, reads the verified address out of auth.users rather than taking it as
 * a parameter, and records the terms acceptance in the same transaction. If
 * this action were bypassed entirely the capability still could not be
 * acquired: `authenticated` holds no write grant on customer_profiles.
 *
 * NO PHONE OTP, NO STUDENT ID PHOTOGRAPH AND NO STUDENT ID NUMBER. A verified
 * @acity.edu.gh address is the school's own record of who this is, which is the
 * proof; the phone is a profile fact, so a Partner can ring on arrival. A
 * number typed into a box and checked against nothing proved neither.
 */

function collect(formData) {
  return {
    firstName: String(formData.get('first_name') ?? '').trim(),
    lastName: String(formData.get('last_name') ?? '').trim(),
    email: String(formData.get('email') ?? '').trim(),
    level: String(formData.get('level') ?? '').trim(),
    phoneRaw: String(formData.get('phone') ?? '').trim(),
    accepted: formData.get('accept_terms') === 'on',
    next: safeNext(formData.get('next')) ?? '/order',
  };
}

/** Everything a later step has to carry, so a wrong code costs no retyping. */
function carry(details) {
  return {
    firstName: details.firstName,
    lastName: details.lastName,
    email: details.email,
    level: details.level,
    phoneRaw: details.phoneRaw,
  };
}

/** Asks Supabase to send the code. `shouldCreateUser` is what makes it sign-UP. */
async function sendCode(email) {
  const supabase = await createClient();
  return supabase.auth.signInWithOtp({
    email,
    // NO emailRedirectTo. Supplying one turns the email into a magic link, and
    // the whole point of this flow is a code that is typed into the tab that is
    // already open. See docs/AUTH.md.
    options: { shouldCreateUser: true },
  });
}

/**
 * Grants the capability, on a session that already exists.
 *
 * Split out because it is reached from two places: straight after a successful
 * verification, and again from the `complete` step when the first attempt hit a
 * uniqueness constraint. Both need the same transaction and the same terms
 * lookup; only the error handling differs.
 */
async function grantCustomer(details) {
  const supabase = await createClient();
  const { data: terms } = await supabase.rpc('current_terms', { p_audience: 'CUSTOMER' });
  const termsId = (Array.isArray(terms) ? terms[0] : terms)?.terms_id;

  const checked = validateSignUpDetails({ ...details, accepted: true });
  if (!checked.ok) throw new Error(checked.error);

  await completeOnboarding({
    firstName: checked.firstName,
    lastName: checked.lastName,
    level: checked.level,
    phone: checked.phone,
    termsId,
  });
}

// --- Step 1: details, then a code --------------------------------------------

export async function startSignUpAction(_prev, formData) {
  const details = collect(formData);
  const fail = (error) => ({ step: 'details', ...carry(details), error });

  const checked = validateSignUpDetails(details);
  if (!checked.ok) return fail(checked.error);

  const { error } = await sendCode(checked.email);
  if (error) {
    console.error('[signup] could not send the email code:', error.message);
    return fail(emailOtpError(error, { allowSignup: true, isProduction: config.isProduction() }));
  }

  return {
    step: 'code',
    ...carry(details),
    email: checked.email,
    sentAt: Date.now(),
    notice: `We sent a 6-digit code to ${checked.email}.`,
  };
}

// --- Step 1b: send it again ---------------------------------------------------

/**
 * A second code, on request.
 *
 * ISSUING ONE INVALIDATES THE FIRST — that is Supabase's behaviour, not ours —
 * so the form puts a cooldown in front of this button. The cooldown is a
 * courtesy that stops somebody typing a code that a resend has just killed;
 * Supabase's own rate limit is the actual defence, and its 429 is surfaced
 * plainly rather than swallowed.
 */
export async function resendSignUpCodeAction(_prev, formData) {
  const details = collect(formData);
  const checked = validateSignUpDetails({ ...details, accepted: true });

  if (!checked.ok) {
    return { step: 'details', ...carry(details), error: 'Start again with your details.' };
  }

  const { error } = await sendCode(checked.email);
  if (error) {
    console.error('[signup] could not resend the email code:', error.message);
    return {
      step: 'code',
      ...carry(details),
      email: checked.email,
      error: emailOtpError(error, { allowSignup: true, isProduction: config.isProduction() }),
    };
  }

  return {
    step: 'code',
    ...carry(details),
    email: checked.email,
    sentAt: Date.now(),
    notice: `A new code is on its way to ${checked.email}. The previous one no longer works.`,
  };
}

// --- Step 2: the code ---------------------------------------------------------

export async function finishSignUpAction(_prev, formData) {
  const details = collect(formData);
  const token = String(formData.get('token') ?? '').trim();
  const checked = validateSignUpDetails({ ...details, accepted: true });

  if (!checked.ok) {
    return { step: 'details', ...carry(details), error: 'Start again with your details.' };
  }

  const fail = (error) => ({ step: 'code', ...carry(details), email: checked.email, error });
  if (!isOtpShape(token)) return fail('Enter the code from the email.');

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({
    email: checked.email,
    token,
    // 'email' covers both templates: the Confirm Signup code a first-time
    // address gets, and the Magic Link code every later sign-in gets. Supabase
    // generates and checks it; nothing here does.
    type: 'email',
  });

  if (verifyError) {
    console.error('[signup] email verifyOtp failed:', verifyError.message);
    return fail(verifyOtpError());
  }

  // VERIFIED, AND THEREFORE SIGNED IN. From here the code is spent and the
  // session is real, so a failure below must never send them back to the code
  // step — that code cannot be entered twice.
  try {
    await grantCustomer(details);
  } catch (error) {
    const failure = actionFailure(error, CONTEXT);
    return {
      step: 'complete',
      ...carry(details),
      email: checked.email,
      error: failure.message,
    };
  }

  // 'layout' because the capability change alters what every layout renders —
  // the area switcher gains an Order entry the moment this succeeds.
  revalidatePath('/', 'layout');
  redirect(details.next);
}

// --- Step 3: finish, on the session that already exists -----------------------

/**
 * Completes an account whose address is verified but whose details were
 * refused — a student ID already registered, most often.
 *
 * There is no code here because there is nothing left to prove: the session
 * exists. It is guarded all the same, because a session is not a capability —
 * complete_customer_onboarding() writes against auth.uid() and would refuse an
 * unauthenticated caller outright.
 */
export async function completeSignUpAction(_prev, formData) {
  const details = collect(formData);
  const checked = validateSignUpDetails({ ...details, accepted: true });

  const fail = (error) => ({ step: 'complete', ...carry(details), email: details.email, error });
  if (!checked.ok) return fail(checked.error);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The session went away — a long pause, a sign-out in another tab. Send them
  // back to the beginning rather than failing against auth.uid() being null.
  if (!user) {
    return {
      step: 'details',
      ...carry(details),
      error: 'Your session expired. Start again and we will send a new code.',
    };
  }

  try {
    await grantCustomer(details);
  } catch (error) {
    const failure = actionFailure(error, CONTEXT);
    return fail(failure.message);
  }

  revalidatePath('/', 'layout');
  redirect(details.next);
}
