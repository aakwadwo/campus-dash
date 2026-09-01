import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Arkesel delivery-report webhook: signature verification and payload parsing.
 *
 * WHAT IS AND IS NOT CONFIRMED
 * ----------------------------
 * Arkesel sends three headers:
 *
 *   X-Arkesel-Webhook-Timestamp
 *   X-Arkesel-Webhook-Signature
 *   X-Arkesel-Webhook-Id
 *
 * Their published developer documentation does not state which bytes the
 * signature covers or how it is encoded, and no public sample shows it. Rather
 * than bury a guess inside the verifier, the canonical form is named
 * explicitly, defaults to the near-universal convention, and is selectable with
 * ARKESEL_WEBHOOK_SCHEME. Confirming it against one real webhook is a
 * documented five-minute step — see docs/SMS.md.
 *
 * What is NOT done here, deliberately: accepting several schemes at once and
 * treating any match as valid. That sounds accommodating and is a hole. The
 * body-only variants carry no timestamp, so accepting one as a fallback would
 * silently discard replay protection for every request. Exactly one scheme is
 * ever accepted, and a mismatch is a rejection.
 */

/** Requests older than this are refused, so a captured one cannot be replayed. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Canonical forms, most likely first. `payload` is the raw body for a POST, or
 * the raw query string for a GET — whichever carried the delivery data.
 */
export const SIGNATURE_SCHEMES = {
  // The convention used by Stripe, Svix/Standard Webhooks and most others.
  'timestamp.body:hex': { canonical: (ts, payload) => `${ts}.${payload}`, encoding: 'hex' },
  'timestamp.body:base64': { canonical: (ts, payload) => `${ts}.${payload}`, encoding: 'base64' },
  'body:hex': { canonical: (_ts, payload) => payload, encoding: 'hex' },
  'body:base64': { canonical: (_ts, payload) => payload, encoding: 'base64' },
};

export const DEFAULT_SCHEME = 'timestamp.body:hex';

function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  const found = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return found ? headers[found] : null;
}

/** The three Arkesel headers, however the runtime happened to case them. */
export function arkeselWebhookHeaders(headers) {
  return {
    id: header(headers, 'x-arkesel-webhook-id'),
    timestamp: header(headers, 'x-arkesel-webhook-timestamp'),
    signature: header(headers, 'x-arkesel-webhook-signature'),
  };
}

/**
 * @param {object} params
 * @param {string} params.payload raw body, or raw query string for a GET
 * @param {Headers|Record<string,string>} params.headers
 * @param {string} params.secret ARKESEL_WEBHOOK_SECRET
 * @param {string} [params.scheme] key of SIGNATURE_SCHEMES
 * @param {number} [params.nowSeconds] injectable for tests
 * @returns {{valid: boolean, reason?: string, webhookId?: string}}
 */
export function verifyArkeselWebhook({ payload, headers, secret, scheme, nowSeconds }) {
  const { id, timestamp, signature } = arkeselWebhookHeaders(headers);

  if (!secret) return { valid: false, reason: 'no webhook secret configured on this server' };
  if (!signature) return { valid: false, reason: 'missing signature header' };
  if (!id) return { valid: false, reason: 'missing webhook id header' };

  const chosen = SIGNATURE_SCHEMES[scheme ?? DEFAULT_SCHEME];
  if (!chosen) return { valid: false, reason: `unknown signature scheme "${scheme}"` };

  // Replay protection. Only meaningful for the schemes that actually bind the
  // timestamp into the signature, which is why those are the default.
  if (chosen.canonical('X', '') !== '') {
    if (!timestamp) return { valid: false, reason: 'missing timestamp header' };

    const sent = toEpochSeconds(timestamp);
    if (sent === null) return { valid: false, reason: 'malformed timestamp header' };

    const now = nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - sent) > TOLERANCE_SECONDS) {
      return { valid: false, reason: 'timestamp outside the replay window' };
    }
  }

  const expected = createHmac('sha256', secret)
    .update(chosen.canonical(timestamp ?? '', payload ?? ''))
    .digest(chosen.encoding);

  // Providers vary on prefixes ("sha256=", "v1="); compare against the bare
  // digest whichever way it arrives.
  const candidates = String(signature)
    .split(/[,\s]+/)
    .map((part) => part.replace(/^(sha256|v1)=/i, '').trim())
    .filter(Boolean);

  const matched = candidates.some((candidate) => safeEqual(candidate, expected));
  return matched
    ? { valid: true, webhookId: id }
    : { valid: false, reason: 'signature mismatch', webhookId: id };
}

/**
 * DEVELOPMENT ONLY. Names the scheme that WOULD have matched, so an unknown
 * signing convention can be pinned down from one real webhook instead of
 * guessed at. It reports a scheme name and nothing else — never the secret,
 * never the expected digest, and it must never gate a request.
 */
export function diagnoseArkeselSignature({ payload, headers, secret }) {
  const { timestamp, signature } = arkeselWebhookHeaders(headers);
  if (!secret || !signature) return null;

  const candidates = String(signature)
    .split(/[,\s]+/)
    .map((part) => part.replace(/^(sha256|v1)=/i, '').trim())
    .filter(Boolean);

  for (const [name, spec] of Object.entries(SIGNATURE_SCHEMES)) {
    const digest = createHmac('sha256', secret)
      .update(spec.canonical(timestamp ?? '', payload ?? ''))
      .digest(spec.encoding);
    if (candidates.some((candidate) => safeEqual(candidate, digest))) return name;
  }
  return null;
}

/**
 * Arkesel reports the outcome as sms_id + status. On a GET those are query
 * parameters; on a POST they are JSON. `ref` is our own correlation reference,
 * which we put into the callback URL when we sent the message.
 *
 * NOTHING HERE IS TRUSTED UNTIL THE SIGNATURE HAS BEEN VERIFIED. This function
 * only shapes the data; the caller decides whether it is allowed to matter.
 */
export function parseArkeselDeliveryPayload({ rawBody, searchParams }) {
  let fromBody = {};
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object') fromBody = parsed;
    } catch {
      // Not JSON. Arkesel's older callback is form-encoded.
      fromBody = Object.fromEntries(new URLSearchParams(rawBody));
    }
  }

  const pick = (...names) => {
    for (const name of names) {
      const fromQuery = searchParams?.get?.(name);
      if (fromQuery) return fromQuery;
      if (fromBody[name]) return String(fromBody[name]);
    }
    return null;
  };

  return {
    correlationId: pick('ref', 'correlation_id', 'clientReference'),
    providerMessageId: pick('sms_id', 'smsId', 'message_id', 'id'),
    rawStatus: pick('status', 'delivery_status', 'state'),
  };
}

/**
 * Arkesel's status vocabulary, normalised.
 *
 * The provider's own strings are kept in the webhook_events payload; this is
 * only the summary the notification row carries. UNKNOWN is a real answer —
 * better than pretending a message we know nothing about arrived.
 */
const STATUS_MAP = {
  DELIVRD: 'DELIVERED',
  DELIVERED: 'DELIVERED',
  UNDELIV: 'FAILED',
  UNDELIVERED: 'FAILED',
  FAILED: 'FAILED',
  REJECTD: 'REJECTED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  ACCEPTD: 'ACCEPTED',
  ACCEPTED: 'ACCEPTED',
  PENDING: 'PENDING',
};

export function normaliseArkeselStatus(rawStatus) {
  if (!rawStatus) return null;
  return STATUS_MAP[String(rawStatus).trim().toUpperCase()] ?? 'UNKNOWN';
}

function toEpochSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  // Tolerate milliseconds, which several providers send.
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Test/dev helper: produce the headers Arkesel would send for a payload. */
export function signArkeselWebhook({
  payload,
  secret,
  id = 'wh_test',
  timestamp,
  scheme = DEFAULT_SCHEME,
}) {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const spec = SIGNATURE_SCHEMES[scheme];
  const signature = createHmac('sha256', secret)
    .update(spec.canonical(ts, payload ?? ''))
    .digest(spec.encoding);
  return {
    'x-arkesel-webhook-id': id,
    'x-arkesel-webhook-timestamp': ts,
    'x-arkesel-webhook-signature': signature,
  };
}
