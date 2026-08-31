/**
 * Order state. Three INDEPENDENT dimensions — never collapse them into one
 * field, and never use delivery state as a proxy for order state. A failed
 * delivery does not mean the food order failed; the food still exists and the
 * customer may still collect it.
 *
 * These constants mirror the Postgres enums created in the Phase 2 migrations.
 * The database is authoritative; this file exists so application code and the
 * schema cannot drift silently.
 */

export const ORDER_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  ACCEPTED: 'ACCEPTED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
  CANCELLED_BY_VENDOR: 'CANCELLED_BY_VENDOR',
});

export const PAYMENT_STATUS = Object.freeze({
  UNPAID: 'UNPAID',
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  REFUND_PENDING: 'REFUND_PENDING',
  REFUNDED: 'REFUNDED',
});

export const DELIVERY_STATUS = Object.freeze({
  NONE: 'NONE',
  SEARCHING: 'SEARCHING',
  ASSIGNED: 'ASSIGNED',
  PICKED_UP: 'PICKED_UP',
  DELIVERED: 'DELIVERED',
  FAILED_NO_PARTNER: 'FAILED_NO_PARTNER',
  FAILED_CUSTOMER_ABSENT: 'FAILED_CUSTOMER_ABSENT',
});

export const FULFILMENT_TYPE = Object.freeze({
  PICKUP: 'PICKUP',
  DELIVERY: 'DELIVERY',
});

/**
 * Legal transitions. Enforced in the database via conditional UPDATEs
 * (`WHERE order_status = <from>`); this map lets the application reject an
 * impossible transition before it reaches the database, and lets the admin UI
 * show only the moves that exist.
 */
export const ORDER_STATUS_TRANSITIONS = Object.freeze({
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED_BY_VENDOR', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED_BY_VENDOR'],
  READY: ['COMPLETED', 'CANCELLED_BY_VENDOR'],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  CANCELLED_BY_VENDOR: [],
});

export const PAYMENT_STATUS_TRANSITIONS = Object.freeze({
  UNPAID: ['PENDING'],
  PENDING: ['PAID', 'FAILED'],
  PAID: ['REFUND_PENDING'],
  FAILED: ['PENDING'],
  REFUND_PENDING: ['REFUNDED', 'PAID'],
  REFUNDED: [],
});

export const DELIVERY_STATUS_TRANSITIONS = Object.freeze({
  NONE: ['SEARCHING'],
  SEARCHING: ['ASSIGNED', 'FAILED_NO_PARTNER'],
  // ASSIGNED -> SEARCHING is the Partner-cancellation path: same order, same
  // payment, same vendor preparation. Only the assignment and pickup code reset.
  ASSIGNED: ['PICKED_UP', 'SEARCHING'],
  PICKED_UP: ['DELIVERED', 'FAILED_CUSTOMER_ABSENT', 'SEARCHING'],
  DELIVERED: [],
  FAILED_NO_PARTNER: ['SEARCHING'],
  FAILED_CUSTOMER_ABSENT: ['SEARCHING', 'DELIVERED'],
});

/** Terminal order states — no further movement, and no new payment attempts. */
export const TERMINAL_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.COMPLETED,
  ORDER_STATUS.REJECTED,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.CANCELLED_BY_VENDOR,
]);

export function canTransition(map, from, to) {
  return Boolean(map[from]?.includes(to));
}

export function isTerminalOrderStatus(status) {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/**
 * How long a vendor has to accept or reject before the order auto-expires.
 * No payment is taken for an auto-rejected order.
 */
export const VENDOR_RESPONSE_WINDOW_SECONDS = 60;
