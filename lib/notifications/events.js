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
});

export const AUDIENCE = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  VENDOR: 'VENDOR',
  PARTNER: 'PARTNER',
});

export const CHANNEL = Object.freeze({
  SMS: 'SMS',
  IN_APP: 'IN_APP',
});
