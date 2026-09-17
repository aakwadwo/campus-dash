'use server';

import { revalidatePath } from 'next/cache';
import { acceptTerms } from '@/lib/terms';
import { actionFailure } from '@/lib/errors';

/**
 * Records one acceptance.
 *
 * THE FAILURE GOES THROUGH actionFailure() rather than to the screen verbatim.
 * What accept_terms() raises is written for a log — "those terms are not
 * available to accept" — and anything it did not raise, a PostgREST error most
 * of all, is unvetted text this form has no business rendering.
 */
export async function acceptTermsAction(_prev, formData) {
  try {
    await acceptTerms(String(formData.get('terms_id') ?? ''));
  } catch (error) {
    return actionFailure(error, 'terms acceptance');
  }
  revalidatePath('/terms');
  revalidatePath('/account');
  return { ok: true, message: 'Recorded. Thank you.' };
}
