/**
 * EmailProvider — the only interface the rest of the application may depend on.
 *
 * The same shape as SmsProvider, and for the same reason: adding or swapping a
 * real provider must be one new file in this folder plus an env change, never a
 * business-logic edit (hard rule 10).
 *
 * EMAIL IS NOT A CUSTOMER CHANNEL HERE. Campus Dash talks to customers,
 * vendors and Partners by SMS, and to Supabase Auth's own mailer for sign-in
 * codes. This interface exists for OPERATIONAL mail — messages to the people
 * running the pilot about things that happened to the platform. Nothing on the
 * ordering, payment or settlement path may depend on it.
 */
export class EmailProvider {
  /**
   * @param {{ to: string, subject: string, text: string, tag?: string }} message
   * @returns {Promise<{ ok: boolean, providerMessageId: string|null, error?: string }>}
   */
  async send(message) {
    throw new Error('EmailProvider.send() not implemented');
  }

  /** Human-readable provider name, for logging and audit records. */
  get name() {
    throw new Error('EmailProvider.name not implemented');
  }
}

/**
 * A permissive address check, deliberately.
 *
 * This guards one thing: that a configuration mistake — an empty string, a
 * stray comment, a phone number pasted into the wrong variable — is caught
 * before a provider is called with it. Deciding whether an address is
 * DELIVERABLE is the provider's job and cannot be done with a regex.
 */
export function looksLikeEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
