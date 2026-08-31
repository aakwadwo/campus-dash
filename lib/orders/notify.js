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
};

/**
 * @param {string} event one of NOTIFICATION_EVENT
 * @param {string} orderId
 * @returns {Promise<{sent: number, skipped: number}>} never throws
 */
export async function notifyOrderEvent(event, orderId) {
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
         customer:users!orders_customer_id_fkey (phone, full_name),
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
      totalPesewas: order.total_pesewas,
      isPickup: order.fulfilment_type === 'PICKUP',
      refundNote: order.cancellation_reason ?? undefined,
    };

    const phones = {
      [AUDIENCE.CUSTOMER]: order.customer?.phone,
      [AUDIENCE.VENDOR]: order.vendor?.phone,
    };

    const results = await notify({
      event,
      recipients: audiences.map((audience) => ({ audience, phone: phones[audience] })),
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
