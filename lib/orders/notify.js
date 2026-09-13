import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { notify, NOTIFICATION_EVENT, AUDIENCE } from '@/lib/notifications';
import { orderLabel } from '@/lib/orders/state';
import { config } from '@/lib/config';

/**
 * Turns an order state change into notifications.
 *
 * Business logic calls notifyOrderEvent(); it never touches an SMS provider and
 * never composes copy. Swapping in a Ghana provider is a change inside
 * lib/sms — nothing here moves.
 *
 * Reads use the service-role client on purpose: a vendor triggering ACCEPT must
 * cause the CUSTOMER to be told, and the vendor cannot read the customer's phone
 * number. The recipient list is decided here, from the event, not from whoever
 * happened to trigger it.
 *
 * Failures are logged and swallowed. A dropped SMS must never roll back a state
 * transition that has already happened — the order is real whether or not the
 * message arrived.
 */

/** Who hears about what. Everything else stays quiet: SMS costs money. */
const AUDIENCES = {
  // The store is NOT here. An unpaid order is not a ticket, and the customer is
  // looking at the pay button as this would have arrived.
  [NOTIFICATION_EVENT.ORDER_SUBMITTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_ACCEPTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_REJECTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.PAYMENT_CONFIRMED]: [AUDIENCE.CUSTOMER, AUDIENCE.VENDOR],
  [NOTIFICATION_EVENT.ORDER_PREPARING]: [AUDIENCE.CUSTOMER],
  // THE PARTNER IS LISTED, AND THAT IS WHAT MAKES SELF-PICKUP SAFE. A collection
  // order has no partner_id, so parties[PARTNER].phone is undefined and the
  // audience is skipped before a message is built — the branch is the data, not
  // an if. A delivery whose Partner has not accepted yet is skipped the same
  // way, and they are told when they accept instead.
  [NOTIFICATION_EVENT.ORDER_READY]: [AUDIENCE.CUSTOMER, AUDIENCE.PARTNER],
  [NOTIFICATION_EVENT.ORDER_CANCELLED]: [AUDIENCE.CUSTOMER, AUDIENCE.VENDOR],
  // The customer gets their delivery code; the Partner gets the pickup code and
  // what they will earn; the vendor is told someone is coming — and is
  // deliberately NOT told the pickup code.
  [NOTIFICATION_EVENT.PARTNER_ASSIGNED]: [AUDIENCE.CUSTOMER, AUDIENCE.VENDOR, AUDIENCE.PARTNER],
  [NOTIFICATION_EVENT.PARTNER_PICKED_UP]: [AUDIENCE.CUSTOMER, AUDIENCE.PARTNER],
  [NOTIFICATION_EVENT.DELIVERY_COMPLETED]: [AUDIENCE.CUSTOMER, AUDIENCE.PARTNER],
};

/**
 * @param {string} event one of NOTIFICATION_EVENT
 * @param {string} orderId
 * @param {object} [extra] event-specific context, e.g. a pickup or delivery
 *   code that the CALLER already holds. Codes are never read from the database
 *   here — that would put them in a second place they can leak from.
 * @returns {Promise<{sent: number, skipped: number}>} never throws
 */
/**
 * The order, in the few words that fit on a lock screen.
 *
 * "your Jollof Rice" is a thing somebody recognises; "#007" is a thing they
 * have to go and look up. The queue number is still the right identifier INSIDE
 * the app, where it sits next to the order it names and next to the store
 * calling it out — it is just the wrong one to lead an SMS with.
 *
 * Names come from `name_snapshot`, the copy taken when the order was placed, so
 * a renamed or deleted menu item cannot change what somebody was told they
 * bought. Nothing else about the item is included: no price, no id, no vendor
 * internals.
 */
function orderSummary(items) {
  const lines = Array.isArray(items) ? items.filter((i) => i?.name_snapshot) : [];
  if (lines.length === 0) return 'order';

  const [first, ...rest] = lines;
  const quantity = Number(first.quantity ?? 1);
  const head = quantity > 1 ? `${quantity}× ${first.name_snapshot}` : first.name_snapshot;

  if (rest.length === 0) return head;
  return `${head} and ${rest.length} more item${rest.length === 1 ? '' : 's'}`;
}

export async function notifyOrderEvent(event, orderId, extra = {}) {
  const audiences = AUDIENCES[event];
  if (!audiences) {
    console.warn(`[notify] no audience configured for ${event}`);
    return { sent: 0, skipped: 0 };
  }

  try {
    const supabase = createAdminClient();

    const { data: order, error } = await supabase
      .from('orders')
      .select(
        `id, order_number, vendor_order_no, fulfilment_type, total_pesewas,
         cancellation_reason,
         customer_id, partner_id, partner_earnings_pesewas,
         order_items (id, name_snapshot, quantity),
         customer:users!orders_customer_id_fkey (phone, full_name, first_name),
         partner:users!orders_partner_id_fkey (phone, full_name, first_name),
         vendor:vendors!orders_vendor_id_fkey (phone, name)`
      )
      .eq('id', orderId)
      .single();

    if (error || !order) {
      console.error(`[notify] could not load order ${orderId}:`, error?.message);
      return { sent: 0, skipped: 0 };
    }

    const context = {
      // THE QUEUE NUMBER, not the internal reference. "#007" is what the store
      // calls out and what is printed on the customer's screen; CD-01043 is a
      // database key nobody should be asked to read down a phone.
      orderNumber: orderLabel(order),
      itemCount: order.order_items?.length ?? 0,
      // WHAT THEY ORDERED, for the message that has to be recognisable on a
      // lock screen. See orderSummary().
      orderSummary: orderSummary(order.order_items),
      appUrl: config.publicAppUrl() ?? 'https://www.campusdash.app',
      vendorName: order.vendor?.name ?? 'the vendor',
      // FIRST NAME ONLY, in the one message that names a Partner to a
      // customer. "Kwame is bringing your order" is what a person says; a
      // surname in an SMS is somebody's private data forwarded to a stranger's
      // phone, permanently.
      partnerName: firstNameOf(order.partner) ?? 'Your Partner',
      customerName: firstNameOf(order.customer) ?? 'the customer',
      totalPesewas: order.total_pesewas,
      earningsPesewas: order.partner_earnings_pesewas,
      isPickup: order.fulfilment_type === 'PICKUP',
      refundNote: order.cancellation_reason ?? undefined,
      // Codes are passed in by the caller when the event needs them; they are
      // never read back out of the database here.
      ...extra,
    };

    const parties = {
      [AUDIENCE.CUSTOMER]: { phone: order.customer?.phone, userId: order.customer_id },
      [AUDIENCE.VENDOR]: { phone: order.vendor?.phone, userId: null },
      [AUDIENCE.PARTNER]: { phone: order.partner?.phone, userId: order.partner_id },
    };

    const results = await notify({
      event,
      orderId,
      recipients: audiences.map((audience) => ({ audience, ...parties[audience] })),
      context,
    });

    return {
      sent: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
    };
  } catch (caught) {
    console.error(`[notify] ${event} for ${orderId} failed:`, caught.message);
    return { sent: 0, skipped: 0 };
  }
}

/**
 * The first name to use in a message.
 *
 * Prefers the column; falls back to the first word of a legacy full_name, which
 * is what accounts created before the split still carry. Returns null rather
 * than a placeholder so the caller decides what "no name" reads as.
 */
function firstNameOf(person) {
  const first = person?.first_name?.trim();
  if (first) return first;
  const whole = person?.full_name?.trim();
  return whole ? whole.split(/\s+/)[0] : null;
}
