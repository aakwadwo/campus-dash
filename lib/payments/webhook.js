import 'server-only';

import { getPaymentProvider } from '@/lib/payments';
import { config } from '@/lib/config';
import {
  recordWebhookEvent,
  markWebhookProcessed,
  confirmPayment,
  failPayment,
  markPayoutPaid,
  failPayout,
  reversePayout,
  payoutForTransfer,
} from '@/lib/orders/transitions';

/**
 * Which adapter this deployment is allowed to authenticate an event with, and
 * whether the caller asked for that one.
 *
 * The route is `/api/payments/webhook/[provider]`, and until this existed the
 * path segment was decorative: the handler dispatched on PAYMENT_PROVIDER and
 * never looked at it. Two consequences, and the second is the serious one.
 *
 *   * A real Paystack POST arriving at a deployment still set to `fake` was
 *     parsed by the fake adapter, failed to yield an event id, and came back
 *     400 — a silent misconfiguration that looks like a provider fault.
 *
 *   * FakePaymentProvider's "signature" is the literal header
 *     `x-fake-signature: fake-signature`. Anyone can send that. On a production
 *     deployment left on `fake`, the endpoint that marks orders paid and
 *     payouts PAID would have been effectively unauthenticated.
 *
 * So: the fake adapter is refused outright in production, and the path segment
 * must name the adapter actually configured. Both are checked BEFORE the body
 * is parsed, verified or recorded — a request for a provider this deployment
 * does not serve gets nowhere near the payload.
 *
 * Returns null when everything lines up, or the response to send back.
 */
function providerGuard(requested) {
  let provider;
  try {
    provider = getPaymentProvider();
  } catch (error) {
    // An unknown or unconfigurable PAYMENT_PROVIDER is our fault, not the
    // caller's. 503 says so and asks the provider to redeliver once it is
    // fixed, which is exactly what we want to happen.
    console.error(`[payment-webhook] no usable payment provider: ${error.message}`);
    return {
      provider: null,
      response: { status: 503, body: { error: 'payments are not configured' } },
    };
  }

  if (config.isProduction() && provider.name === 'fake') {
    console.error(
      '[payment-webhook] REFUSED: PAYMENT_PROVIDER=fake on a production deployment. ' +
        'The fake adapter accepts a forgeable signature and must never authenticate a real event.'
    );
    return {
      provider,
      response: { status: 503, body: { error: 'payments are not configured' } },
    };
  }

  // Undefined means the caller reached this module directly rather than through
  // the route — the in-process fake poller does, and it names itself anyway.
  const asked = String(requested ?? '')
    .trim()
    .toLowerCase();

  if (asked !== provider.name) {
    // 404, like the SMS route: this deployment does not serve that provider,
    // and saying which one it does serve tells a prober something for nothing.
    return {
      provider,
      response: { status: 404, body: { error: 'unknown payment provider' } },
    };
  }

  return { provider, response: null };
}

/**
 * Processes one inbound provider event.
 *
 * Shared by the real webhook route and, in development, by the poller that
 * simulates the fake provider calling us back. Both go through exactly this
 * path, so the dedup and signature handling that will matter in production are
 * exercised now rather than written later.
 *
 * The order of operations matters:
 *   0. check the caller asked for the provider this deployment serves;
 *   1. verify the signature — an unsigned caller must not move money;
 *   2. record the event, which DEDUPLICATES on the provider's own event id;
 *   3. act only if it is new.
 *
 * Providers retry. A webhook delivered five times must move money once.
 */
export async function processPaymentWebhook({ provider: requested, rawBody, headers }) {
  const guard = providerGuard(requested);
  if (guard.response) return guard.response;
  const provider = guard.provider;

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
    // Money IN and money OUT are different ledgers and different tables. A
    // transfer event carries a payout id where a collection event carries a
    // payment id, so sending one down the other's path would either raise or —
    // far worse — confirm a payment against an id that happens to exist.
    const outcome =
      event.kind === 'transfer'
        ? await applyTransferEvent(event, provider.name)
        : await applyCollectionEvent(event);

    await markWebhookProcessed(
      webhookId,
      outcome.webhookStatus ?? (outcome.acted ? 'PROCESSED' : 'IGNORED'),
      outcome.note
    );
  } catch (error) {
    await markWebhookProcessed(webhookId, 'FAILED', error.message);
    // A 500 asks the provider to retry, and the dedup above makes that safe.
    return { status: 500, body: { error: error.message } };
  }

  return { status: 200, body: { ok: true } };
}

/** charge.* — moves the PAYMENT, and through it the order's payment_status. */
async function applyCollectionEvent(event) {
  if (event.status === 'SUCCEEDED') {
    await confirmPayment({
      paymentId: event.reference,
      providerTransactionId: event.providerTransactionId,
      amountPesewas: event.amountPesewas,
    });
    return { acted: true };
  }

  if (event.status === 'FAILED' || event.status === 'CANCELLED') {
    await failPayment(event.reference, `provider reported ${event.status}`);
    return { acted: true };
  }

  // PENDING and anything else we do not act on.
  return { acted: false, note: `collection event ignored at status ${event.status}` };
}

/**
 * transfer.* — moves the PAYOUT.
 *
 * Never reaches confirmPayment(): a payout id is not a payment id, and the two
 * tables are unrelated.
 *
 * Acceptance already put the payout at PROCESSING. This is the event that says
 * what actually happened, which is the only thing that may mark it PAID.
 */
async function applyTransferEvent(event, providerName) {
  const payout = await payoutForTransfer({
    provider: providerName,
    providerTransferId: event.providerTransactionId,
    reference: event.reference,
  });

  if (!payout) {
    // Recorded, not acted on, and not an error: a transfer we have no record of
    // is something for a person to look at, and 500-ing would make the provider
    // retry it forever.
    return {
      acted: false,
      note: `no payout matches transfer ${event.providerTransactionId ?? event.reference}`,
    };
  }

  if (event.status === 'SUCCEEDED') {
    // The amount is checked BEFORE anything is marked paid. A transfer for the
    // wrong amount must not settle allocations — the same rule confirm_payment
    // applies to money coming in.
    //
    // Recorded FAILED and answered 200: the payout stays PROCESSING for a
    // person to look at, and asking the provider to retry would only redeliver
    // the same wrong number for ever.
    if (event.amountPesewas !== null && event.amountPesewas !== payout.amount_pesewas) {
      return {
        acted: false,
        webhookStatus: 'FAILED',
        note: `amount mismatch: provider reported ${event.amountPesewas} but payout ${payout.id} is ${payout.amount_pesewas}`,
      };
    }

    await markPayoutPaid({
      payoutId: payout.id,
      provider: providerName,
      providerTransferId: event.providerTransactionId ?? payout.provider_transfer_id,
      amountPesewas: event.amountPesewas,
    });
    return { acted: true };
  }

  if (event.status === 'REVERSED') {
    // The transfer completed and the money came back. Not a failure: the payout
    // becomes REVERSED and the liability returns to the pool, so the next run
    // settles it again under a new payout.
    await reversePayout(payout.id, 'provider reversed this transfer');
    return { acted: true };
  }

  if (event.status === 'FAILED' || event.status === 'CANCELLED') {
    // Releases the allocation claim, so the money is swept into the next run.
    // The payout stays FAILED and is retried only when a person says so. A late
    // failure against an already-PAID payout is deliberately ignored inside
    // fail_payout — that is what reversals are for.
    await failPayout(payout.id, `provider reported ${event.status}`);
    return { acted: true };
  }

  return { acted: false, note: `transfer event ignored at status ${event.status}` };
}
