'use server';

import { revalidatePath } from 'next/cache';
import { partnerSetAvailability } from '@/lib/orders/transitions';
import { setMyEmail } from '@/lib/customer';
import { createClient } from '@/lib/supabase/server';
import { actionFailure } from '@/lib/errors';
import { normaliseGhanaPhone } from '@/lib/sms';

/**
 * The availability toggle. The database refuses this for anyone who is not an
 * APPROVED Partner, so the form is a convenience — not the check.
 */
export async function setPartnerAvailability(formData) {
  await partnerSetAvailability(formData.get('available') === 'true');
  revalidatePath('/account', 'layout');
  revalidatePath('/partner', 'layout');
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

  revalidatePath('/account', 'layout');
  return { ok: true, message: 'Saved.' };
}

/**
 * The account holder's own name and phone number.
 *
 * A last name is optional and a first name is not, because the first name is
 * what the product actually uses — it is how a customer is told who is bringing
 * their order, and how a Partner is told who they are meeting.
 *
 * THE PHONE IS A PROFILE FIELD HERE, NOT A CREDENTIAL. It is the number a
 * Partner rings on arrival. For a vendor it IS the sign-in credential, and
 * update_my_profile() refuses to move it for that reason — a settings form that
 * could change a credential is an account takeover with a text input. The
 * refusal is in SQL; this only sends what was typed.
 */
export async function saveMyProfile(_prev, formData) {
  const firstName = String(formData.get('first_name') ?? '').trim();
  const lastName = String(formData.get('last_name') ?? '').trim();
  const phoneRaw = String(formData.get('phone') ?? '').trim();
  const affiliation = formData.get('affiliation') === 'STAFF' ? 'STAFF' : 'STUDENT';
  const gender = ['MALE', 'FEMALE'].includes(formData.get('gender'))
    ? formData.get('gender')
    : null;

  if (!firstName) return { ok: false, message: 'Enter your first name.' };

  // A GRADUATION YEAR IS A STUDENT'S FACT. Staff do not graduate, so the field
  // is not asked of them and is sent as null; the database says the same thing
  // in a CHECK constraint rather than trusting this.
  let graduationYear = null;
  if (affiliation === 'STUDENT') {
    graduationYear = Number(String(formData.get('graduation_year') ?? '').trim());
    if (!Number.isInteger(graduationYear) || graduationYear < 2000 || graduationYear > 2100) {
      return { ok: false, message: 'Choose the year you expect to graduate.' };
    }
  }

  // Normalised here so somebody typing 020 123 4567 is not told off by a
  // regular expression in the database. An unusable value is refused before a
  // round trip; the database checks the shape again regardless.
  let phone = null;
  if (phoneRaw) {
    phone = normaliseGhanaPhone(phoneRaw);
    if (!phone) {
      return { ok: false, message: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
    }
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc('update_my_profile', {
      p_first_name: firstName,
      p_last_name: lastName || null,
      p_phone: phone,
      p_affiliation: affiliation,
      p_graduation_year: graduationYear,
      p_gender: gender,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    return actionFailure(error, 'account');
  }

  revalidatePath('/account', 'layout');
  return { ok: true, message: 'Saved.' };
}
