import { normaliseGhanaPhone } from '@/lib/sms/provider';

/**
 * The mobile money account a new store is paid into, as its sign-up form sent
 * it. No I/O, so the form's action and the tests read it the same way.
 *
 * REQUIRED AT SIGN-UP: the network, the name on the account, and a number —
 * either a separate MoMo number, or "the number I sign in with", which is the
 * one proven by the SMS code a moment later. vendor_set_payout_destination()
 * validates all three again, and is the authority.
 */

export const MOMO_NETWORKS = Object.freeze(['MTN', 'VODAFONE', 'AIRTELTIGO']);

/** Checks the details step. Returns { ok: true, value } or { ok: false, message }. */
export function readSignupPayout(formData) {
  const momoNetwork = String(formData.get('momo_network') ?? '').trim();
  const accountName = String(formData.get('momo_account_name') ?? '').trim();
  const useSignInPhone = formData.get('momo_use_signin_phone') === 'on';
  const numberRaw = String(formData.get('momo_number') ?? '').trim();

  if (!MOMO_NETWORKS.includes(momoNetwork)) {
    return { ok: false, message: 'Choose the mobile money network you are paid on.' };
  }
  if (!accountName) {
    return { ok: false, message: 'Enter the name on the mobile money account.' };
  }
  if (!useSignInPhone && !normaliseGhanaPhone(numberRaw)) {
    return {
      ok: false,
      message: 'Enter the mobile money number you are paid on, e.g. 055 123 4567.',
    };
  }

  return { ok: true, value: { momoNetwork, accountName, useSignInPhone, numberRaw } };
}

/**
 * The number the payout destination is saved with.
 *
 * `verifiedPhone` is the E.164 number the sign-up's SMS code was just checked
 * against — never a typed field, never a profile phone. Returns null when there
 * is nothing trustworthy to use, which the caller must treat as "not saved".
 */
export function payoutNumberFor({ useSignInPhone, numberRaw }, verifiedPhone) {
  if (useSignInPhone) return normaliseGhanaPhone(verifiedPhone);
  return normaliseGhanaPhone(numberRaw);
}
