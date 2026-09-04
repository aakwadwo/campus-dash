'use server';

const CONTEXT = 'onboarding action';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { actionFailure } from '@/lib/errors';
import { completeOnboarding } from '@/lib/customer';
import { safeNext } from '@/lib/auth/landing';

/**
 * Student onboarding — the one action that grants the CUSTOMER capability.
 *
 * It grants nothing itself. Every field is handed to
 * complete_customer_onboarding(), which validates them, writes against
 * auth.uid() and records the terms acceptance in the same transaction. If this
 * action were bypassed entirely the capability still could not be acquired,
 * because `authenticated` holds no write grant on customer_profiles.
 */
export async function completeOnboardingAction(_prev, formData) {
  const next = safeNext(formData.get('next')) ?? '/order';

  try {
    await completeOnboarding({
      fullName: String(formData.get('full_name') ?? '').trim(),
      studentIdNumber: String(formData.get('student_id_number') ?? '').trim(),
      classYear: String(formData.get('class_year') ?? '').trim(),
      email: String(formData.get('email') ?? '').trim(),
      studentIdImagePath: String(formData.get('student_id_image_path') ?? '').trim(),
      termsId: String(formData.get('terms_id') ?? ''),
    });
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }

  // 'layout' because the capability change alters what every layout renders —
  // the area switcher gains an Order entry the moment this succeeds.
  revalidatePath('/', 'layout');
  redirect(next);
}
