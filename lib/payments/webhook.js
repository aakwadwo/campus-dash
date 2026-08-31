import 'server-only';

import { getPaymentProvider } from '@/lib/payments';
import {
  recordWebhookEvent,
  markWebhookProcessed,
  confirmPayment,
  failPayment,
} from '@/lib/orders/transitions';

/**
 * Processes one inbound provider event.
 *
 * Shared by the real webhook route and, in development, by the poller that
 * simulates the fake provider calling us back. Both go through exactly this
 * path, so the dedup and signature handling that will matter in production are
 * exercised now rather than written later.
 *
 * The order of operations matters:
 *   1. verify the signature — an unsigned caller must not move money;
 *   2. record the event, which DEDUPLICATES on the provider's own event id;
 *   3. act only if it is new.
 *
 * Providers retry. A webhook delivered five times must move money once.
 */
export async function processPaymentWebhook({ rawBody, headers }) {
  const provider = getPaymentProvider();

  let event;
  try {
    event = await provider.handleWebhook({ rawBody, headers });
  } catch (error) {
    return { status: 400, body: { error: `malformed webhook: ${error.message}` } };
  }

  if (!event.eventId) {
    return { status: 400, body: { error: 'event has no id, so it cannot be deduplicated' } };
  }

  const { webhook_id: webhookId, is_new: isNew } = await recordWebhookEvent({
    provider: provider.name,
    eventId: event.eventId,
    payload: event.raw ?? {},
    signatureValid: event.signatureValid,
  });

  if (!event.signatureValid) {
    // Stored and flagged, never acted on.
    return { status: 401, body: { error: 'invalid signature' } };
  }

  if (!isNew) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  try {
    if (event.status === 'SUCCEEDED') {
      await confirmPayment({
        paymentId: event.reference,
        providerTransactionId: event.providerTransactionId,
        amountPesewas: event.amountPesewas,
      });
      await markWebhookProcessed(webhookId, 'PROCESSED');
    } else if (event.status === 'FAILED' || event.status === 'CANCELLED') {
      await failPayment(event.reference, `provider reported ${event.status}`);
      await markWebhookProcessed(webhookId, 'PROCESSED');
    } else {
      // PENDING and anything else we do not act on.
      await markWebhookProcessed(webhookId, 'IGNORED');
    }
  } catch (error) {
    await markWebhookProcessed(webhookId, 'FAILED', error.message);
    // A 500 asks the provider to retry, and the dedup above makes that safe.
    return { status: 500, body: { error: error.message } };
  }

  return { status: 200, body: { ok: true } };
}
