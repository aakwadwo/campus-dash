import 'server-only';

import { config } from '@/lib/config';
import { recordWebhookEvent, markWebhookProcessed } from '@/lib/orders/transitions';
import { recordSmsDeliveryStatus } from '@/lib/orders/transitions';
import {
  verifyArkeselWebhook,
  diagnoseArkeselSignature,
  parseArkeselDeliveryPayload,
  normaliseArkeselStatus,
  arkeselWebhookHeaders,
} from './arkesel-webhook.js';

/**
 * Processes one inbound SMS delivery report.
 *
 * Same order of operations as the payment webhook, for the same reasons:
 *
 *   1. verify the signature — an unverified caller must not write to our
 *      notification log, which is what support reads when someone says a code
 *      never arrived;
 *   2. record the event, which DEDUPLICATES on the provider's own webhook id;
 *   3. act only if it is new.
 *
 * Providers retry. A report delivered five times must update one row once.
 */
export async function processSmsWebhook({ provider, rawBody, searchParams, headers }) {
  if (provider !== 'arkesel') {
    return { status: 404, body: { error: 'unknown sms provider' } };
  }

  // The signature covers whatever carried the data. Arkesel's older callback is
  // a GET whose payload IS the query string, so that is what gets signed when
  // there is no body. Either way it is the exact bytes received, never a
  // re-serialised copy.
  const payload = rawBody && rawBody.length > 0 ? rawBody : (searchParams?.toString() ?? '');

  const secret = config.arkeselWebhookSecret();
  const verification = verifyArkeselWebhook({
    payload,
    headers,
    secret,
    scheme: config.arkeselWebhookScheme(),
  });

  const { id: headerWebhookId } = arkeselWebhookHeaders(headers);
  const parsed = parseArkeselDeliveryPayload({ rawBody, searchParams });

  // Without an id there is nothing to deduplicate on, so derive a deterministic
  // one from the report itself. A genuine retry of the same report then still
  // collapses to one write.
  const eventId =
    headerWebhookId ??
    (parsed.correlationId && parsed.rawStatus
      ? `derived:${parsed.correlationId}:${parsed.rawStatus}`
      : null);

  if (!eventId) {
    return { status: 400, body: { error: 'report has no id, so it cannot be deduplicated' } };
  }

  // Recorded either way, so a stream of forged callbacks is visible rather than
  // silently dropped. The payload is stored; it is never acted on.
  const { webhook_id: webhookId, is_new: isNew } = await recordWebhookEvent({
    provider: 'arkesel',
    eventId,
    payload: {
      query: Object.fromEntries(searchParams ?? []),
      body: rawBody ? String(rawBody).slice(0, 4000) : null,
      parsed,
    },
    signatureValid: verification.valid,
  });

  if (!verification.valid) {
    console.error(`[sms-webhook] REJECTED: ${verification.reason}`);

    // Their documentation does not state the canonical form, so in development
    // say which one WOULD have matched. It never affects the outcome above.
    if (!config.isProduction()) {
      const scheme = diagnoseArkeselSignature({ payload, headers, secret });
      if (scheme) {
        console.error(
          `[sms-webhook] the signature matches scheme "${scheme}". ` +
            `Set ARKESEL_WEBHOOK_SCHEME=${scheme} — see docs/SMS.md.`
        );
      }
    }
    // Deliberately vague to the caller; the reason stays in our logs.
    return { status: 401, body: { error: 'invalid signature' } };
  }

  if (!isNew) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  const status = normaliseArkeselStatus(parsed.rawStatus);
  if (!status || !parsed.correlationId) {
    await markWebhookProcessed(webhookId, 'IGNORED');
    return { status: 200, body: { ok: true, ignored: 'no status or no reference' } };
  }

  try {
    const result = await recordSmsDeliveryStatus({
      provider: 'arkesel',
      correlationId: parsed.correlationId,
      status,
      providerMessageId: parsed.providerMessageId,
    });

    // An unmatched reference is not an error — see the migration. Returning 200
    // stops the provider retrying for ever over a message we will never have.
    await markWebhookProcessed(webhookId, result?.matched ? 'PROCESSED' : 'IGNORED');
    return { status: 200, body: { ok: true, matched: Boolean(result?.matched), status } };
  } catch (error) {
    await markWebhookProcessed(webhookId, 'FAILED', error.message);
    // A 500 asks the provider to retry, and the dedup above makes that safe.
    return { status: 500, body: { error: 'could not record delivery status' } };
  }
}
