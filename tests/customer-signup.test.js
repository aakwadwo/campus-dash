import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS,
  RESEND_COOLDOWN_SECONDS,
  SCHOOL_DOMAIN,
  isOtpShape,
  emailOtpError,
  verifyOtpError,
  validateSignUpDetails,
} from '../lib/auth/customer-signup.js';
import { normaliseSchoolEmail } from '../lib/auth/school-email.js';

/**
 * The customer sign-up decisions, tested as the decisions they are.
 *
 * NO SUPABASE, NO SESSION, NO NETWORK. These functions were pulled out of the
 * `'use server'` action file precisely so they could be reached without one —
 * a server action can only be exercised through a request, and the interesting
 * part of sign-up is not the request, it is which of a dozen inputs is refused
 * and what the person is told about it.
 *
 * NONE OF THIS IS THE ENFORCEMENT, and the tests say so where it matters.
 * complete_customer_onboarding() applies every rule again in SQL, against
 * auth.uid(), and the uniqueness constraints are indexes. This layer exists to
 * give somebody a sentence before a round trip.
 */
describe('customer sign-up decisions', () => {
  const VALID = {
    firstName: 'Kwame',
    lastName: 'Mensah',
    email: 'kwame.mensah@acity.edu.gh',
    level: '200',
    phoneRaw: '020 123 4567',
    accepted: true,
  };

  // =========================================================================
  // The school address
  // =========================================================================

  test('a school address is accepted and normalised', () => {
    const result = validateSignUpDetails({ ...VALID, email: '  Kwame.Mensah@ACITY.edu.GH ' });
    assert.equal(result.ok, true);
    assert.equal(result.email, 'kwame.mensah@acity.edu.gh', 'lower-cased and trimmed');
  });

  test('the domain is matched at the END, so a lookalike is refused', () => {
    // The attack this exists for: `@acity.edu.gh` appears in the string, and a
    // naive `includes` would pass it straight through.
    for (const email of [
      'someone@acity.edu.gh.evil.example',
      'someone@notacity.edu.gh.co',
      'someone@acity.edu.gh.uk',
    ]) {
      const result = validateSignUpDetails({ ...VALID, email });
      assert.equal(result.ok, false, `${email} must be refused`);
      assert.match(result.error, /Academic City address/);
    }
  });

  test('a non-school address is refused', () => {
    for (const email of ['kwame@gmail.com', 'kwame@acity.edu', 'kwame@example.com', '']) {
      assert.equal(validateSignUpDetails({ ...VALID, email }).ok, false, email || '(blank)');
    }
  });

  test('an address with no local part, or a second @, is refused', () => {
    for (const email of ['@acity.edu.gh', 'a@b@acity.edu.gh', ' @acity.edu.gh']) {
      assert.equal(normaliseSchoolEmail(email), null, email);
    }
  });

  test('the domain constant is the one the database anchors on', () => {
    assert.equal(SCHOOL_DOMAIN, '@acity.edu.gh');
  });

  // =========================================================================
  // The other fields
  // =========================================================================

  test('a first name and a last name are both required', () => {
    assert.match(validateSignUpDetails({ ...VALID, firstName: '  ' }).error, /first name/i);
    assert.match(validateSignUpDetails({ ...VALID, lastName: '' }).error, /last name/i);
  });

  test('names are trimmed, so a stray space is not part of somebody’s name', () => {
    const result = validateSignUpDetails({ ...VALID, firstName: '  Kwame ', lastName: ' Mensah ' });
    assert.equal(result.firstName, 'Kwame');
    assert.equal(result.lastName, 'Mensah');
  });

  test('no student ID number is asked for, and supplying one changes nothing', () => {
    // The verified @acity.edu.gh address is the school's own record of who this
    // is. A number typed into a box was a second copy nobody checked against
    // anything, so the field is gone — and a form that still sent one is
    // accepted and ignored rather than refused.
    assert.equal(validateSignUpDetails(VALID).ok, true);
    assert.equal(validateSignUpDetails({ ...VALID, studentIdNumber: '   ' }).ok, true);
    assert.ok(!('studentIdNumber' in validateSignUpDetails(VALID)));
  });

  test('the level must be one of the four, and nothing else', () => {
    for (const level of LEVELS) {
      assert.equal(validateSignUpDetails({ ...VALID, level }).ok, true, level);
    }
    for (const level of ['', '500', '150', 'Class of 2029', 'one hundred', '1oo']) {
      const result = validateSignUpDetails({ ...VALID, level });
      assert.equal(result.ok, false, `${level} must be refused`);
      assert.match(result.error, /level/i);
    }

    // Surrounding space is trimmed rather than refused, which is what the
    // database does too — btrim() before the IN check in
    // complete_customer_onboarding(). Somebody who pasted a value with a
    // trailing space has not made a mistake worth stopping for.
    const padded = validateSignUpDetails({ ...VALID, level: ' 300 ' });
    assert.equal(padded.ok, true);
    assert.equal(padded.level, '300');
  });

  test('the four levels are exactly 100, 200, 300 and 400', () => {
    assert.deepEqual(LEVELS, ['100', '200', '300', '400']);
  });

  test('a Ghanaian phone number is required, and is normalised to E.164', () => {
    for (const phoneRaw of ['020 123 4567', '0201234567', '+233201234567', '233201234567']) {
      const result = validateSignUpDetails({ ...VALID, phoneRaw });
      assert.equal(result.ok, true, phoneRaw);
      assert.equal(result.phone, '+233201234567', `${phoneRaw} normalises`);
    }

    for (const phoneRaw of ['', '12345', 'not a phone', '+1 555 0100']) {
      assert.equal(validateSignUpDetails({ ...VALID, phoneRaw }).ok, false, phoneRaw || '(blank)');
    }
  });

  test('the terms must be accepted', () => {
    const result = validateSignUpDetails({ ...VALID, accepted: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /terms/i);
  });

  test('the first failure is the one reported, in the order the form reads', () => {
    // Everything wrong at once. Somebody is told about the field at the top of
    // the form, not the last one the validator happened to look at.
    const result = validateSignUpDetails({
      firstName: '',
      lastName: '',
      email: 'nope',
      level: '',
      phoneRaw: '',
      accepted: false,
    });
    assert.match(result.error, /first name/i);
  });

  test('no student ID image is asked for anywhere', () => {
    const result = validateSignUpDetails(VALID);
    assert.equal(result.ok, true);
    assert.ok(!('studentIdImagePath' in result), 'signing up to order lunch needs no upload');
  });

  // =========================================================================
  // The code
  // =========================================================================

  test('a code is SIX digits, and nothing else is', () => {
    // Six is the one length Campus Dash issues — `otp_length = 6` for both the
    // email and the SMS flow. This used to tolerate four to eight "in case the
    // project setting changed", which is how a hosted project quietly set to
    // eight went unnoticed: the codes were wrong and the check said nothing.
    // Matching the one length we issue turns that into an immediate failure.
    for (const token of ['123456', ' 123456 ']) {
      assert.equal(isOtpShape(token), true, token);
    }
    for (const token of [
      '',
      '123',
      '1234',
      '12345',
      '1234567',
      '12345678',
      '123456789',
      'abcdef',
      '12 34 56',
      '12345a',
      null,
      undefined,
    ]) {
      assert.equal(isOtpShape(token), false, String(token));
    }
  });

  test('a wrong code and an expired one read identically', () => {
    // Telling them apart would confirm whether a guessed code was ever issued,
    // which is the only thing somebody typing codes into that box is learning.
    const message = verifyOtpError();
    assert.match(message, /not valid or has expired/i);
    assert.ok(!/expired only|wrong code|never issued/i.test(message));
  });

  test('the resend cooldown is long enough to be useful and short enough to be kind', () => {
    assert.ok(RESEND_COOLDOWN_SECONDS >= 30, 'a new code kills the one being typed');
    assert.ok(RESEND_COOLDOWN_SECONDS <= 120, 'a lost email must not be a wall');
  });

  // =========================================================================
  // What a failed send says
  // =========================================================================

  test('a rate limit is reported as one, not as a mystery', () => {
    assert.match(emailOtpError({ status: 429 }), /too many codes/i);
    assert.match(emailOtpError({ message: 'Email rate limit exceeded' }), /too many codes/i);
  });

  test('an unknown address is only called unknown on the sign-IN screen', () => {
    const error = { code: 'otp_disabled', message: 'Signups not allowed for otp' };

    // Sign-in: saying so is the useful answer. The domain is one university,
    // and the alternative is somebody waiting for an email that is not coming.
    assert.match(emailOtpError(error, { allowSignup: false }), /Sign up first/i);

    // Sign-up: the same refusal cannot mean that, because creating the account
    // is the whole point of the screen.
    assert.ok(!/sign up first/i.test(emailOtpError(error, { allowSignup: true })));
  });

  test('a disabled email provider is named in development and hidden in production', () => {
    const error = { code: 'email_provider_disabled', message: 'Email provider disabled' };
    assert.match(emailOtpError(error, { isProduction: false }), /docs\/AUTH\.md/);
    assert.match(emailOtpError(error, { isProduction: true }), /unavailable right now/i);
    assert.ok(
      !/supabase/i.test(emailOtpError(error, { isProduction: true })),
      'a customer is never shown our infrastructure'
    );
  });

  test('an unrecognised failure says something a person can act on', () => {
    const message = emailOtpError({ message: 'kaboom 500 internal' });
    assert.match(message, /try again/i);
    assert.ok(!/kaboom|500|internal/i.test(message), 'and never echoes the raw error');
  });
});
