'use server';

import { revalidatePath } from 'next/cache';
import { acceptTerms } from '@/lib/terms';

export async function acceptTermsAction(_prev, formData) {
  try {
    await acceptTerms(String(formData.get('terms_id') ?? ''));
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  revalidatePath('/terms');
  revalidatePath('/account');
  return { ok: true, message: 'Recorded. Thank you.' };
}
