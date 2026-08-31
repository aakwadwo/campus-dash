import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { notify, NOTIFICATION_EVENT, AUDIENCE } from '@/lib/notifications';

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
  [NOTIFICATION_EVENT.ORDER_SUBMITTED]: [AUDIENCE.VENDOR, AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_ACCEPTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_REJECTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.PAYMENT_CONFIRMED]: [AUDIENCE.CUSTOMER, AUDIENCE.VENDOR],
  [NOTIFICATION_EVENT.ORDER_PREPARING]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_READY]: [AUDIENCE.CUSTOMER],
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
        `id, order_number, fulfilment_type, total_pesewas, cancellation_reason,
         customer_id, partner_id, partner_earnings_pesewas,
         customer:users!orders_customer_id_fkey (phone, full_name),
         partner:users!orders_partner_id_fkey (phone, full_name),
         vendor:vendors!orders_vendor_id_fkey (phone, name)`
      )
      .eq('id', orderId)
      .single();

    if (error || !order) {
      console.error(`[notify] could not load order ${orderId}:`, error?.message);
      return { sent: 0, skipped: 0 };
    }

    const context = {
      orderNumber: order.order_number,
      vendorName: order.vendor?.name ?? 'the vendor',
      partnerName: order.partner?.full_name ?? 'A Partner',
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
