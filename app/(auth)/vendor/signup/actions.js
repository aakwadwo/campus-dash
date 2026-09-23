'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { normaliseGhanaPhone } from '@/lib/sms';
import { actionFailure } from '@/lib/errors';
import { signUp } from '@/lib/vendor';
import { createAdminClient } from '@/lib/supabase/admin';
import { isOtpShape } from '@/lib/auth/customer-signup';

const CONTEXT = 'vendor sign-up';

/**
 * Vendor registration.
 *
 * THE FORM IS THE FIRST SCREEN. Not the phone number, and not the code. Asking
 * a store owner to prove a phone number before telling them what they are
 * signing up for is asking for a commitment before the offer — so everything is
 * collected first, the number is verified second, and the store is created on
 * the session that verification just produced.
 *
 * NO EMAIL IS ASKED FOR, here or ever. The phone number IS the credential.
 *
 * The details ride the verification step in hidden fields and are spent the
 * moment the code checks out. On success the store is PENDING_APPROVAL: the
 * owner can sign in and see exactly that, and nothing operational.
 */

function collect(formData) {
  return {
    applicantName: String(formData.get('applicant_name') ?? '').trim(),
    storeName: String(formData.get('store_name') ?? '').trim(),
    isStudent: String(formData.get('is_student') ?? ''),
    description: String(formData.get('description') ?? '').trim(),
    categoryId: String(formData.get('category_id') ?? ''),
    phoneRaw: String(formData.get('phone') ?? '').trim(),
    // THE NUMBER THE CODE WENT TO, in E.164, carried back by the code screen.
    // Verification uses this rather than re-deriving it from what was typed, so
    // the number being verified is provably the number that was sent to.
    verifiedPhone: String(formData.get('verified_phone') ?? '').trim(),
    // WHICH KIND OF CODE IS IN FLIGHT. A number being moved onto this identity
    // is a 'phone_change'; a number already confirmed on it, or on no identity
    // at all, is an ordinary 'sms' sign-in code. Verification has to ask
    // Supabase the same question the request asked, and guessing it from
    // "is somebody signed in" was wrong for exactly one case — a vendor
    // re-proving the number their account already holds.
    otpType: formData.get('otp_type') === 'phone_change' ? 'phone_change' : 'sms',
    accepted: formData.get('accept_terms') === 'on',
  };
}

/**
 * Stamps a result with when it was produced.
 *
 * useActionState keeps one state per action and gives no ordering between them,
 * so a screen reading three of them cannot tell which round trip happened last.
 * A fixed precedence is not a substitute: it either buries a fresh verification
 * error under a stale "a new code is on its way", or buries a fresh resend
 * notice under a stale error. Both were wrong for somebody. The timestamp makes
 * "newest wins" a fact rather than a guess.
 */
function at(state) {
  return { ...state, at: Date.now() };
}

/**
 * Who, if anyone, already holds this number.
 *
 * ONE PERSON, ONE IDENTITY, ONE PHONE. `users_phone_key` says a number backs a
 * single identity, and that is the model — capabilities stack on one
 * auth.users.id rather than each getting an account of its own.
 *
 * A customer signs in by EMAIL and gives their phone as a profile field, so
 * public.users.phone holds it while auth.users.phone is NULL. Asking Supabase
 * for a phone OTP therefore found no identity and made a SECOND one, and
 * confirming it collided with the customer's row — the production 500.
 *
 * The service-role client is required because this reads a row belonging to
 * somebody who is not signed in. It returns an id and nothing else: no name, no
 * email, nothing that would turn this into a way to enumerate who banks where.
 */
async function identityHoldingPhone(phone) {
  const admin = createAdminClient();
  const { data, error } = await admin.from('users').select('id').eq('phone', phone).maybeSingle();

  if (error) {
    console.error('[vendor-signup] could not check the phone number:', error.message);
    // Unknown is not "free". Treating a failed lookup as "nobody has it" is how
    // the second identity got created in the first place.
    return { unknown: true, id: null };
  }
  return { unknown: false, id: data?.id ?? null };
}

/** The signed-in account, or null. Never trusted for authority — only identity. */
async function currentUserId() {
  return (await signedInAccount())?.id ?? null;
}

/**
 * Who is signed in, and what their account already knows.
 *
 * A CUSTOMER OPENING A STORE IS THE SAME PERSON, so their name comes from their
 * profile and their phone is the one they already gave us. `verifiedPhone` is
 * the number GoTrue has confirmed on this auth identity, in E.164, or null: an
 * email customer's profile phone is self-declared and has never been proven,
 * which is why it cannot yet be a sign-in credential.
 */
async function signedInAccount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('users')
    .select('full_name, phone')
    .eq('id', user.id)
    .maybeSingle();

  const authPhone = user.phone ? `+${String(user.phone).replace(/^\+/, '')}` : null;
  return {
    id: user.id,
    name: profile?.full_name ?? null,
    profilePhone: profile?.phone ?? null,
    verifiedPhone: user.phone_confirmed_at ? authPhone : null,
  };
}

/** The store is created on the session that exists. The one place that calls vendor_signup(). */
async function createStore(d, applicantName) {
  const supabase = await createClient();
  const { data: terms } = await supabase.rpc('current_terms', { p_audience: 'VENDOR' });
  const termsId = (Array.isArray(terms) ? terms[0] : terms)?.terms_id;

  await signUp({
    applicantName,
    storeName: d.storeName,
    isStudent: d.isStudent === 'yes',
    description: d.description,
    categoryId: d.categoryId,
    termsId,
  });
}

/** The number that received the code: the carried one, else the typed one. */
function phoneFor(d) {
  return normaliseGhanaPhone(d.verifiedPhone) ?? normaliseGhanaPhone(d.phoneRaw);
}

function carry(d) {
  return {
    applicantName: d.applicantName,
    storeName: d.storeName,
    isStudent: d.isStudent,
    description: d.description,
    categoryId: d.categoryId,
    phoneRaw: d.phoneRaw,
    otpType: d.otpType,
  };
}

/**
 * Why a code was refused — and NOT always "it expired".
 *
 * Telling somebody their freshly-read code expired when the real problem was a
 * network blip sends them to request another one, which invalidates the code
 * they are holding and makes the next attempt fail too. A wrong code and an
 * expired one stay deliberately indistinguishable (saying which would confirm
 * whether a guessed code was ever issued); everything else is reported for what
 * it is.
 */
function verifyFailure(error) {
  const status = error?.status ?? null;

  if (status === 429) {
    return 'Too many attempts. Wait a moment before trying again.';
  }
  // No status, or a server-side one: the code was never judged, so it is very
  // probably still good. Saying "expired" here would be a lie that costs them
  // the code they are holding.
  if (status === null || status >= 500) {
    return 'We could not reach the verification service. Your code is still valid — try again.';
  }
  return 'That code is not valid or has expired. Ask for a new one below.';
}

export async function startVendorSignUpAction(_prev, formData) {
  const d = collect(formData);
  const fail = (error) => at({ step: 'details', ...carry(d), error });

  // SIGNED IN ALREADY? Then this is somebody adding a store to the account they
  // have, and their name is not asked again: it comes from their profile.
  const account = await signedInAccount();
  const applicantName = d.applicantName || account?.name || '';

  if (!applicantName) return fail('Enter your name.');
  if (!d.storeName) return fail('Enter your store name.');
  if (d.isStudent !== 'yes' && d.isStudent !== 'no') {
    return fail('Say whether you are a student.');
  }
  if (!d.description) return fail('Describe what your store sells.');
  if (!d.categoryId) return fail('Choose a business category.');

  const phone = normaliseGhanaPhone(d.phoneRaw);
  if (!phone) return fail('Enter a valid Ghanaian phone number, e.g. 020 123 4567.');

  if (!d.accepted) return fail('You must accept the vendor terms to continue.');

  // ---------------------------------------------------------------------
  // ONE IDENTITY PER NUMBER. Decided BEFORE any code is sent, because sending
  // one is what used to create the second identity.
  // ---------------------------------------------------------------------
  const holder = await identityHoldingPhone(phone);

  if (holder.unknown) {
    return fail('We could not check that number just now. Try again shortly.');
  }

  if (account) {
    if (holder.id && holder.id !== account.id) {
      return fail('That number is already on another Campus Dash account. Use a different one.');
    }

    // A CODE IS ALWAYS SENT. The number becomes how this store signs in, and
    // whichever number the applicant ends up on — the one their customer
    // profile already carried, or one they typed over it — it is proven on THIS
    // account before the store exists. A customer's profile phone was collected
    // at sign-up and never verified, so trusting it here would make an
    // unverified field into a credential.
    //
    // TWO REQUESTS, ONE SCREEN. Moving a number ONTO this identity is a phone
    // change; re-proving one the identity already holds is an ordinary sign-in
    // code, because GoTrue sends nothing for a "change" to the number it is
    // already on. Which one was asked for rides back with the code, so
    // verification cannot guess wrong.
    const reproving = account.verifiedPhone === phone;
    const otpType = reproving ? 'sms' : 'phone_change';

    const supabase = await createClient();
    const { error } = reproving
      ? // NEVER CREATES AN ACCOUNT: the number is confirmed on this very
        // identity, so there is one to find.
        await supabase.auth.signInWithOtp({ phone, options: { shouldCreateUser: false } })
      : await supabase.auth.updateUser({ phone });

    if (error) {
      console.error('[vendor-signup] could not send the code:', error.message);
      if (error.status === 429)
        return fail('Too many codes requested. Wait a moment and try again.');
      if (/already|exists|registered/i.test(error.message ?? '')) {
        return fail('That number is already on another Campus Dash account. Use a different one.');
      }
      return fail('Could not send a verification code. Try again shortly.');
    }

    return at({
      step: 'code',
      ...carry({ ...d, applicantName, otpType }),
      phone,
      sentAt: Date.now(),
    });
  }

  if (holder.id) {
    // Somebody else's number, or their own while signed out. The way in is
    // the credential that account already has, not a second one minted here.
    return fail(
      'That number is already on a Campus Dash account. Sign in first, then add your store ' +
        'from your account. It keeps everything on one login.'
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ phone });

  if (error) {
    console.error('[vendor-signup] could not send the code:', error.message);
    if (error.status === 429) return fail('Too many codes requested. Wait a moment and try again.');
    return fail('Could not send a verification code. Try again shortly.');
  }

  return at({
    step: 'code',
    ...carry({ ...d, otpType: 'sms' }),
    phone,
    // Starts the resend cooldown. The code screen counts down from this.
    sentAt: Date.now(),
  });
}

/**
 * Another code, on request.
 *
 * WHY THIS HAS TO EXIST. Without it the only way to get a second code was to
 * resubmit the whole details form — which issues a new OTP and INVALIDATES the
 * previous one. A vendor whose SMS was slow did exactly that, then typed
 * whichever of the two messages they read first, and was told a code they had
 * just received was expired. That is the intermittent failure this flow had;
 * it was never Supabase's expiry.
 *
 * Issuing one still invalidates the last, which is Supabase's behaviour and not
 * ours. The cooldown in front of the button is what stops somebody killing the
 * code they are halfway through typing; Supabase's own rate limit is the real
 * defence and its 429 is surfaced rather than swallowed.
 */
export async function resendVendorCodeAction(_prev, formData) {
  const d = collect(formData);
  const phone = phoneFor(d);

  if (!phone) {
    return at({ step: 'details', ...carry(d), error: 'Start again with your details.' });
  }

  const back = (extra) => at({ step: 'code', ...carry(d), phone, ...extra });

  const supabase = await createClient();
  // THE SAME REQUEST THE FIRST CODE CAME FROM, carried back rather than
  // re-derived from "is somebody signed in" — which was right for a customer
  // moving a new number onto their account and wrong for a vendor re-proving
  // the one they already had.
  const { error } =
    d.otpType === 'phone_change'
      ? await supabase.auth.resend({ type: 'phone_change', phone })
      : await supabase.auth.signInWithOtp({
          phone,
          options: { shouldCreateUser: !(await currentUserId()) },
        });

  if (error) {
    console.error('[vendor-signup] could not resend the code:', error.message);
    if (error.status === 429) {
      // The project's minimum interval between messages is stricter than our
      // cooldown. Say so plainly rather than pretending the send worked.
      return back({
        error: 'A code was just sent. Wait a little longer before asking for another.',
      });
    }
    return back({ error: 'Could not send a new code. Try again shortly.' });
  }

  return back({
    sentAt: Date.now(),
    notice: `A new code is on its way to ${phone}. The previous one no longer works.`,
  });
}

export async function finishVendorSignUpAction(_prev, formData) {
  const d = collect(formData);
  const token = String(formData.get('token') ?? '').trim();
  // THE NUMBER THAT RECEIVED THE CODE, not a fresh reading of the typed field.
  const phone = phoneFor(d);

  const fail = (error) => at({ step: 'code', ...carry(d), phone, error });

  if (!phone) return at({ step: 'details', ...carry(d), error: 'Start again with your details.' });
  // Six digits — `auth.sms.otp_length`, the same code length as every other
  // Campus Dash verification. Not to be confused with the FOUR-digit handoff
  // codes, which are ours and stay four.
  if (!isOtpShape(token)) return fail('Enter the 6-digit code from the SMS.');

  const supabase = await createClient();
  const account = await signedInAccount();

  // THE TYPE THE CODE WAS ASKED FOR, carried from the request. A signed-in
  // customer moving a new number onto their account confirms a phone change,
  // which writes it onto the identity they already have; everybody else — a
  // vendor re-proving the number their account already holds, or somebody with
  // no account at all — verifies an ordinary sign-in code.
  const { error: verifyError } = await supabase.auth.verifyOtp({
    phone,
    token,
    type: d.otpType,
  });

  if (verifyError) {
    console.error(
      `[vendor-signup] verifyOtp failed (${verifyError.status ?? 'no status'}):`,
      verifyError.message
    );
    return fail(verifyFailure(verifyError));
  }

  try {
    if (account) {
      // The number is proven on this identity now. Put it on the profile too,
      // so the number a Partner rings and the one the store signs in with are
      // one number. The database reads it from auth.users, not from here.
      const { error: syncError } = await supabase.rpc('sync_my_verified_phone');
      if (syncError) throw new Error(syncError.message);
    }
    await createStore(d, d.applicantName || account?.name || '');
  } catch (error) {
    const failure = actionFailure(error, CONTEXT);
    return at({ step: 'code', ...carry(d), phone, error: failure.message });
  }

  revalidatePath('/', 'layout');
  redirect('/vendor/application');
}
