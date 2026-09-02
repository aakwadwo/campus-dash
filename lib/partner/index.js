import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { NOTIFICATION_EVENT } from '@/lib/notifications';

/**
 * The Partner's side of a delivery.
 *
 * Every call runs as the signed-in user. The database re-derives whether they
 * are an approved, available Partner and whether this delivery is theirs — the
 * screen never decides.
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

function unwrap(result) {
  const envelope = Array.isArray(result) ? result[0] : result;
  return { success: Boolean(envelope?.success), reason: envelope?.reason ?? null, ...envelope };
}

// --- Application -------------------------------------------------------------

export function getMyApplication() {
  return rpc('my_partner_application', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

export function apply({ studentIdNumber, classYear, email, studentIdImagePath, faceImagePath }) {
  return rpc('partner_apply', {
    p_student_id_number: studentIdNumber,
    p_class_year: classYear,
    p_email: email,
    p_student_id_image_path: studentIdImagePath,
    p_face_image_path: faceImagePath,
  });
}

export function setAvailability(available) {
  return rpc('partner_set_availability', { p_available: available });
}

// --- Offers and assignment ---------------------------------------------------

/** Zone-level only. No customer identity, phone or room number. */
export function getOffers() {
  return rpc('get_delivery_offers', {});
}

/**
 * First valid acceptance wins, atomically.
 *
 * Notifies only on a win — telling a customer a Partner is coming when the
 * Partner lost the race would be worse than saying nothing.
 */
export async function acceptDelivery(orderId) {
  const result = unwrap(await rpc('partner_accept_delivery', { p_order_id: orderId }));

  if (result.success) {
    // The pickup code comes back from the claim itself. It is passed straight
    // through rather than re-read, so it never lives in a second place.
    await notifyOrderEvent(NOTIFICATION_EVENT.PARTNER_ASSIGNED, orderId, {
      pickupCode: result.pickup_code,
      deliveryCode: await getCustomerDeliveryCodeForNotice(orderId),
    });
  }
  return result;
}

/**
 * The customer's delivery code, read server-side purely to put it in their SMS.
 * The Partner never sees this value — a different function, gated on being the
 * customer, is what shows it on their screen.
 */
async function getCustomerDeliveryCodeForNotice(orderId) {
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('order_secrets')
    .select('delivery_code')
    .eq('order_id', orderId)
    .maybeSingle();
  return data?.delivery_code ?? null;
}

export async function cancelDelivery(orderId, reason) {
  const result = unwrap(
    await rpc('partner_cancel_delivery', { p_order_id: orderId, p_reason: reason ?? null })
  );
  if (result.success) {
    await notifyOrderEvent(NOTIFICATION_EVENT.ORDER_CANCELLED, orderId);
  }
  return result;
}

// --- Active job --------------------------------------------------------------

export function getActiveDelivery() {
  return rpc('partner_active_delivery', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

export function getMyPickupCode(orderId) {
  return rpc('get_my_pickup_code', { p_order_id: orderId });
}

export async function completeDelivery(orderId, deliveryCode) {
  const result = unwrap(
    await rpc('partner_complete_delivery', {
      p_order_id: orderId,
      p_delivery_code: deliveryCode,
    })
  );
  if (result.success) {
    await notifyOrderEvent(NOTIFICATION_EVENT.DELIVERY_COMPLETED, orderId);
  }
  return result;
}

export async function reportCustomerAbsent(orderId) {
  return unwrap(await rpc('partner_report_customer_absent', { p_order_id: orderId }));
}

export async function confirmCustomerAbsent(orderId) {
  const result = unwrap(await rpc('partner_confirm_customer_absent', { p_order_id: orderId }));
  if (result.success) {
    await notifyOrderEvent(NOTIFICATION_EVENT.ORDER_CANCELLED, orderId);
  }
  return result;
}

// --- History and money -------------------------------------------------------

export function getHistory(limit = 30) {
  return rpc('partner_delivery_history', { p_limit: limit });
}

export function getEarnings() {
  return rpc('partner_earnings_summary', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}
