import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

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

export async function vendorAcceptOrder(orderId) {
  return unwrap(await callAsUser('vendor_accept_order', { p_order_id: orderId }));
}

export async function vendorRejectOrder(orderId, reason) {
  return unwrap(
    await callAsUser('vendor_reject_order', { p_order_id: orderId, p_reason: reason ?? null })
  );
}

export async function vendorMarkPreparing(orderId) {
  return unwrap(await callAsUser('vendor_mark_preparing', { p_order_id: orderId }));
}

export async function vendorMarkReady(orderId) {
  return unwrap(await callAsUser('vendor_mark_ready', { p_order_id: orderId }));
}

/** The vendor types in the code the Partner reads aloud. They never see it. */
export async function vendorConfirmPickup(orderId, pickupCode) {
  return unwrap(
    await callAsUser('vendor_confirm_pickup', {
      p_order_id: orderId,
      p_pickup_code: pickupCode,
    })
  );
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

export function confirmPayment({ paymentId, providerTransactionId, amountPesewas }) {
  return callAsService('confirm_payment', {
    p_payment_id: paymentId,
    p_provider_transaction_id: providerTransactionId,
    p_amount_pesewas: amountPesewas,
  });
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
