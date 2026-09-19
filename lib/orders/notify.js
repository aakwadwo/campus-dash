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

/**
 * Who hears about what. Everything else stays quiet.
 *
 * SMS COSTS MONEY AND ATTENTION, and the second is the scarcer one. This table
 * was trimmed hard after Partners reported being buzzed five times for one
 * delivery they were already looking at on their screen. The rule that produced
 * the list below: a message is sent only when somebody has to DO something they
 * would not otherwise know about, and only to the person who has to do it.
 *
 * WHAT COMES OUT OF THE APP INSTEAD. Everything removed here is still shown,
 * live, on the screen belonging to the person concerned — the customer's
 * tracking page, the Partner's dashboard, the store's board. A notification
 * that duplicates a screen somebody is already watching is noise.
 *
 * THE PARTNER hears three things, and only three: that they were approved
 * (dispatch.js), that work is available (dispatch.js), and that an order they
 * have already accepted is ready to collect. Accepting, collecting, completing
 * and earning are all things they just did, on a screen, and being texted about
 * your own action is the purest form of the noise this trimming was about.
 *
 * THE CUSTOMER hears about a collection being ready — they are about to walk to
 * a counter and need to know when — and about a Partner taking their order,
 * because until somebody does, nothing on the tracking page moves and there is
 * nothing to look at. That message carries NO CODE: the delivery code lives on
 * the tracking screen, behind their session, and an SMS holding it would outlive
 * the delivery by months. Every other state reaches them on that same page,
 * which is open in front of them.
 *
 * THE STORE hears that a paid order has arrived, and that one was cancelled.
 * Both are things a phone on a counter has to surface when nobody is looking at
 * it. Nothing else: a Partner being assigned changes nothing about what the
 * store does next.
 */
const AUDIENCES = {
  // The store is NOT here. An unpaid order is not a ticket, and the customer is
  // looking at the pay button as this would have arrived.
  [NOTIFICATION_EVENT.ORDER_SUBMITTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_ACCEPTED]: [AUDIENCE.CUSTOMER],
  [NOTIFICATION_EVENT.ORDER_REJECTED]: [AUDIENCE.CUSTOMER],

  // THE STORE'S ONLY "NEW ORDER" MESSAGE. The customer is NOT here: they are
  // looking at the screen that just told them the payment went through, and a
  // text repeating it arrives while they are still holding the phone.
  [NOTIFICATION_EVENT.PAYMENT_CONFIRMED]: [AUDIENCE.VENDOR],

  [NOTIFICATION_EVENT.ORDER_PREPARING]: [AUDIENCE.CUSTOMER],

  // THE PARTNER IS LISTED, AND THAT IS WHAT MAKES COLLECTION SAFE. An order
  // nobody is carrying has no partner_id, so parties[PARTNER].phone is
  // undefined and the audience is skipped before a message is built — the
  // branch is the data, not an if.
  //
  // THE CUSTOMER IS LISTED TOO, and the template sends them nothing unless they
  // are collecting it themselves: renderSms returns null for a Partner order,
  // so the audience resolves to a skip. Somebody about to walk to a counter
  // needs to know when; somebody waiting in their room is watching the page.
  [NOTIFICATION_EVENT.ORDER_READY]: [AUDIENCE.CUSTOMER, AUDIENCE.PARTNER],

  [NOTIFICATION_EVENT.ORDER_CANCELLED]: [AUDIENCE.CUSTOMER, AUDIENCE.VENDOR],

  // THE CUSTOMER ONLY, and told only that it has been taken. The Partner just
  // pressed accept and is looking at the job; the store's next action is
  // unchanged by who is coming for it, and it used to be told anyway. The
  // message used to carry the delivery code as well — see templates.js for why
  // it no longer does.
  [NOTIFICATION_EVENT.PARTNER_ASSIGNED]: [AUDIENCE.CUSTOMER],

  // NOBODY. The Partner collected it — they know. The customer's page says "on
  // the way" the moment it happens. The store watched them walk out.
  [NOTIFICATION_EVENT.PARTNER_PICKED_UP]: [],

  // NOBODY. The Partner handed it over and the customer took it; both were
  // there. The Partner's earnings are on their dashboard, where a running
  // balance belongs — a text saying "GH₵5 added" after every single delivery
  // was the most-complained-about message in the product.
  [NOTIFICATION_EVENT.DELIVERY_COMPLETED]: [],
};

/**
 * @param {string} event one of NOTIFICATION_EVENT
 * @param {string} orderId
 * @param {object} [extra] event-specific context the CALLER already holds.
 *   NOTHING PASSES A HANDOFF CODE, and nothing may: no template renders one any
 *   more, and codes are never read from the database here either — both would
 *   put a secret in a place that outlives the delivery it belongs to.
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
      // Whatever the caller holds that the event needs. NEVER A HANDOFF CODE:
      // no template takes one, nothing passes one, and none is read out of the
      // database here either.
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
