import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { notifyPartnersOfOffer } from '@/lib/notifications/dispatch';
import { NOTIFICATION_EVENT } from '@/lib/notifications';
import { deferNotification } from '@/lib/notifications/defer';

/**
 * Tells everybody concerned, AFTER the response. Only ever called once the
 * transition has returned success, so nothing is announced that did not happen.
 */
function announceAfter(event, orderId, extra) {
  return deferNotification(event, async () =>
    notifyOrderEvent(event, orderId, typeof extra === 'function' ? await extra() : extra)
  );
}

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

/**
 * Apply to be a Partner. ONE DOCUMENT AND ONE AGREEMENT.
 *
 * Name, level and the verified school address are already on the account:
 * PARTNER ⇒ CUSTOMER, and the database refuses this call without that row.
 * Which is also why nothing here asks for a face photograph — the school
 * address has already established who this is, and a second photograph proved
 * nothing it had not while being the most sensitive thing Campus Dash held.
 *
 * Nor is a student ID NUMBER asked for. What an administrator judges is the
 * card itself; a number typed into a box was never checked against anything.
 *
 * The terms acceptance is recorded in the same transaction as the application,
 * so "they agreed" is a row rather than a sentence under a button.
 */
export function apply({ studentIdImagePath, termsId = null }) {
  return rpc('partner_apply', {
    p_student_id_image_path: studentIdImagePath,
    p_terms_id: termsId,
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
 *
 * NEITHER CODE IS READ HERE. The pickup code belongs to the vendor, who reads
 * it out at the counter. The delivery code belongs to the customer and is shown
 * on their own tracking screen, behind their own session — this used to fetch
 * it with the service-role key purely to put it in their SMS, and that read is
 * gone with the code that was in the message. A secret nothing needs is a
 * secret with one fewer place to leak from.
 */
export async function acceptDelivery(orderId) {
  const result = unwrap(await rpc('partner_accept_delivery', { p_order_id: orderId }));

  if (result.success) {
    await announceAfter(NOTIFICATION_EVENT.PARTNER_ASSIGNED, orderId);
  }
  return result;
}

/**
 * A Partner changes their mind before the handoff.
 *
 * THE ORDER IS NOT CANCELLED, and this used to announce that it was. It fired
 * ORDER_CANCELLED, whose audience is the customer and the store — so a customer
 * whose lunch was being made got a text saying their order had been cancelled,
 * and the store was told to stop preparing it, because one Partner had decided
 * not to carry something. Neither was true. The order, the payment and the
 * preparation are all untouched; only the assignment moved.
 *
 * WHAT ACTUALLY HAS TO HAPPEN is that somebody else is found, so the offer goes
 * back out to every eligible Partner. partner_cancel_delivery() has already
 * bumped `dispatch_generation`, which is what lets this second broadcast reach
 * the Partners who were told the first time and did not take it — without it
 * the notification layer would deduplicate it against the first round and send
 * nothing at all.
 *
 * The customer is told nothing by SMS. Their tracking page moves back to
 * "finding a Partner" on its own, which is both faster and the truth.
 */
export async function cancelDelivery(orderId, reason) {
  const result = unwrap(
    await rpc('partner_cancel_delivery', { p_order_id: orderId, p_reason: reason ?? null })
  );
  if (result.success) {
    await deferNotification(NOTIFICATION_EVENT.DELIVERY_AVAILABLE, () =>
      notifyPartnersOfOffer(orderId)
    );
  }
  return result;
}

// --- Active jobs -------------------------------------------------------------

/**
 * The default cap, and the ONLY thing this constant is for: a sensible number
 * to render before the real one has been read.
 *
 * The live figure lives in pricing_config and an administrator changes it. It
 * is enforced in the database — by the claim's own count and by the unique slot
 * index — so nothing here is a limit, and no screen should treat it as one.
 */
export const DEFAULT_MAX_ACTIVE_DELIVERIES = 2;

/** How many deliveries this Partner may hold, and how many they hold now. */
export function getCapacity() {
  return rpc('partner_capacity', {}).then((rows) => {
    const row = Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
    return {
      maxActive: row?.max_active ?? DEFAULT_MAX_ACTIVE_DELIVERIES,
      activeNow: row?.active_now ?? 0,
      slotsFree: row?.slots_free ?? 0,
    };
  });
}

/** This Partner's own standing. An average, never the individual ratings. */
export function getRating() {
  return rpc('my_partner_rating', {}).then((rows) => {
    const row = Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
    return {
      count: Number(row?.rating_count ?? 0),
      average: row?.average_stars == null ? null : Number(row.average_stars),
    };
  });
}

/** Where this Partner's earnings are sent. Never the whole account number. */
export function getPayoutDestination() {
  return rpc('my_payout_destination', {}).then((rows) => {
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    return list.find((row) => row.payee_type === 'PARTNER') ?? null;
  });
}

/**
 * Every delivery this Partner is currently carrying, in slot order.
 *
 * Each row carries the customer's name and phone number, and the authority for
 * that is server-side: partner_active_delivery() selects them only for orders
 * where partner_id = auth.uid() and the delivery is ASSIGNED or PICKED_UP, and
 * the RLS policy on public.users says the same thing independently. Once the
 * delivery completes, both stop returning it.
 */
export function getActiveDeliveries() {
  return rpc('partner_active_delivery', {}).then((rows) => (Array.isArray(rows) ? rows : []));
}

/** The one an action names. Read from the same authorised list, never a query. */
export async function getActiveDelivery(orderId = null) {
  const rows = await getActiveDeliveries();
  if (!orderId) return rows[0] ?? null;
  return rows.find((row) => row.order_id === orderId) ?? null;
}

/**
 * The Partner types in the code the vendor reads out.
 *
 * There is no function that shows a Partner the pickup code, and there must not
 * be: possession of the secret is what the handoff proves, and a Partner who
 * held it could confirm a collection that never happened.
 */
/**
 * NOBODY IS NOTIFIED HERE, and the absence is the decision.
 *
 * Collecting and completing are things the Partner has just done, on a screen,
 * in front of the other party. The customer's tracking page moves within a
 * second of either; the store watched them walk out. Both used to send two
 * messages each, and a Partner carrying two orders could collect five texts in
 * a lunch hour about their own taps.
 *
 * The transitions themselves are unchanged, including the ledger: the Partner's
 * earnings are carved out in SQL by settle_partner_earnings() on completion,
 * and were never a consequence of the SMS.
 */
export async function confirmPickup(orderId, pickupCode) {
  return unwrap(
    await rpc('partner_confirm_pickup', {
      p_order_id: orderId,
      p_pickup_code: pickupCode,
    })
  );
}

export async function completeDelivery(orderId, deliveryCode) {
  return unwrap(
    await rpc('partner_complete_delivery', {
      p_order_id: orderId,
      p_delivery_code: deliveryCode,
    })
  );
}

export async function reportCustomerAbsent(orderId) {
  return unwrap(await rpc('partner_report_customer_absent', { p_order_id: orderId }));
}

export async function confirmCustomerAbsent(orderId) {
  const result = unwrap(await rpc('partner_confirm_customer_absent', { p_order_id: orderId }));
  if (result.success) {
    await announceAfter(NOTIFICATION_EVENT.ORDER_CANCELLED, orderId);
  }
  return result;
}

// --- History and money -------------------------------------------------------

export function getHistory(limit = 30) {
  return rpc('partner_delivery_history', { p_limit: limit });
}

/**
 * Earnings, and where they stand against the weekly payout policy.
 *
 * `available` is what the next run will consider; `in_progress` is what a run
 * has already claimed and is sending. They are kept apart because adding them
 * together would show a Partner a number that is partly already gone.
 */
export function getEarnings() {
  return rpc('partner_earnings_summary', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

/** This Partner's own payouts. Carries no provider failure text — see the SQL. */
export function getPayouts(limit = 20) {
  return rpc('my_partner_payouts', { p_limit: limit });
}
