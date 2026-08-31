/**
 * How each customer-facing stage reads.
 *
 * The stage itself is computed in the database from all three state dimensions
 * together, so this file only decides wording — never which state the order is
 * actually in.
 */
export const STAGE = {
  AWAITING_VENDOR: {
    label: 'Waiting for the vendor',
    tone: 'text-amber-800',
    detail: 'They have a minute to accept. You have not been charged.',
  },
  PAYMENT_REQUIRED: {
    label: 'Ready to pay',
    tone: 'text-brand-700',
    detail: 'The vendor accepted. Pay now and they will start cooking.',
  },
  PAYMENT_PROCESSING: {
    label: 'Payment processing',
    tone: 'text-amber-800',
    detail: 'Hold on — we are confirming this with the payment provider.',
  },
  PAYMENT_FAILED: {
    label: 'Payment failed',
    tone: 'text-red-700',
    detail: 'Nothing was taken. You can try again.',
  },
  PAID_AWAITING_KITCHEN: {
    label: 'Paid',
    tone: 'text-brand-700',
    detail: 'The vendor is about to start.',
  },
  PREPARING: {
    label: 'Being prepared',
    tone: 'text-brand-700',
    detail: 'Your food is being made.',
  },
  READY: { label: 'Ready', tone: 'text-blue-700', detail: null },
  COMPLETED: { label: 'Completed', tone: 'text-muted', detail: 'Thanks for using Campus Dash.' },
  REJECTED: {
    label: 'Vendor could not take it',
    tone: 'text-red-700',
    detail: 'You have not been charged.',
  },
  EXPIRED: {
    label: 'No answer from the vendor',
    tone: 'text-red-700',
    detail: 'They did not respond in time. You have not been charged.',
  },
  CANCELLED: { label: 'Cancelled', tone: 'text-red-700', detail: null },
};
