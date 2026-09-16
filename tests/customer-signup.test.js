import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AFFILIATIONS,
  GENDERS,
  graduationYears,
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
  const THIS_YEAR = new Date().getFullYear();

  const VALID = {
    firstName: 'Kwame',
    lastName: 'Mensah',
    email: 'kwame.mensah@acity.edu.gh',
    affiliation: 'STUDENT',
    graduationYear: String(THIS_YEAR + 2),
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

  /**
   * A GRADUATION YEAR RATHER THAN A LEVEL, and the reason is the whole point:
   * `level` was wrong for three of the four years it described. Nobody comes
   * back in September to move themselves from 100 to 200, so an account created
   * in first year claimed to be a first year for ever. The year somebody
   * expects to finish is the same fact stated so that it stays true.
   */
  test('a student must choose a graduation year from the offered window', () => {
    for (const year of graduationYears()) {
      const result = validateSignUpDetails({ ...VALID, graduationYear: String(year) });
      assert.equal(result.ok, true, String(year));
      assert.equal(result.graduationYear, year, 'and it comes back as a number');
    }

    for (const year of ['', '1999', String(THIS_YEAR - 1), String(THIS_YEAR + 20), 'next year']) {
      const result = validateSignUpDetails({ ...VALID, graduationYear: year });
      assert.equal(result.ok, false, `${year} must be refused`);
      assert.match(result.error, /graduate/i);
    }
  });

  test('the window is computed, so it never needs editing in September', () => {
    const years = graduationYears(new Date('2031-03-01T00:00:00Z'));
    assert.equal(years[0], 2031, 'somebody finishing this academic year');
    assert.equal(years.at(-1), 2037, 'and a first year on a long programme');
    assert.ok(
      years.every((y, i) => i === 0 || y === years[i - 1] + 1),
      'contiguous'
    );
  });

  /**
   * STAFF EAT LUNCH, AND STAFF CAN BE PARTNERS. Asking them for a year group
   * was asking them to claim something untrue in order to buy a sandwich.
   */
  test('staff are not asked to graduate, and anything they send is discarded', () => {
    const result = validateSignUpDetails({
      ...VALID,
      affiliation: 'STAFF',
      graduationYear: '',
    });
    assert.equal(result.ok, true, 'no year is required of staff');
    assert.equal(result.graduationYear, null);

    // Even if a form sends one, it is not carried forward — the database has a
    // CHECK constraint saying staff have no graduation year.
    const sneaky = validateSignUpDetails({
      ...VALID,
      affiliation: 'STAFF',
      graduationYear: String(THIS_YEAR + 3),
    });
    assert.equal(sneaky.ok, true);
    assert.equal(sneaky.graduationYear, null);
  });

  test('the affiliation must be one of exactly two', () => {
    assert.deepEqual(AFFILIATIONS, ['STUDENT', 'STAFF']);

    for (const affiliation of ['', 'ALUMNI', 'student', 'Staff', 'VISITOR']) {
      const result = validateSignUpDetails({ ...VALID, affiliation });
      assert.equal(result.ok, false, `${affiliation} must be refused`);
      assert.match(result.error, /student or staff/i);
    }
  });

  /**
   * OPTIONAL, AND IT STAYS OPTIONAL. Nobody is stopped from buying lunch for
   * declining to say, which is why a blank is a pass rather than an error.
   */
  test('gender is exactly male or female, or nothing at all', () => {
    assert.deepEqual(GENDERS, ['MALE', 'FEMALE']);

    for (const gender of GENDERS) {
      const result = validateSignUpDetails({ ...VALID, gender });
      assert.equal(result.ok, true, gender);
      assert.equal(result.gender, gender);
    }

    const blank = validateSignUpDetails({ ...VALID, gender: '' });
    assert.equal(blank.ok, true, 'declining to say is not an error');
    assert.equal(blank.gender, null);

    const nonsense = validateSignUpDetails({ ...VALID, gender: 'OTHER' });
    assert.equal(nonsense.ok, false);
    assert.match(nonsense.error, /male or female/i);
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
