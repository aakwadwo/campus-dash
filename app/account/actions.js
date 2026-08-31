'use server';

import { revalidatePath } from 'next/cache';
import { partnerSetAvailability } from '@/lib/orders/transitions';

/**
 * The availability toggle. The database refuses this for anyone who is not an
 * APPROVED Partner, so the form is a convenience — not the check.
 */
export async function setPartnerAvailability(formData) {
  await partnerSetAvailability(formData.get('available') === 'true');
  revalidatePath('/account');
}
