import { EmailProvider } from './provider.js';

/**
 * ResendEmailProvider — one POST to /emails, plain text.
 *
 * Credentials arrive as constructor arguments rather than being read here, so
 * the factory stays the single place the environment is touched and this class
 * is testable against a stub `fetch` with no account. Exactly how
 * PaystackPaymentProvider and ArkeselSmsProvider are built.
 *
 * NOTHING HERE THROWS ON A REJECTED SEND. The caller is a notification, and a
 * notification that failed must be recordable rather than explosive — the
 * operational event it describes has already happened. A transport failure
 * (Resend unreachable) is caught and returned in the same shape.
 */
export class ResendEmailProvider extends EmailProvider {
  constructor({ apiKey, fromAddress, apiUrl = 'https://api.resend.com', fetchImpl } = {}) {
    super();
    if (!apiKey) throw new Error('ResendEmailProvider requires an API key');
    if (!fromAddress) throw new Error('ResendEmailProvider requires a from address');
    this.apiKey = apiKey;
    this.fromAddress = fromAddress;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  get name() {
    return 'resend';
  }

  async send({ to, subject, text, tag = null }) {
    try {
      const res = await this.fetchImpl(`${this.apiUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [to],
          subject,
          text,
          ...(tag ? { tags: [{ name: 'campus_dash_event', value: tag }] } : {}),
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        return {
          ok: false,
          providerMessageId: null,
          error: body?.message ?? `Resend rejected the send (${res.status})`,
        };
      }

      return { ok: true, providerMessageId: body?.id ?? null };
    } catch (error) {
      return { ok: false, providerMessageId: null, error: error.message };
    }
  }
}
