import { SmsProvider } from './provider.js';

/**
 * Arkesel — the production SMS provider for Ghana.
 *
 * Everything Arkesel-specific lives in this file. The rest of the application
 * knows only `SmsProvider.send()`, so replacing Arkesel later is one new file
 * plus a case in the factory, exactly as replacing the fake provider was.
 *
 * ACCEPTANCE IS NOT DELIVERY
 * --------------------------
 * A 200 from this endpoint means Arkesel took the message, not that a handset
 * received it. Those are different claims and conflating them is how you end up
 * telling a customer their code was sent when it was rejected by the network.
 * So `ok` here means accepted, and the real outcome arrives later on the
 * delivery webhook — see lib/sms/arkesel-webhook.js.
 *
 * THE API KEY IS IN THE QUERY STRING
 * ----------------------------------
 * That is Arkesel's v1 design, not a choice. It means the request URL is itself
 * a secret, so this module never logs a URL, never puts one in an Error message,
 * and never returns one. Everything it reports is built from the response.
 */

/** Documented v1 result codes. `ok` is the only success. */
const ERROR_CODES = {
  100: 'Arkesel rejected the request as malformed',
  101: 'Arkesel did not recognise the action',
  102: 'Arkesel rejected the API key',
  103: 'Arkesel rejected the phone number',
  104: 'Arkesel does not cover this number',
  105: 'The Arkesel account has insufficient balance',
  106: 'Arkesel rejected the sender ID — it must be registered and at most 11 characters',
  109: 'Arkesel rejected the scheduled time',
  111: 'Arkesel flagged the message content as spam',
};

const DEFAULT_TIMEOUT_MS = 15_000;

export class ArkeselSmsProvider extends SmsProvider {
  /**
   * Dependencies are injected rather than read from the environment here, so
   * this class is testable without a live account and without env juggling —
   * the factory in ./index.js is the one place that reads configuration.
   */
  constructor({ apiKey, senderId, endpoint, callbackBaseUrl = null, fetchImpl, timeoutMs } = {}) {
    super();
    if (!apiKey) throw new Error('ArkeselSmsProvider needs an API key.');
    if (!senderId) throw new Error('ArkeselSmsProvider needs a sender ID.');

    this.apiKey = apiKey;
    this.senderId = senderId;
    this.endpoint = endpoint || 'https://sms.arkesel.com/sms/api';
    this.callbackBaseUrl = callbackBaseUrl;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get name() {
    return 'arkesel';
  }

  /**
   * @param {string} phoneNumber E.164, e.g. "+233201234567"
   * @param {string} message
   * @param {{ tag?: string, idempotencyKey?: string, timeoutMs?: number }} options
   *   `idempotencyKey` is our correlation reference. Arkesel's v1 send response
   *   carries no message id, so there would otherwise be nothing to match a
   *   later delivery report against. We put the reference into the callback URL
   *   and Arkesel hands it back.
   *
   *   `timeoutMs` overrides the instance default for one call. The Supabase Auth
   *   Send SMS Hook has a FIVE SECOND total budget, so the OTP path passes a
   *   much shorter one than an order notification needs.
   * @returns {Promise<{ok: boolean, accepted: boolean, providerMessageId: string|null,
   *                    correlationId: string|null, providerCode: string|null, error?: string}>}
   */
  async send(phoneNumber, message, options = {}) {
    const correlationId = options.idempotencyKey ?? null;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;

    // Arkesel wants the international form without a '+'.
    const to = String(phoneNumber ?? '').replace(/^\+/, '');
    if (!/^\d{7,15}$/.test(to)) {
      // Retrying will not make the number valid.
      return this.#failure('not a sendable phone number', { correlationId, retryable: false });
    }
    if (!message) {
      return this.#failure('refusing to send an empty message', {
        correlationId,
        retryable: false,
      });
    }

    // URLSearchParams encodes the message, which routinely contains spaces, '#'
    // and '+' — all of which change meaning if pasted into a URL raw.
    const params = new URLSearchParams({
      action: 'send-sms',
      api_key: this.apiKey,
      to,
      from: this.senderId,
      sms: message,
    });

    const callbackUrl = this.#callbackUrlFor(correlationId);
    if (callbackUrl) params.set('callback_url', callbackUrl);

    let response;
    let body;
    try {
      response = await this.fetchImpl(`${this.endpoint}?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      body = await response.text();
    } catch (error) {
      // Network failure, DNS, TLS, or our own timeout. Deliberately does not
      // echo the error's own message when it might contain the request URL.
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      // Both are transient by nature: the same request may well succeed in a
      // moment, so the caller is allowed to ask for a retry.
      return this.#failure(
        timedOut ? `Arkesel did not respond within ${timeoutMs}ms` : 'could not reach Arkesel',
        { correlationId, retryable: true }
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      // An HTML error page almost always means a gateway or outage, not a
      // request we could fix by changing it.
      return this.#failure(`Arkesel returned a non-JSON response (HTTP ${response.status})`, {
        correlationId,
        retryable: response.status >= 500,
      });
    }

    const code = parsed?.code === undefined || parsed?.code === null ? null : String(parsed.code);

    if (code !== 'ok') {
      const known = ERROR_CODES[Number(code)];
      // A rejection is Arkesel's considered answer about THIS message. Sending
      // the identical request again produces the identical rejection and, on the
      // OTP path, burns the hook's five-second budget doing it.
      return this.#failure(known ?? `Arkesel rejected the message (code ${code ?? 'unknown'})`, {
        correlationId,
        providerCode: code,
        retryable: false,
      });
    }

    return {
      ok: true,
      accepted: true,
      // v1 does not return one. If a future response ever carries an id, take
      // it rather than making the caller ask again.
      providerMessageId: firstMessageId(parsed),
      correlationId,
      providerCode: 'ok',
      // Balance is genuinely operational: running out is the most common cause
      // of "SMS stopped working" and it is only visible here.
      balance: typeof parsed.balance === 'number' ? parsed.balance : null,
    };
  }

  /**
   * Where Arkesel should report the outcome. Our correlation reference rides
   * along; Arkesel appends its own sms_id and status.
   */
  #callbackUrlFor(correlationId) {
    if (!this.callbackBaseUrl || !correlationId) return null;
    const url = new URL(`${this.callbackBaseUrl.replace(/\/+$/, '')}/api/sms/webhook/arkesel`);
    url.searchParams.set('ref', correlationId);
    return url.toString();
  }

  /**
   * `retryable` says whether asking again could plausibly produce a different
   * answer. It is what lets the Send SMS Hook route choose between a status
   * code Supabase will retry and one it will not.
   */
  #failure(error, { correlationId = null, providerCode = null, retryable = false } = {}) {
    return {
      ok: false,
      accepted: false,
      providerMessageId: null,
      correlationId,
      providerCode,
      retryable,
      error,
    };
  }
}

/** Tolerates the several shapes Arkesel has used for a message id. */
function firstMessageId(parsed) {
  return (
    parsed?.sms_id ??
    parsed?.message_id ??
    parsed?.id ??
    (Array.isArray(parsed?.data) ? (parsed.data[0]?.id ?? null) : null) ??
    null
  );
}

export { ERROR_CODES as ARKESEL_ERROR_CODES };
