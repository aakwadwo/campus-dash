/**
 * SmsProvider — the only interface the rest of the application may depend on.
 *
 * Implementations: FakeSmsProvider (development) and, later, a Ghana SMS
 * provider. Adding a real provider must not require touching business logic.
 */
export class SmsProvider {
  /**
   * @param {string} phoneNumber E.164, e.g. "+233201234567"
   * @param {string} message
   * @param {{ idempotencyKey?: string, tag?: string }} [options]
   * @returns {Promise<{ ok: boolean, providerMessageId: string|null, error?: string }>}
   */
  async send(phoneNumber, message, options = {}) {
    throw new Error('SmsProvider.send() not implemented');
  }

  /** Human-readable provider name, for logging and audit records. */
  get name() {
    throw new Error('SmsProvider.name not implemented');
  }
}

/**
 * Normalises Ghanaian input to E.164.
 * Accepts "0201234567", "233201234567", "+233 20 123 4567".
 * Returns null when the number cannot be interpreted — callers must treat that
 * as a validation failure rather than sending to a guess.
 */
export function normaliseGhanaPhone(input) {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[^\d+]/g, '').replace(/^\+/, '');

  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return `+${digits}`;
  if (/^\d{9}$/.test(digits)) return `+233${digits}`;
  return null;
}
