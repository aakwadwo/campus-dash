'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { normaliseGhanaPhone } from '@/lib/sms';

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
    console.error('[auth] signInWithOtp failed:', error.message);
    // Supabase's own rate limits are the defence here; surface them plainly.
    return {
      step: 'phone',
      phone,
      error:
        error.status === 429
          ? 'Too many codes requested. Wait a moment and try again.'
          : 'Could not send a verification code. Try again shortly.',
    };
  }

  return { step: 'code', phone, notice: `We sent a 6-digit code to ${phone}.` };
}

export async function verifyOtp(_prevState, formData) {
  const phone = normaliseGhanaPhone(formData.get('phone'));
  const token = String(formData.get('token') ?? '').trim();
  const next = String(formData.get('next') ?? '/account');

  if (!phone) return { step: 'phone', error: 'Start again with your phone number.' };
  if (!/^\d{4,8}$/.test(token)) {
    return { step: 'code', phone, error: 'Enter the code from the SMS.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' });

  if (error) {
    console.error('[auth] verifyOtp failed:', error.message);
    return { step: 'code', phone, error: 'That code is not valid or has expired.' };
  }

  // Only ever redirect within this application — never to a caller-supplied
  // absolute URL, which would make this an open redirect.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/account');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
