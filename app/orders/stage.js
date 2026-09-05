/**
 * How each customer-facing stage reads.
 *
 * `tone` is the text colour and `badge` the pill tone, both semantic tokens so
 * that light and dark modes are handled by the token layer rather than by a
 * second copy of this table.
 *
 * The stage itself is computed in the database from all three state dimensions
 * together, so this file only decides wording — never which state the order is
 * actually in.
 */
export const STAGE = {
  AWAITING_VENDOR: {
    label: 'Waiting for the vendor',
    tone: 'text-warn',
    badge: 'warn',
    detail: 'They have a minute to accept. You have not been charged.',
  },
  PAYMENT_REQUIRED: {
    label: 'Ready to pay',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'The vendor accepted. Pay now and they will start cooking.',
  },
  PAYMENT_PROCESSING: {
    label: 'Payment processing',
    tone: 'text-warn',
    badge: 'warn',
    detail: 'Hold on. We are confirming this with the payment provider.',
  },
  PAYMENT_FAILED: {
    label: 'Payment failed',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'Nothing was taken. You can try again.',
  },
  PAID_AWAITING_KITCHEN: {
    label: 'Paid',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'The vendor is about to start.',
  },
  PREPARING: {
    label: 'Being prepared',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Your food is being made.',
  },
  READY: {
    label: 'Ready to collect',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Go to the vendor and pick it up.',
  },

  // Delivery, described as STEPS. There is no GPS, so the customer is never
  // told where the Partner is — only what has happened so far.
  SEARCHING_PARTNER: {
    label: 'Finding a Partner',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Your food is cooked and waiting. We are looking for someone to bring it.',
  },
  PARTNER_ASSIGNED: {
    label: 'Partner on the way to the vendor',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'They are collecting your order now.',
  },
  ON_THE_WAY: {
    label: 'On the way to you',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Have your delivery code ready. The Partner will ask for it.',
  },
  NO_PARTNER: {
    label: 'No Partner available',
    tone: 'text-warn',
    badge: 'warn',
    detail:
      'Nobody has taken this yet. Your food is made and paid for, so choose what to do below.',
  },
  CUSTOMER_ABSENT: {
    label: 'Could not reach you',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'The Partner waited and could not reach you. Campus Dash support will be in touch.',
  },
  COMPLETED: {
    label: 'Completed',
    tone: 'text-muted',
    badge: 'neutral',
    detail: 'Thanks for using Campus Dash.',
  },
  REJECTED: {
    label: 'Vendor could not take it',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'You have not been charged.',
  },
  EXPIRED: {
    label: 'No answer from the vendor',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'They did not respond in time. You have not been charged.',
  },
  CANCELLED: { label: 'Cancelled', tone: 'text-bad', badge: 'bad', detail: null },
};
