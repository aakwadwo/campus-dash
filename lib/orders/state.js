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
 * THE NUMBER A PERSON IS SHOWN.
 *
 * A store calls out "seven", not "CD-01043". Every order carries a queue number
 * that restarts at 1 each morning and is unique per store per day, and that is
 * the number on the customer's screen, the vendor's board and the Partner's
 * job card.
 *
 * `order_number` survives underneath as the internal reference every payment,
 * allocation and payout already keys off. It is the fallback here for the two
 * cases with no queue number: a SCAN errand, which no store ever sees, and an
 * order placed before daily numbering existed.
 */
export function orderLabel(order) {
  const daily = order?.vendor_order_no;
  if (daily !== null && daily !== undefined && daily !== '') {
    return String(daily).padStart(3, '0');
  }
  return order?.order_number ?? '';
}

/**
 * The store's share of an order, in integer pesewas: the food it sold plus the
 * pack it packed.
 *
 * On a FOOD order the pack is zero by CHECK constraint, so this is the food
 * subtotal and nothing else. On a SCAN order the food is zero (the university
 * settles it), so this is the pack when one was charged. The same expression
 * as create_order_allocations(), so the Paystack split can never route a
 * different figure from the one the ledger writes.
 */
export function vendorSharePesewas(order) {
  const subtotal = Number(order?.subtotal_pesewas ?? 0);
  const pack = Number(order?.pack_fee_pesewas ?? 0);
  if (!Number.isInteger(subtotal) || !Number.isInteger(pack)) return 0;
  return subtotal + pack;
}
