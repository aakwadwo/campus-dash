// Relative, with extensions, so this module is importable by the plain Node
// test runner as well as by the Next bundler. The SMS copy is worth testing
// directly rather than only through a running server.
import { NOTIFICATION_EVENT as E, AUDIENCE as A } from './events.js';
import { formatPesewas } from '../util/money.js';
import { toGsm7 } from './gsm7.js';

/**
 * SMS copy, keyed by event then audience. A missing entry means that audience
 * is simply not notified for that event.
 *
 * Keep messages short — Ghanaian SMS is billed per 160-character segment.
 * Never put a pickup code, delivery code, phone number or customer name into a
 * message for someone who is not entitled to it at that moment. A dashboard
 * authorisation expires with the delivery; an SMS does not.
 *
 * Each template receives a context object and returns a string.
 */
export const SMS_TEMPLATES = {
  // NOBODY IS TEXTED WHEN AN ORDER IS CREATED. It is not an order yet in any
  // sense a store cares about: nothing has been paid, and the customer is
  // looking at the pay button as this would arrive. The store hears about it
  // when the money does.
  [E.ORDER_SUBMITTED]: {},

  // Kept for orders placed before paid-first ordering, which can still be
  // sitting in an ACCEPTED state somewhere. Nothing new reaches them.
  [E.ORDER_ACCEPTED]: {
    [A.CUSTOMER]: (c) => `Campus Dash: order #${c.orderNumber} is ready to pay for in the app.`,
  },

  [E.ORDER_REJECTED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} could not be accepted by ${c.vendorName}. You have not been charged.`,
  },

  [E.PAYMENT_REQUIRED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} needs payment of ${formatPesewas(c.totalPesewas)}. Open the app to pay.`,
  },

  // THE STORE'S ONLY "NEW ORDER" MESSAGE, and it says PAID because that is the
  // thing that makes it real. No accept, no reject, no countdown: make it, then
  // press Ready.
  //
  // WHO IS COLLECTING IS NOT IN IT. It used to say "collection" or "delivery",
  // which told a store something it has no use for — the counter does the same
  // work either way — and quietly told it something about the customer.
  //
  // THE CUSTOMER IS NOT SENT ONE AT ALL. They are looking at the screen that
  // just confirmed the payment as this would arrive.
  [E.PAYMENT_CONFIRMED]: {
    [A.VENDOR]: (c) =>
      `Campus Dash: NEW PAID ORDER #${c.orderNumber} — ${c.itemCount} item${c.itemCount === 1 ? '' : 's'}. Start preparing: ${c.appUrl}/vendor`,
  },

  [E.ORDER_PREPARING]: {
    [A.CUSTOMER]: (c) => `Campus Dash: ${c.vendorName} is preparing order #${c.orderNumber}.`,
  },

  [E.ORDER_READY]: {
    // A COLLECTION ONLY. Returning null for anything else is what removes the
    // audience: somebody waiting in their room has the tracking page open and
    // does not need to be told twice, while somebody about to walk to a counter
    // genuinely does not know yet.
    //
    // It also explains the code, because the code does not exist until this
    // moment and they are about to arrive expecting to just be handed food.
    [A.CUSTOMER]: (c) =>
      c.isPickup
        ? `Campus Dash: order #${c.orderNumber} is ready at ${c.vendorName}. They will give you a 4-digit code — enter it in the app to finish.`
        : null,
    // ONLY EVER REACHES A DELIVERY. A collection order has no Partner, so this
    // template is never rendered for one — see the audience note in
    // lib/orders/notify.js.
    //
    // It names the store and the queue number because that is what the Partner
    // has to say at the counter, and it does NOT carry the pickup code: the
    // store reads that out, the Partner types it in. Putting it here would put
    // the secret and the act on the same side of the counter.
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} is ready for collection at ${c.vendorName}. They will read you a 4-digit code — enter it in the app.`,
  },

  // Every available Partner gets this, so it says as little as it possibly
  // can: no customer, no destination, no name, no amount owed to anybody. What
  // it does is get somebody to open their dashboard, where the full offer sits
  // behind their own session.
  [E.DELIVERY_AVAILABLE]: {
    [A.PARTNER]: (c) =>
      `Campus Dash: an order is available. Open ${c.appUrl}/partner/offers to take it.`,
  },

  // THE CUSTOMER ONLY, and it carries NO CODE.
  //
  // It used to end "Your code is 4821. Give it to them on arrival", which made
  // this the one message in the product that broke the rule below it: a handoff
  // code in an SMS is forwardable, screenshottable and permanent, and it
  // outlives by months the delivery it was sent for. The delivery code now
  // lives only where it is actually used — the customer's own tracking screen,
  // behind their own session, which expires when the delivery does.
  //
  // What is left is the one fact the customer cannot see without looking:
  // somebody has taken it. That is worth a buzz; the four digits are not, and
  // they are on the screen this message sends them to.
  //
  // THE STORE IS NOT TOLD. A Partner being assigned changes nothing about what
  // the store does next — make it, press Ready, read out the code to whoever
  // turns up — and the message existed to tell them something they could not
  // act on.
  //
  // THE PARTNER IS NOT TOLD EITHER. They pressed accept a second ago and are
  // looking at the job. Being texted about your own action is the noise this
  // whole table was trimmed to remove.
  [E.PARTNER_ASSIGNED]: {
    // FIRST NAME ONLY. "Kwame has accepted your order" is what a person says.
    // A surname in an SMS is private data forwarded to a stranger's phone,
    // where it stays after the delivery is over.
    [A.CUSTOMER]: (c) =>
      `Campus Dash: ${c.partnerName} has accepted order #${c.orderNumber}. Open ${c.appUrl} to view your delivery details.`,
  },

  // NOBODY IS TEXTED WHEN A PARTNER COLLECTS. The Partner did it; the
  // customer's tracking page says "on the way" within a second; the store
  // watched them walk out of the door.
  [E.PARTNER_PICKED_UP]: {},

  // NOR WHEN ONE FINISHES. Both parties were standing there. The Partner's
  // earnings are a running balance on their dashboard, which is where a balance
  // belongs — a text after every single delivery saying GH5 had been added was
  // the most-complained-about message in the product, and it told somebody
  // something they had just watched happen.
  [E.DELIVERY_COMPLETED]: {},

  // --- Capability decisions --------------------------------------------------
  // Not order-scoped. Each one exists to get somebody to the right dashboard,
  // so each one carries the URL and says which dashboard.

  [E.VENDOR_APPROVED]: {
    [A.VENDOR]: (c) =>
      `Campus Dash: ${c.storeName} is approved. Go to ${c.appUrl} and open your Vendor Dashboard to add your menu and open the store.`,
  },

  [E.VENDOR_REJECTED]: {
    [A.VENDOR]: (c) =>
      `Campus Dash: your store application was not approved. Sign in at ${c.appUrl} to see why and resubmit.`,
  },

  [E.PARTNER_APPROVED]: {
    [A.PARTNER]: (c) =>
      `Campus Dash: your Partner application has been approved. Visit ${c.appUrl} to navigate to your Partner dashboard.`,
  },

  [E.PARTNER_REJECTED]: {
    [A.PARTNER]: (c) =>
      `Campus Dash: your Partner application was not approved. Sign in at ${c.appUrl} for details.`,
  },

  // MONEY OUT, and deliberately vague about the rail. An administrator may
  // settle by bank transfer, by MoMo or in cash, and a message that names the
  // wrong one is worse than one that names none. The dashboard is the record.
  //
  // NO PARTNER TEMPLATE, and this one is a deletion rather than an oversight.
  // A vendor is a business that reconciles a bank account and wants to be told
  // when something lands in it. A Partner is a student who is paid weekly, sees
  // every delivery and the running total on their own dashboard, and does not
  // need a text about each settlement run — particularly one that cannot say
  // how the money arrived. The earnings screen is the record, and it is the
  // screen they already look at.
  [E.PAYOUT_SENT]: {
    [A.VENDOR]: (c) =>
      `Campus Dash: a payout of ${formatPesewas(c.amountPesewas)} has been processed. See your earnings at ${c.appUrl}.`,
  },

  [E.ORDER_CANCELLED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} was cancelled. ${c.refundNote ?? 'Support will be in touch about any refund.'}`,
    [A.VENDOR]: (c) => `Campus Dash: order #${c.orderNumber} was cancelled. Stop preparation.`,
    // NO PARTNER TEMPLATE. A Partner is never texted about a cancellation: when
    // THEY cancel, the order is simply re-offered and nothing has gone wrong for
    // anybody; when an order genuinely fails, they are looking at the screen
    // that says so. The template that used to sit here was unreachable anyway —
    // PARTNER is not in this event's audience — and an unreachable template is
    // a thing somebody later wires up by mistake.
  },
};

/**
 * The copy as it is SENT: folded into the GSM-7 alphabet, because one em dash
 * turns a message into Unicode and a Unicode store alert was accepted by the
 * provider and never delivered. See ./gsm7.js.
 */
export function renderSms(event, audience, context) {
  const template = SMS_TEMPLATES[event]?.[audience];
  if (!template) return null;

  // A TEMPLATE MAY DECLINE. ORDER_READY is listed for the customer but writes
  // nothing unless they are collecting it themselves — the audience table
  // cannot express "this audience, but only for a collection", and a branch
  // inside the copy is a better place for it than a second audience map.
  // Returning null here is exactly what a missing template does: the recipient
  // is skipped before anything is sent or recorded.
  const message = template(context);
  return message ? toGsm7(message) : null;
}
