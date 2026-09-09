import { normaliseSchoolEmail, SCHOOL_DOMAIN } from './school-email.js';
import { normaliseGhanaPhone } from '../sms/index.js';

/**
 * The customer sign-up decisions, as plain functions.
 *
 * A separate module from `app/signup/actions.js` for the same reason
 * `school-email.js` is separate from the sign-in actions: a `'use server'` file
 * may export nothing but async functions, so a constant or a pure helper there
 * breaks the build. Keeping the decisions here also means they can be tested as
 * the decisions they are, without a Supabase client, a request or a session.
 *
 * NONE OF THIS IS THE ENFORCEMENT. Every rule below is applied again in
 * `complete_customer_onboarding()`, which validates the fields, anchors the
 * school domain, and writes against `auth.uid()`. This layer exists to give
 * somebody a useful sentence before a round trip — not to be the gate.
 */

export const LEVELS = ['100', '200', '300', '400'];

/**
 * How long before a customer may ask for another code.
 *
 * Long enough that the first email has usually arrived — a second code
 * invalidates the first, so somebody who resends too eagerly ends up typing a
 * dead code — and short enough that a genuinely lost email is not a wall.
 *
 * It is a COURTESY, not a rate limit. Supabase enforces the real one and
 * answers 429; this only stops the button being pressed into it.
 */
export const RESEND_COOLDOWN_SECONDS = 45;

/**
 * Supabase issues six digits (`auth.email.otp_length`). The range is wider than
 * that on purpose: the length is a project setting, and a form that hard-coded
 * six would silently reject every code the day somebody changed it.
 */
export function isOtpShape(token) {
  return /^\d{4,8}$/.test(String(token ?? '').trim());
}

/**
 * Validates everything the sign-up form collects.
 *
 * Returns the NORMALISED values on success — the lower-cased address and the
 * E.164 phone — so the caller passes on what was checked rather than what was
 * typed.
 */
export function validateSignUpDetails(details) {
  const firstName = String(details?.firstName ?? '').trim();
  const lastName = String(details?.lastName ?? '').trim();
  const studentIdNumber = String(details?.studentIdNumber ?? '').trim();
  const level = String(details?.level ?? '').trim();

  if (!firstName) return { ok: false, error: 'Enter your first name.' };
  if (!lastName) return { ok: false, error: 'Enter your last name.' };

  const email = normaliseSchoolEmail(details?.email);
  if (!email) {
    return { ok: false, error: `Use your Academic City address, ending ${SCHOOL_DOMAIN}.` };
  }

  if (!studentIdNumber) return { ok: false, error: 'Enter your student ID number.' };
  if (!LEVELS.includes(level)) return { ok: false, error: 'Choose your level.' };

  const phone = normaliseGhanaPhone(details?.phoneRaw);
  if (!phone) {
    return { ok: false, error: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
  }

  if (!details?.accepted) {
    return { ok: false, error: 'You must accept the customer terms to continue.' };
  }

  return { ok: true, firstName, lastName, email, studentIdNumber, level, phone };
}

/**
 * What a failed `signInWithOtp` should say.
 *
 * Shared by sign-up, sign-in and both resend paths, because a person hitting
 * the same wall on two screens should read the same sentence.
 *
 * `allowSignup` is the difference between the two screens, and it is the one
 * message worth distinguishing: on the sign-in screen an unknown address means
 * "you have not signed up", and saying so is not a leak worth guarding — the
 * domain is a single university, and the alternative is somebody waiting for an
 * email that is never coming.
 */
export function emailOtpError(error, { allowSignup = false, isProduction = false } = {}) {
  const message = String(error?.message ?? '');

  if (error?.status === 429 || /rate limit|too many/i.test(message)) {
    return 'Too many codes requested. Wait a minute and try again.';
  }

  if (
    !allowSignup &&
    (error?.code === 'otp_disabled' || /signups not allowed|user not found/i.test(message))
  ) {
    return 'No Campus Dash account uses that address yet. Sign up first.';
  }

  if (error?.code === 'email_provider_disabled' || /email provider/i.test(message)) {
    return isProduction
      ? 'Sign-in by email is unavailable right now.'
      : 'Email sign-in is disabled on this Supabase project. Enable the Email provider. See docs/AUTH.md.';
  }

  if (/invalid.*email|email.*invalid/i.test(message)) {
    return 'That address was not accepted. Check it and try again.';
  }

  return 'Could not send a verification code. Try again shortly.';
}

/**
 * What a failed `verifyOtp` should say.
 *
 * ONE MESSAGE FOR WRONG AND FOR EXPIRED. Telling them apart would confirm
 * whether a guessed code had ever been issued, which is the only thing an
 * attacker typing codes into this box is trying to learn. The person who
 * genuinely mistyped is told to check it or ask for another, which is the same
 * advice either way.
 */
export function verifyOtpError() {
  return 'That code is not valid or has expired. Check it, or send a new one.';
}

export { SCHOOL_DOMAIN };
