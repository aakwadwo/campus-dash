'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { normaliseGhanaPhone } from '@/lib/sms';
import { actionFailure } from '@/lib/errors';
import { signUp } from '@/lib/vendor';

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
    accepted: formData.get('accept_terms') === 'on',
  };
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

export async function startVendorSignUpAction(_prev, formData) {
  const d = collect(formData);
  const fail = (error) => ({ step: 'details', ...carry(d), error });

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

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({ phone });

  if (error) {
    console.error('[vendor-signup] could not send the code:', error.message);
    if (error.status === 429) return fail('Too many codes requested. Wait a moment and try again.');
    return fail('Could not send a verification code. Try again shortly.');
  }

  return { step: 'code', ...carry(d), phone, notice: `We sent a 6-digit code to ${phone}.` };
}

export async function finishVendorSignUpAction(_prev, formData) {
  const d = collect(formData);
  const token = String(formData.get('token') ?? '').trim();
  const phone = normaliseGhanaPhone(d.phoneRaw);

  const fail = (error) => ({ step: 'code', ...carry(d), phone, error });

  if (!phone) return { step: 'details', ...carry(d), error: 'Start again with your details.' };
  if (!/^\d{4,8}$/.test(token)) return fail('Enter the code from the SMS.');

  const supabase = await createClient();
  const { error: verifyError } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });

  if (verifyError) {
    console.error('[vendor-signup] verifyOtp failed:', verifyError.message);
    return fail('That code is not valid or has expired.');
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
    return { step: 'code', ...carry(d), phone, error: failure.message };
  }

  revalidatePath('/', 'layout');
  redirect('/vendor/application');
}
