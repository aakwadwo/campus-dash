// Relative, with extensions, so this module is importable by the plain Node
// test runner as well as by the Next bundler. The SMS copy is worth testing
// directly rather than only through a running server.
import { NOTIFICATION_EVENT as E, AUDIENCE as A } from './events.js';
import { formatPesewas } from '../util/money.js';

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
  [E.PAYMENT_CONFIRMED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: payment confirmed for order #${c.orderNumber}. ${c.vendorName} is preparing it now.`,
    [A.VENDOR]: (c) =>
      `Campus Dash: NEW PAID ORDER #${c.orderNumber} — ${c.itemCount} item${c.itemCount === 1 ? '' : 's'}, ${c.isPickup ? 'collection' : 'delivery'}. Start preparing: ${c.appUrl}/vendor`,
  },

  [E.ORDER_PREPARING]: {
    [A.CUSTOMER]: (c) => `Campus Dash: ${c.vendorName} is preparing order #${c.orderNumber}.`,
  },

  // FOR A COLLECTION this also tells the customer how the handoff works, because
  // the code they will be asked for does not exist until this moment and they
  // are about to walk to a counter expecting to just be handed food.
  [E.ORDER_READY]: {
    [A.CUSTOMER]: (c) =>
      c.isPickup
        ? `Campus Dash: order #${c.orderNumber} is ready at ${c.vendorName}. They will give you a 4-digit code — enter it in the app to finish.`
        : `Campus Dash: order #${c.orderNumber} is ready. Your Partner is collecting it now.`,
  },

  // Every available Partner gets this, so it says as little as it possibly
  // can: no customer, no destination, no name, no amount owed to anybody. What
  // it does is get somebody to open their dashboard, where the full offer sits
  // behind their own session.
  [E.DELIVERY_AVAILABLE]: {
    [A.PARTNER]: (c) =>
      `Campus Dash: an order is available. Open ${c.appUrl}/partner/offers to take it.`,
  },

  // FIRST NAME ONLY. "Kwame has accepted your order" is what a person says.
  // A surname in an SMS is private data forwarded to a stranger's phone, where
  // it stays after the delivery is over.
  [E.PARTNER_ASSIGNED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: ${c.partnerName} has accepted order #${c.orderNumber}. Your delivery code is ${c.deliveryCode}. Give it to them on arrival.`,
    // THE VENDOR NOW HOLDS THE PICKUP CODE, and is still not sent it here. It
    // is on their order screen, behind their own session; an SMS is a copy in a
    // second place, and a handoff secret should live in one.
    [A.VENDOR]: (c) =>
      `Campus Dash: a Partner is coming for order #${c.orderNumber}. Open the order for the pickup code to read out.`,
    // No pickup code — the Partner types in what the vendor reads them. NO
    // CUSTOMER NAME AND NO CUSTOMER PHONE NUMBER either: both are on the
    // dashboard, gated on this Partner still being the assigned one, and an
    // SMS outlives that gate.
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} from ${c.vendorName} is yours. You earn ${formatPesewas(c.earningsPesewas)}. Details in the app; wait for the store to mark it ready.`,
  },

  [E.PARTNER_PICKED_UP]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} is on the way to ${c.destinationLabel}.`,
    // NO CUSTOMER PHONE NUMBER. It was here, and it should not have been: an
    // SMS is forwardable, screenshottable and permanent, and it survives the
    // delivery it was sent for. The number is on the Partner's dashboard,
    // behind an authorisation that expires when the delivery does.
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} collected. Complete it in the app on arrival.`,
  },

  [E.DELIVERY_COMPLETED]: {
    [A.CUSTOMER]: (c) => `Campus Dash: order #${c.orderNumber} delivered. Thanks for ordering.`,
    // "ADDED TO YOUR EARNINGS", never "sent" or "paid". The money is in the
    // ledger; it reaches a phone on the weekly run. Saying otherwise would have
    // somebody checking a MoMo balance that is not going to move today.
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} completed. ${formatPesewas(c.earningsPesewas)} added to your earnings balance. Thank you.`,
  },

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
  [E.PAYOUT_SENT]: {
    [A.VENDOR]: (c) =>
      `Campus Dash: a payout of ${formatPesewas(c.amountPesewas)} has been processed. See your earnings at ${c.appUrl}.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: a payout of ${formatPesewas(c.amountPesewas)} has been processed. See your earnings at ${c.appUrl}.`,
  },

  [E.ORDER_CANCELLED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} was cancelled. ${c.refundNote ?? 'Support will be in touch about any refund.'}`,
    [A.VENDOR]: (c) => `Campus Dash: order #${c.orderNumber} was cancelled. Stop preparation.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} was cancelled. Your pickup code is no longer valid.`,
  },
};

export function renderSms(event, audience, context) {
  const template = SMS_TEMPLATES[event]?.[audience];
  return template ? template(context) : null;
}
