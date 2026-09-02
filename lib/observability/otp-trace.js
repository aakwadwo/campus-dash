import { createHash, randomUUID } from 'node:crypto';

/**
 * TEMPORARY — OTP path tracing.
 *
 * Added to answer one question: where do the seconds go between a customer
 * pressing "Send code" and a usable code reaching their handset? The path
 * crosses three processes we do not control the boundaries of —
 *
 *   server action ──▶ Supabase Auth ──▶ Send SMS Hook (Vercel) ──▶ Arkesel
 *
 * — so no single log line can span it. This produces one greppable line per
 * step in each leg, joined by a phone TAG that every process derives the same
 * way. Delete the whole file, and its call sites, once the diagnosis is settled.
 *
 * WHAT IS NEVER LOGGED
 * --------------------
 * The OTP, the phone number, any API key, the hook secret, or an Arkesel URL
 * (which contains the API key — see lib/sms/arkesel.js). Lengths and outcomes
 * only.
 *
 * The tag is a truncated salted SHA-256 of the E.164 number. The salt is a
 * constant in this file rather than a secret, because the two legs run in
 * different processes with different environments and the tag is worthless
 * unless both compute it identically. That is a deliberate trade: the tag is
 * not plaintext and is not reversible from the logs alone, but anyone holding
 * this source could confirm a guessed number. It is a correlation handle for a
 * short investigation, not an anonymisation scheme, and it goes away with the
 * rest of this file.
 */

const TAG_SALT = 'campus-dash/otp-trace/v1';

/** Off with OTP_TRACE=off. On by default, because the point is production. */
function enabled() {
  return process.env.OTP_TRACE !== 'off';
}

/** Stable across processes, so the action leg and the hook leg line up. */
export function phoneTag(phone) {
  if (!phone) return 'none';
  return createHash('sha256').update(`${TAG_SALT}:${phone}`).digest('hex').slice(0, 10);
}

/**
 * Opens one leg of the trace.
 *
 * @param {'action'|'hook'|'arkesel'} leg
 * @param {string|null} phone E.164, used only to derive the tag
 * @param {{ rid?: string, startedAt?: number }} [options] `rid` lets a nested
 *   leg (the Arkesel adapter) share the enclosing request's id.
 * @returns {(event: string, fields?: Record<string, unknown>) => void}
 */
export function otpTrace(leg, phone, { rid, startedAt } = {}) {
  const id = rid ?? randomUUID().slice(0, 8);
  const t0 = startedAt ?? Date.now();
  const tag = phoneTag(phone);

  const emit = (event, fields = {}) => {
    if (!enabled()) return;
    const parts = [
      `[otp-trace] leg=${leg}`,
      `ev=${event}`,
      `rid=${id}`,
      `tag=${tag}`,
      `t=+${Date.now() - t0}ms`,
    ];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${String(value).replace(/\s+/g, '_')}`);
    }
    console.log(parts.join(' '));
  };

  emit.rid = id;
  emit.startedAt = t0;
  emit.tag = tag;
  return emit;
}
