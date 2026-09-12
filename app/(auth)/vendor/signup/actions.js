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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
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

  if (!d.applicantName) return fail('Enter your name.');
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

  if (holder.id) {
    const me = await currentUserId();

    if (me === holder.id) {
      // ALREADY SIGNED IN AS THE PERSON WHO OWNS THIS NUMBER, so there is
      // nothing left to prove: the session is the proof, and the number is
      // already on their profile. vendor_signup() reads the phone from that
      // profile row, so the store attaches to the identity they already have —
      // no second account, no second credential, customer data untouched.
      try {
        const { data: terms } = await (
          await createClient()
        ).rpc('current_terms', {
          p_audience: 'VENDOR',
        });
        const termsId = (Array.isArray(terms) ? terms[0] : terms)?.terms_id;

        await signUp({
          applicantName: d.applicantName,
          storeName: d.storeName,
          isStudent: d.isStudent === 'yes',
          description: d.description,
          categoryId: d.categoryId,
          termsId,
        });
      } catch (error) {
        return fail(actionFailure(error, CONTEXT).message);
      }

      revalidatePath('/', 'layout');
      redirect('/vendor/application');
    }

    // Somebody else's number, or nobody is signed in. NOT refused outright —
    // it is very probably their own account — but the way in is the credential
    // that account already has, not a second one minted here. Sending an OTP
    // would create the duplicate identity; attaching this number to their auth
    // record so an OTP could reach them would be worse, because a profile phone
    // is self-declared and unverified, and whoever holds the handset would then
    // be able to sign in as them.
    return fail(
      'That number is already on a Campus Dash account. Sign in with it first, then register ' +
        'your store from your account — it keeps everything on one login.'
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
    ...carry(d),
    phone,
    // Starts the resend cooldown. The code screen counts down from this.
    sentAt: Date.now(),
    notice: `We sent a 6-digit code to ${phone}.`,
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
  const { error } = await supabase.auth.signInWithOtp({ phone });

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
  const { error: verifyError } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });

  if (verifyError) {
    console.error(
      `[vendor-signup] verifyOtp failed (${verifyError.status ?? 'no status'}):`,
      verifyError.message
    );
    return fail(verifyFailure(verifyError));
  }

  try {
    const { data: terms } = await supabase.rpc('current_terms', { p_audience: 'VENDOR' });
    const termsId = (Array.isArray(terms) ? terms[0] : terms)?.terms_id;

    await signUp({
      applicantName: d.applicantName,
      storeName: d.storeName,
      isStudent: d.isStudent === 'yes',
      description: d.description,
      categoryId: d.categoryId,
      termsId,
    });
  } catch (error) {
    const failure = actionFailure(error, CONTEXT);
    return at({ step: 'code', ...carry(d), phone, error: failure.message });
  }

  revalidatePath('/', 'layout');
  redirect('/vendor/application');
}
