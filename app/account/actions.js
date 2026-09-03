'use server';

import { revalidatePath } from 'next/cache';
import { partnerSetAvailability } from '@/lib/orders/transitions';
import { setMyEmail } from '@/lib/customer';
import { actionFailure } from '@/lib/errors';

/**
 * The availability toggle. The database refuses this for anyone who is not an
 * APPROVED Partner, so the form is a convenience — not the check.
 */
export async function setPartnerAvailability(formData) {
  await partnerSetAvailability(formData.get('available') === 'true');
  revalidatePath('/account');
}

/**
 * Stores a REAL email address on the account.
 *
 * The payment provider's hosted checkout will not open without one, so this is
 * the calm place to give it — rather than being stopped at the pay button. The
 * database validates the shape and writes it against auth.uid(); nothing is
 * ever generated for someone who has not supplied one.
 */
export async function saveMyEmail(_prev, formData) {
  const email = String(formData.get('email') ?? '').trim();
  if (!email) return { ok: false, message: 'Enter your email address.' };

  try {
    await setMyEmail(email);
  } catch (error) {
    return actionFailure(error, 'account');
  }

  revalidatePath('/account');
  return { ok: true, message: 'Saved.' };
}
