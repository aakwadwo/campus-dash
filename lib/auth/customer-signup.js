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

/**
 * Student or staff, and nothing else on this campus.
 *
 * STAFF ARE FULL CUSTOMERS AND MAY BECOME PARTNERS. This decides what sign-up
 * ASKS, never what the account may then do — capabilities are additive rows on
 * `auth.users.id`, and nothing here touches them.
 */
export const AFFILIATIONS = ['STUDENT', 'STAFF'];

/** Exactly these two, as specified. */
export const GENDERS = ['MALE', 'FEMALE'];

/**
 * The graduation years worth offering: 2027, 2028, 2029, 2030.
 *
 * A WINDOW, NOT A LIST OF LEVELS. `level` — 100/200/300/400 — was wrong for
 * three of the four years it described, because nobody goes back to change it
 * when they move up a year. A graduation year is the same fact stated so that
 * it stays true for as long as the person is here, which is the whole point.
 *
 * FOUR FIXED YEARS RATHER THAN A ROLLING WINDOW. This used to be computed from
 * the current date, which offered seven years and meant the pilot could not say
 * what a cohort was. Campus Dash runs on one campus with four undergraduate
 * cohorts in it, and these are their years; anything else is somebody choosing
 * a year nobody on campus finishes in. It is a PRODUCT DECISION and so it lives
 * here rather than in `pricing_config` — it is not a number an operator retunes
 * mid-pilot, it is the list the intake is defined by. When the intake moves,
 * this array and `complete_customer_onboarding()` move together.
 */
export const GRADUATION_YEARS = Object.freeze([2027, 2028, 2029, 2030]);

/**
 * The same four years, as an array a form can map over.
 *
 * Kept as a function because every caller already calls one, and because it is
 * the single place the list is read from — a screen that hard-codes four
 * `<option>` elements is a screen that drifts from what the database accepts.
 */
export function graduationYears() {
  return [...GRADUATION_YEARS];
}

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
 * SIX DIGITS, EXACTLY — `auth.email.otp_length`, and the matching Email OTP
 * Length on a hosted project.
 *
 * This used to accept four to eight "in case the project setting changed",
 * which sounds accommodating and was the opposite: a hosted project quietly set
 * to eight went unnoticed for as long as it took somebody to complain that the
 * code did not look like the six boxes they were being shown. A check that
 * matches the one length Campus Dash issues turns that into an immediate,
 * findable failure instead of a slow mystery.
 */
export function isOtpShape(token) {
  return /^\d{6}$/.test(String(token ?? '').trim());
}

/**
 * Validates everything the sign-up form collects.
 *
 * Returns the NORMALISED values on success — the lower-cased address and the
 * E.164 phone — so the caller passes on what was checked rather than what was
 * typed.
 *
 * THERE IS NO STUDENT ID NUMBER HERE any more. The verified @acity.edu.gh
 * address is the school's own record of who somebody is; a number typed into a
 * box was a second copy nobody checked against anything.
 */
export function validateSignUpDetails(details) {
  const firstName = String(details?.firstName ?? '').trim();
  const lastName = String(details?.lastName ?? '').trim();
  const affiliation = String(details?.affiliation ?? '').trim();
  const gender = String(details?.gender ?? '').trim();

  if (!firstName) return { ok: false, error: 'Enter your first name.' };
  if (!lastName) return { ok: false, error: 'Enter your last name.' };

  const email = normaliseSchoolEmail(details?.email);
  if (!email) {
    return { ok: false, error: `Use your Academic City address, ending ${SCHOOL_DOMAIN}.` };
  }

  if (!AFFILIATIONS.includes(affiliation)) {
    return { ok: false, error: 'Tell us whether you are a student or staff.' };
  }

  // A GRADUATION YEAR IS A STUDENT'S FACT. Staff do not graduate, so it is not
  // asked of them and anything they send is discarded rather than stored.
  let graduationYear = null;
  if (affiliation === 'STUDENT') {
    graduationYear = Number(String(details?.graduationYear ?? '').trim());
    if (!GRADUATION_YEARS.includes(graduationYear)) {
      return { ok: false, error: 'Choose the year you expect to graduate.' };
    }
  }

  // MALE OR FEMALE, AND ONE OF THEM IS ASKED FOR. It used to be optional, with
  // a third "prefer not to say" option that stored a null — which meant the
  // column could not be counted, which was the only reason for asking. There is
  // no third option on the form and there is none here.
  if (!GENDERS.includes(gender)) {
    return { ok: false, error: 'Choose male or female.' };
  }

  const phone = normaliseGhanaPhone(details?.phoneRaw);
  if (!phone) {
    return { ok: false, error: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
  }

  if (!details?.accepted) {
    return { ok: false, error: 'You must accept the customer terms to continue.' };
  }

  return {
    ok: true,
    firstName,
    lastName,
    email,
    affiliation,
    graduationYear,
    gender,
    phone,
  };
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
