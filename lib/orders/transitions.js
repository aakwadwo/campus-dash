import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { notifyOrderEvent } from './notify';
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
 * The client sends menu item ids and quantities only. Any price it includes is
 * ignored: the server reads current prices and snapshots them onto the order.
 */
export async function submitOrder({
  vendorId,
  fulfilmentType,
  items,
  destinationLocationId,
  destinationNote,
}) {
  const rows = await callAsUser('submit_order', {
    p_vendor_id: vendorId,
    p_fulfilment_type: fulfilmentType,
    p_items: items.map(({ menuItemId, quantity }) => ({ menu_item_id: menuItemId, quantity })),
    p_destination_location_id: destinationLocationId ?? null,
    p_destination_note: destinationNote ?? null,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export function getMyDeliveryCode(orderId) {
  return callAsUser('get_my_delivery_code', { p_order_id: orderId });
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

export async function vendorAcceptOrder(orderId) {
  const result = unwrap(await callAsUser('vendor_accept_order', { p_order_id: orderId }));
  return announce(result, NOTIFICATION_EVENT.ORDER_ACCEPTED, orderId);
}

export async function vendorRejectOrder(orderId, reason) {
  const result = unwrap(
    await callAsUser('vendor_reject_order', { p_order_id: orderId, p_reason: reason ?? null })
  );
  return announce(result, NOTIFICATION_EVENT.ORDER_REJECTED, orderId);
}

export async function vendorMarkPreparing(orderId) {
  const result = unwrap(await callAsUser('vendor_mark_preparing', { p_order_id: orderId }));
  return announce(result, NOTIFICATION_EVENT.ORDER_PREPARING, orderId);
}

export async function vendorMarkReady(orderId) {
  const result = unwrap(await callAsUser('vendor_mark_ready', { p_order_id: orderId }));
  return announce(result, NOTIFICATION_EVENT.ORDER_READY, orderId);
}

/**
 * The vendor types in the code the Partner reads aloud. They never see it.
 *
 * This is the moment the Partner earns the customer's room number and phone —
 * so it is also the moment both sides are told the food is on its way.
 */
export async function vendorConfirmPickup(orderId, pickupCode) {
  const result = unwrap(
    await callAsUser('vendor_confirm_pickup', {
      p_order_id: orderId,
      p_pickup_code: pickupCode,
    })
  );
  return announce(result, NOTIFICATION_EVENT.PARTNER_PICKED_UP, orderId);
}

export async function vendorCompletePickupOrder(orderId) {
  return unwrap(await callAsUser('vendor_complete_pickup_order', { p_order_id: orderId }));
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

export function partnerSetAvailability(available) {
  return callAsUser('partner_set_availability', { p_available: available });
}

export function getMyPickupCode(orderId) {
  return callAsUser('get_my_pickup_code', { p_order_id: orderId });
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
  if (orderId) await notifyOrderEvent(NOTIFICATION_EVENT.PAYMENT_CONFIRMED, orderId);
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

export function markPayoutPaid({ payoutId, provider, providerTransferId }) {
  return callAsService('mark_payout_paid', {
    p_payout_id: payoutId,
    p_provider: provider,
    p_provider_transfer_id: providerTransferId,
  });
}
