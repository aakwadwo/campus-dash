import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks signature verification, as used by Supabase Auth hooks.
 *
 * This is the ONLY thing standing between the Send SMS Hook route and an
 * unauthenticated SMS-sending endpoint. Anyone who learns the URL could
 * otherwise drive it — sending messages at our cost, and to numbers they choose.
 *
 * https://www.standardwebhooks.com/
 */

/** Requests older than this are rejected, so a captured one cannot be replayed. */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {object} params
 * @param {string} params.body raw request body, exactly as received
 * @param {Headers|Record<string,string>} params.headers
 * @param {string} params.secret one or more space-separated "v1,whsec_<base64>"
 *   secrets. Supabase names this setting in the plural and supports rotation:
 *   during one, requests may arrive signed with either the outgoing or the
 *   incoming secret, so every configured secret is tried.
 * @param {number} [params.nowSeconds] injectable for tests
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyWebhookSignature({ body, headers, secret, nowSeconds }) {
  const get = (name) =>
    typeof headers.get === 'function'
      ? headers.get(name)
      : (headers[name] ?? headers[name.toLowerCase()]);

  const id = get('webhook-id');
  const timestamp = get('webhook-timestamp');
  const signatureHeader = get('webhook-signature');

  if (!id || !timestamp || !signatureHeader) {
    return { valid: false, reason: 'missing webhook signature headers' };
  }
  if (!secret) {
    return { valid: false, reason: 'no hook secret configured on this server' };
  }

  // Replay window. A signature stays valid forever otherwise.
  const sent = Number(timestamp);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(sent)) return { valid: false, reason: 'malformed webhook-timestamp' };
  if (Math.abs(now - sent) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'webhook timestamp outside tolerance' };
  }

  // The secret is base64 AFTER the whsec_ prefix, and the HMAC is over the
  // decoded bytes — not over the printable string.
  const expected = secretsIn(secret).map((key) =>
    createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')
  );

  if (expected.length === 0) {
    return { valid: false, reason: 'no usable hook secret configured on this server' };
  }

  // The header may carry several space-separated versioned signatures during a
  // secret rotation; any one matching is enough.
  const candidates = signatureHeader
    .split(' ')
    .map((part) => (part.startsWith('v1,') ? part.slice(3) : null))
    .filter(Boolean);

  if (candidates.length === 0) return { valid: false, reason: 'no v1 signature present' };

  // Every candidate against every configured secret. Both sides are small, and
  // stopping early on the first match is fine: the comparison itself is
  // constant-time, which is what protects the secret.
  const matched = candidates.some((candidate) =>
    expected.some((digest) => safeEqual(candidate, digest))
  );
  return matched ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/** Decoded keys for every secret configured, in the order given. */
function secretsIn(secret) {
  return String(secret)
    .split(/\s+/)
    .filter(Boolean)
    .map((one) => Buffer.from(one.replace(/^v1,/, '').replace(/^whsec_/, ''), 'base64'))
    .filter((key) => key.length > 0);
}

/** Constant-time compare, so a wrong signature leaks nothing through timing. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Test/dev helper: produce the headers Supabase would send for a given body. */
export function signWebhook({ body, secret, id = 'msg_test', timestamp }) {
  const ts = String(timestamp ?? Math.floor(Date.now() / 1000));
  const rawSecret = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  const key = Buffer.from(rawSecret, 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': `v1,${signature}`,
  };
}
