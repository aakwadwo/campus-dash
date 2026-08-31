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
 * Never put a pickup code, delivery code or phone number into a message for
 * someone who is not entitled to it at that moment.
 *
 * Each template receives a context object and returns a string.
 */
export const SMS_TEMPLATES = {
  [E.ORDER_SUBMITTED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} sent to ${c.vendorName}. Waiting for them to accept.`,
    [A.VENDOR]: (c) =>
      `Campus Dash: NEW ORDER #${c.orderNumber}. Open the app to accept or reject within 60s.`,
  },

  [E.ORDER_ACCEPTED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: ${c.vendorName} accepted order #${c.orderNumber}. Pay ${formatPesewas(c.totalPesewas)} in the app to start preparation.`,
  },

  [E.ORDER_REJECTED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} could not be accepted by ${c.vendorName}. You have not been charged.`,
  },

  [E.PAYMENT_REQUIRED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} needs payment of ${formatPesewas(c.totalPesewas)}. Open the app to pay.`,
  },

  [E.PAYMENT_CONFIRMED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: payment confirmed for order #${c.orderNumber}. ${c.vendorName} is preparing your order.`,
    [A.VENDOR]: (c) => `Campus Dash: order #${c.orderNumber} is PAID. You can start preparing.`,
  },

  [E.ORDER_PREPARING]: {
    [A.CUSTOMER]: (c) => `Campus Dash: ${c.vendorName} is preparing order #${c.orderNumber}.`,
  },

  [E.ORDER_READY]: {
    [A.CUSTOMER]: (c) =>
      c.isPickup
        ? `Campus Dash: order #${c.orderNumber} is READY for pickup at ${c.vendorName}.`
        : `Campus Dash: order #${c.orderNumber} is ready. Finding a Partner to bring it to you.`,
  },

  [E.PARTNER_ASSIGNED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: ${c.partnerName} is bringing order #${c.orderNumber}. Your delivery code is ${c.deliveryCode}. Give it to them on arrival.`,
    // The vendor is deliberately NOT told the pickup code. A vendor who knew it
    // could confirm a handoff that never happened, which is the entire point of
    // the code. The Partner reads it aloud; the vendor types in what they hear.
    [A.VENDOR]: (c) =>
      `Campus Dash: a Partner is coming for order #${c.orderNumber}. Ask them for their 4-digit pickup code before handing over the food.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: delivery #${c.orderNumber} from ${c.vendorName}. Pickup code ${c.pickupCode}. Earning ${formatPesewas(c.earningsPesewas)}.`,
  },

  [E.PARTNER_PICKED_UP]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} is on the way to ${c.destinationLabel}.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: order #${c.orderNumber} collected. Deliver to ${c.destinationLabel}. Customer: ${c.customerPhone}.`,
  },

  [E.DELIVERY_COMPLETED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} delivered. Thank you for using Campus Dash.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: delivery #${c.orderNumber} completed. ${formatPesewas(c.earningsPesewas)} added to your earnings.`,
  },

  [E.ORDER_CANCELLED]: {
    [A.CUSTOMER]: (c) =>
      `Campus Dash: order #${c.orderNumber} was cancelled. ${c.refundNote ?? 'Support will be in touch about any refund.'}`,
    [A.VENDOR]: (c) => `Campus Dash: order #${c.orderNumber} was cancelled. Stop preparation.`,
    [A.PARTNER]: (c) =>
      `Campus Dash: delivery #${c.orderNumber} was cancelled. Your pickup code is no longer valid.`,
  },
};

export function renderSms(event, audience, context) {
  const template = SMS_TEMPLATES[event]?.[audience];
  return template ? template(context) : null;
}
