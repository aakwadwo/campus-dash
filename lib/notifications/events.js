/**
 * Domain notification events. Business logic emits these; the notification
 * service decides which channels they go out on.
 *
 * V1 delivers over SMS only. Adding on-platform alerts or (later) push means
 * adding a channel here, not editing order logic.
 */
export const NOTIFICATION_EVENT = Object.freeze({
  ORDER_SUBMITTED: 'ORDER_SUBMITTED',
  ORDER_ACCEPTED: 'ORDER_ACCEPTED',
  ORDER_REJECTED: 'ORDER_REJECTED',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  ORDER_PREPARING: 'ORDER_PREPARING',
  ORDER_READY: 'ORDER_READY',
  PARTNER_ASSIGNED: 'PARTNER_ASSIGNED',
  PARTNER_PICKED_UP: 'PARTNER_PICKED_UP',
  DELIVERY_COMPLETED: 'DELIVERY_COMPLETED',
  ORDER_CANCELLED: 'ORDER_CANCELLED',

  // Broadcast to every eligible, available Partner when a paid order needs
  // carrying. Deliberately says almost nothing: see the template.
  DELIVERY_AVAILABLE: 'DELIVERY_AVAILABLE',

  // Capability decisions. Not order-scoped, so they carry no orderId and are
  // deduped on the subject instead.
  VENDOR_APPROVED: 'VENDOR_APPROVED',
  VENDOR_REJECTED: 'VENDOR_REJECTED',
  PARTNER_APPROVED: 'PARTNER_APPROVED',
  PARTNER_REJECTED: 'PARTNER_REJECTED',

  // Money out. One event, both payee types.
  PAYOUT_SENT: 'PAYOUT_SENT',

  // OPERATIONAL, not customer-facing: a vendor's Paystack subaccount now
  // exists, so their share of every future charge is routed to them at the
  // moment the customer pays. Goes to whoever runs the pilot, by email, because
  // it is a fact about the platform's plumbing rather than about an order.
  VENDOR_SUBACCOUNT_CREATED: 'VENDOR_SUBACCOUNT_CREATED',
});

export const AUDIENCE = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  PARTNER: 'PARTNER',
  // The people running the pilot. Never a template in SMS_TEMPLATES: an
  // administrator is told things by email, and no SMS_TEMPLATES entry exists
  // for this audience, so renderSms() returns nothing for it by construction.
  ADMIN: 'ADMIN',
});

export const CHANNEL = Object.freeze({
  SMS: 'SMS',
  IN_APP: 'IN_APP',
  EMAIL: 'EMAIL',
});
