import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { notifyOrderEvent } from './notify';
import { notifyPartnersOfOffer } from '@/lib/notifications/dispatch';
import { NOTIFICATION_EVENT } from '@/lib/notifications';

/**
 * The application's entry point to every order state change.
 *
 * Nothing here decides anything. Each function calls a database function that
 * re-derives authorisation from auth.uid() and performs a conditional UPDATE,
 * so this layer cannot be tricked into a transition the database would refuse.
 *
 * TWO FAILURE SHAPES, deliberately:
 *
 *   * A REJECTED transition (lost a race, wrong current state, bad code) comes
 *     back as { success: false, reason }. It is routine, it is already logged in
 *     order_events, and callers turn it into a message for the user.
 *
 *   * An AUTHORISATION failure throws. It means a bug or an attack, and it
 *     should be loud.
 */

class TransitionRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'TransitionRejected';
    this.rejected = true;
  }
}

export { TransitionRejected };

/** Calls an RPC as the signed-in user, so RLS and auth.uid() apply. */
async function callAsUser(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/** Calls an RPC with the service-role key. Server-side operations only. */
async function callAsService(fn, args) {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/** Unwraps a transition_result, throwing only when the caller asked us to. */
function unwrap(result, { throwOnReject = false } = {}) {
  const envelope = Array.isArray(result) ? result[0] : result;
  const normalised = {
    success: Boolean(envelope?.success),
    reason: envelope?.reason ?? null,
    ...envelope,
  };
  if (!normalised.success && throwOnReject) {
    throw new TransitionRejected(normalised.reason ?? 'transition rejected');
  }
  return normalised;
}

// --- Customer ---------------------------------------------------------------

/**
 * A vendor, some items, and how the customer wants it. That is the submission.
 *
 * PICKUP OR DELIVERY COMES IN HERE NOW. There is no vendor acceptance to put it
 * after: the order is priced in full at the checkout, paid for, and only then
 * does a store see it. What arrives back is already payable.
 *
 * The client sends menu item ids, quantities and a fulfilment choice. Any price
 * it includes is ignored — the server reads current prices, adds the delivery
 * fee from pricing_config, and snapshots the lot onto the order.
 */
export async function submitOrder({
  vendorId,
  items,
  fulfilmentType,
  destinationLocationId = null,
  destinationNote = null,
}) {
  const rows = await callAsUser('submit_order', {
    p_vendor_id: vendorId,
    p_items: items.map(({ menuItemId, quantity }) => ({ menu_item_id: menuItemId, quantity })),
    p_fulfilment_type: fulfilmentType,
    p_destination_location_id: destinationLocationId,
    p_destination_note: destinationNote,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

/**
 * CHANGING the choice, after submission and before payment.
 *
 * The choice itself is made at the checkout. This exists for the customer who
 * gets to the pay screen and thinks better of the GH₵5 — or who finds delivery
 * has been switched off since they chose it.
 *
 * The price is recomputed in the database from the order's own snapshot. No
 * amount crosses this boundary in either direction, so there is nothing here
 * for a tampered client to change.
 */
export async function customerChooseFulfilment({
  orderId,
  fulfilmentType,
  destinationLocationId,
  destinationNote,
}) {
  return unwrap(
    await callAsUser('customer_choose_fulfilment', {
      p_order_id: orderId,
      p_fulfilment_type: fulfilmentType,
      p_destination_location_id: destinationLocationId ?? null,
      p_destination_note: destinationNote ?? null,
    })
  );
}

export function getMyDeliveryCode(orderId) {
  return callAsUser('get_my_delivery_code', { p_order_id: orderId });
}

/**
 * Rates the Partner who brought a completed order.
 *
 * The PARTNER IS NOT A PARAMETER. customer_rate_partner reads them off the
 * order, so there is nothing here for a hand-built request to aim at somebody
 * else, and the order id is the primary key of the ratings table, so a second
 * tap cannot become a second row.
 */
export async function customerRatePartner({ orderId, stars, comment }) {
  return unwrap(
    await callAsUser('customer_rate_partner', {
      p_order_id: orderId,
      p_stars: stars,
      p_comment: comment ?? null,
    })
  );
}

// --- Vendor -----------------------------------------------------------------

/**
 * Notifies only when the transition actually happened. A rejected transition
 * changed nothing, so telling the customer their order was accepted would be a
 * lie — and the loudest possible kind.
 */
async function announce(result, event, orderId) {
  if (result.success) await notifyOrderEvent(event, orderId);
  return result;
}

/**
 * READY is the store's only button.
 *
 * There is no accept, no reject and no separate "start preparing": an order
 * reaches a kitchen already paid for, and the one thing left to say about it is
 * that it is made.
 *
 * Dispatch no longer opens here — payment did that, so a Partner is usually
 * already assigned by now. The broadcast stays as a safety net for the order
 * whose search somehow had not started, and partners_to_notify_of_offer()
 * checks the order really is SEARCHING, so a delivery already taken notifies
 * nobody.
 */
export async function vendorMarkReady(orderId) {
  const result = unwrap(await callAsUser('vendor_mark_ready', { p_order_id: orderId }));
  await announce(result, NOTIFICATION_EVENT.ORDER_READY, orderId);
  if (result.success) await notifyPartnersOfOffer(orderId);
  return result;
}

/**
 * The four digits the VENDOR reads out at the counter.
 *
 * One function for both handoffs, because from behind the counter they are the
 * same act: somebody is standing there and the code is how the store knows the
 * food is theirs to take. A Partner types it into their app; a customer
 * collecting their own order types it into theirs.
 *
 * WHOEVER HOLDS THE CODE MUST NOT BE THE ONE WHO CONFIRMS. That is why there is
 * no companion function anywhere that shows this value to a Partner or to a
 * customer — the asymmetry is the whole proof.
 */
export function vendorHandoffCode(orderId) {
  return callAsUser('vendor_handoff_code', { p_order_id: orderId });
}

/**
 * The CUSTOMER types in the code the vendor read them, and that completes a
 * collection.
 *
 * The mirror of partnerConfirmPickup, and for the same reason: the person
 * walking away with the food is the one who has to prove they were handed it.
 */
export async function customerCompletePickup(orderId, pickupCode) {
  return unwrap(
    await callAsUser('customer_complete_pickup', {
      p_order_id: orderId,
      p_pickup_code: pickupCode,
    })
  );
}

export function vendorSetAcceptingOrders(vendorId, accepting) {
  return callAsUser('vendor_set_accepting_orders', {
    p_vendor_id: vendorId,
    p_accepting: accepting,
  });
}

// --- Partner ----------------------------------------------------------------

/** Zone-level information only. No customer identity, phone or room number. */
export function getDeliveryOffers() {
  return callAsUser('get_delivery_offers', {});
}

/**
 * First valid acceptance wins, atomically. A loser gets
 * { success: false, reason: 'This delivery has already been taken.' }
 */
export async function partnerAcceptDelivery(orderId) {
  return unwrap(await callAsUser('partner_accept_delivery', { p_order_id: orderId }));
}

export async function partnerCancelDelivery(orderId, reason) {
  return unwrap(
    await callAsUser('partner_cancel_delivery', {
      p_order_id: orderId,
      p_reason: reason ?? null,
    })
  );
}

export async function partnerCompleteDelivery(orderId, deliveryCode) {
  return unwrap(
    await callAsUser('partner_complete_delivery', {
      p_order_id: orderId,
      p_delivery_code: deliveryCode,
    })
  );
}

/**
 * The Partner types in the code the vendor reads them, and that is the handoff.
 *
 * It is also the moment the food is genuinely in transit, so it is what tells
 * the customer their order is on the way.
 */
export async function partnerConfirmPickup(orderId, pickupCode) {
  const result = unwrap(
    await callAsUser('partner_confirm_pickup', {
      p_order_id: orderId,
      p_pickup_code: pickupCode,
    })
  );
  return announce(result, NOTIFICATION_EVENT.PARTNER_PICKED_UP, orderId);
}

export function partnerSetAvailability(available) {
  return callAsUser('partner_set_availability', { p_available: available });
}

// --- Server-side only -------------------------------------------------------
// None of these are reachable from a browser: the functions are not granted to
// the authenticated role, and they assert a server context internally.

export function createPaymentIntent({ orderId, provider, idempotencyKey }) {
  return callAsService('create_payment_intent', {
    p_order_id: orderId,
    p_provider: provider,
    p_idempotency_key: idempotencyKey,
  });
}

export async function confirmPayment({ paymentId, providerTransactionId, amountPesewas }) {
  const payment = await callAsService('confirm_payment', {
    p_payment_id: paymentId,
    p_provider_transaction_id: providerTransactionId,
    p_amount_pesewas: amountPesewas,
  });
  const orderId = Array.isArray(payment) ? payment[0]?.order_id : payment?.order_id;
  if (orderId) {
    await notifyOrderEvent(NOTIFICATION_EVENT.PAYMENT_CONFIRMED, orderId);
    // A SCAN order has no vendor to mark it READY, so confirm_payment() is what
    // opens dispatch for one. The broadcast therefore belongs here as well as
    // on vendorMarkReady — and partners_to_notify_of_offer() checks the order
    // really is SEARCHING, so a food order passing through here notifies nobody.
    await notifyPartnersOfOffer(orderId);
  }
  return payment;
}

export function failPayment(paymentId, reason) {
  return callAsService('fail_payment', { p_payment_id: paymentId, p_reason: reason ?? null });
}

/** Returns { webhook_id, is_new }. Only act on the event when is_new is true. */
export async function recordWebhookEvent({ provider, eventId, payload, signatureValid }) {
  const rows = await callAsService('record_webhook_event', {
    p_provider: provider,
    p_event_id: eventId,
    p_payload: payload,
    p_signature_valid: signatureValid,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export function markWebhookProcessed(webhookId, status, error) {
  return callAsService('mark_webhook_processed', {
    p_webhook_id: webhookId,
    p_status: status,
    p_error: error ?? null,
  });
}

/**
 * Applies a provider delivery report to the notification it belongs to.
 *
 * Idempotent: a conditional UPDATE keyed on our correlation reference, so the
 * same report delivered five times sets the same row to the same value. An
 * unmatched reference returns matched=false rather than raising — see the
 * migration for why that is the right answer and not a swallowed error.
 */
export async function recordSmsDeliveryStatus({
  provider,
  correlationId,
  status,
  providerMessageId,
}) {
  const rows = await callAsService('record_sms_delivery_status', {
    p_provider: provider,
    p_correlation_id: correlationId,
    p_status: status,
    p_provider_message_id: providerMessageId ?? null,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

/** Scheduled job: 60-second vendor acceptance window elapsed. No charge taken. */
export function expireStaleOrders() {
  return callAsService('expire_stale_orders', {});
}

/** Scheduled job: dispatch gave up. Touches delivery state ONLY. */
export function expirePartnerSearch() {
  return callAsService('expire_partner_search', {});
}

export function createSettlementRun({ payeeType, periodStart, periodEnd }) {
  return callAsService('create_settlement_run', {
    p_payee_type: payeeType,
    p_period_start: periodStart,
    p_period_end: periodEnd,
  });
}

/**
 * The transfer arrived. `amountPesewas` is what the PROVIDER reported: passing
 * it makes the database refuse the payout unless it matches to the pesewa, the
 * same guard confirm_payment applies to money coming in. Null only where the
 * provider gave us no independent figure to check.
 */
export function markPayoutPaid({ payoutId, provider, providerTransferId, amountPesewas = null }) {
  return callAsService('mark_payout_paid', {
    p_payout_id: payoutId,
    p_provider: provider,
    p_provider_transfer_id: providerTransferId,
    p_amount_pesewas: amountPesewas,
  });
}

/**
 * The transfer completed and then the money came back.
 *
 * Distinct from failPayout: a late transfer.failed against a PAID payout is
 * ignored, because money that left is not un-sent by an event arriving out of
 * order. A reversal is the case where it genuinely did come back, so the payout
 * becomes REVERSED and the liability returns to the pool.
 */
export function reversePayout(payoutId, reason) {
  return callAsService('reverse_payout', { p_payout_id: payoutId, p_reason: reason ?? null });
}

/**
 * The provider ACCEPTED a transfer. That is not the same as the money landing —
 * see hard rule 15 — so the payout sits at PROCESSING until a transfer event
 * says what actually happened.
 */
export function markPayoutProcessing({ payoutId, provider, providerTransferId }) {
  return callAsService('mark_payout_processing', {
    p_payout_id: payoutId,
    p_provider: provider,
    p_provider_transfer_id: providerTransferId,
  });
}

/**
 * A transfer that failed. Releases the allocation claim in the same
 * transaction, so the money goes back into the next run rather than being
 * stranded behind a dead payout row.
 */
export function failPayout(payoutId, reason) {
  return callAsService('fail_payout', { p_payout_id: payoutId, p_reason: reason ?? null });
}

/**
 * Puts a FAILED payout back to PENDING, re-claiming the allocations that were
 * released. Returns { success, reason }: it refuses when a later run has
 * already swept that money, which is a state to look at rather than to retry.
 *
 * Manual only. An automatic retry loop against a payments API is how the same
 * money gets sent twice.
 */
export async function retryPayout(payoutId) {
  return unwrap(await callAsService('retry_payout', { p_payout_id: payoutId }));
}

/** Which payout a transfer event is about. Null when nothing matches. */
export async function payoutForTransfer({ provider, providerTransferId, reference }) {
  const rows = await callAsService('payout_for_transfer', {
    p_provider: provider,
    p_provider_transfer_id: providerTransferId ?? null,
    p_reference: reference ?? null,
  });
  const payout = Array.isArray(rows) ? rows[0] : rows;
  return payout?.id ? payout : null;
}

/** Where a payee's money goes. Server-side only; never reaches a browser. */
export async function payoutDestinationFor({ payeeType, payeeId }) {
  const rows = await callAsService('payout_destination_for', {
    p_payee_type: payeeType,
    p_payee_id: payeeId,
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.payee_id ? row : null;
}

/** Records the recipient the provider issued for a payout destination. */
export function attachPayoutRecipient({ payeeType, payeeId, provider, recipientCode }) {
  return callAsService('attach_payout_recipient', {
    p_payee_type: payeeType,
    p_payee_id: payeeId,
    p_provider: provider,
    p_recipient_code: recipientCode,
  });
}

/**
 * Records the SUBACCOUNT the provider issued for a payout destination.
 *
 * Separate from the recipient code above because the two describe the same
 * mobile money account for different directions of travel: a recipient is where
 * we push money to, a subaccount is where the provider routes money at the
 * moment it is collected. A failure to create one must not clear the other.
 *
 * `error` is stored rather than thrown away, because "we tried and Paystack
 * said no" is the one thing an administrator needs in order to fix it.
 */
export function attachPayoutSubaccount({ payeeType, payeeId, provider, subaccountCode, error }) {
  return callAsService('attach_payout_subaccount', {
    p_payee_type: payeeType,
    p_payee_id: payeeId,
    p_provider: provider,
    p_subaccount_code: subaccountCode ?? null,
    p_error: error ?? null,
  });
}

/**
 * Records what the provider was actually asked to split off this charge.
 *
 * Written BEFORE the customer reaches the checkout and never afterwards:
 * create_order_allocations reads it to decide whether the vendor's money is
 * already on its way to them or still ours to send.
 */
export function attachPaymentSplit({ paymentId, subaccountCode, vendorPesewas }) {
  return callAsService('attach_payment_split', {
    p_payment_id: paymentId,
    p_subaccount_code: subaccountCode ?? null,
    p_vendor_pesewas: vendorPesewas ?? 0,
  });
}
