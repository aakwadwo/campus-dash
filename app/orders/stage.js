/**
 * How each customer-facing stage reads.
 *
 * `tone` is the text colour and `badge` the pill tone, both semantic tokens, so
 * a palette change happens in one place rather than in a second copy of this
 * table.
 *
 * The stage itself is computed in the database from all three state dimensions
 * together, so this file only decides wording — never which state the order is
 * actually in.
 *
 * THE LANGUAGE IS WHAT A PERSON WOULD SAY. "Kwame is on the way", not
 * "delivery_status: PICKED_UP". Nothing here names a state machine.
 */
export const STAGE = {
  // An order nobody has paid for. It exists, it is priced, and it is one tap
  // from real — so it leads with the tap.
  PAYMENT_REQUIRED: {
    label: 'Ready to pay',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Pay now and the store starts preparing it.',
  },
  PAYMENT_PROCESSING: {
    label: 'Confirming your payment',
    tone: 'text-warn',
    badge: 'warn',
    detail: 'Hold on. We are checking this with the payment provider.',
  },
  PAYMENT_FAILED: {
    label: 'Payment did not go through',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'Nothing was taken. You can try again.',
  },
  PAID_AWAITING_KITCHEN: {
    label: 'Paid',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'The store has your order.',
  },
  // --- Meal Scan -------------------------------------------------------------
  // The store has to look at the scan before it starts cooking, and on a
  // Partner order before anybody is even sent for. That is a real wait and it
  // used to read simply "Being prepared", which was wrong about what was
  // happening and gave somebody nothing to expect.
  SCAN_AWAITING_CHECK: {
    label: 'Checking your Meal Scan',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'The store is verifying it. Your order starts as soon as they approve it.',
  },
  // THE ORDER IS OVER, and saying so gently would be the unkind version: the
  // money is gone and the only way forward is a new order. The screen puts
  // "Order again" under this.
  SCAN_INVALID: {
    label: 'Meal Scan not accepted',
    tone: 'text-bad',
    badge: 'bad',
    detail:
      'The store could not accept this Meal Scan, so the order was cancelled. It cannot be refunded. Place a new order with a valid Meal Scan.',
  },

  PREPARING: {
    label: 'Being prepared',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Your order is being made.',
  },
  // PAID, BEING MADE, AND A PARTNER IS ALREADY BEING LOOKED FOR. Dispatch opens
  // at payment rather than at ready, so this is most of the wait on a Partner
  // order and it used to read simply "Being prepared" — which was true and told
  // somebody nothing about the half of the process they were actually waiting
  // on. The countdown belongs here as much as it does after the food is made.
  PREPARING_SEARCHING: {
    label: 'Being prepared',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Your order is being made, and we are finding a Partner to bring it.',
  },
  // Paid, cooking, and somebody has already agreed to bring it. Worth its own
  // wording: "a Partner has it" is the reassurance a customer is waiting for,
  // and it arrives long before the food is ready.
  PREPARING_PARTNER_ASSIGNED: {
    label: 'Being prepared',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'A Partner has accepted your order and will collect it when it is ready.',
  },
  READY: {
    label: 'Ready to collect',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Go to the store. They will give you a 4-digit code to enter here.',
  },

  // Delivery, described as STEPS. There is no GPS, so the customer is never
  // told where the Partner is — only what has happened so far.
  // THE FOOD IS MADE. Leading with that matters: this stage used to say
  // "Finding a Partner" alone, and somebody reading it had no idea whether
  // their lunch was still on a hotplate or sitting on a counter going cold.
  // What is outstanding is the Partner, and the label now says both.
  SEARCHING_PARTNER: {
    label: 'Your order is ready',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'It is made and waiting at the store. We are finding a Partner to bring it.',
  },
  PARTNER_ASSIGNED: {
    label: 'Your Partner is collecting it',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'They are at the store picking your order up now.',
  },
  ON_THE_WAY: {
    label: 'On the way to you',
    tone: 'text-brand-700',
    badge: 'brand',
    detail: 'Have your code ready. Your Partner will ask for it on arrival.',
  },
  NO_PARTNER: {
    label: 'No Partner available',
    tone: 'text-warn',
    badge: 'warn',
    detail:
      'Nobody has taken this yet. Your order is made and paid for, so choose what to do below.',
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
  CANCELLED: {
    label: 'Cancelled',
    tone: 'text-bad',
    badge: 'bad',
    detail: null,
  },

  // --- Orders from before paid-first ordering --------------------------------
  // A store used to answer a doorbell before anybody paid. These three describe
  // states nothing new can reach, and they stay so an old order in somebody's
  // history still reads as a sentence rather than an enum.
  AWAITING_VENDOR: {
    label: 'Waiting for the store',
    tone: 'text-warn',
    badge: 'warn',
    detail: 'You have not been charged.',
  },
  REJECTED: {
    label: 'The store could not take it',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'You have not been charged.',
  },
  EXPIRED: {
    label: 'No answer from the store',
    tone: 'text-bad',
    badge: 'bad',
    detail: 'You have not been charged.',
  },
};

/**
 * The stages where something is still expected to happen.
 *
 * Used to split the order list into "in progress" and "past", and to decide
 * whether a screen should keep polling. An unpaid order counts as live: it is
 * one tap from real and the customer is looking at that tap.
 */
export const LIVE_STAGES = new Set([
  'PAYMENT_REQUIRED',
  'PAYMENT_PROCESSING',
  'PAID_AWAITING_KITCHEN',
  // Something is still expected to happen: somebody at a counter has to look
  // at the scan. SCAN_INVALID is deliberately NOT here — it is the end.
  'SCAN_AWAITING_CHECK',
  'PREPARING',
  'PREPARING_SEARCHING',
  'PREPARING_PARTNER_ASSIGNED',
  'READY',
  'SEARCHING_PARTNER',
  'PARTNER_ASSIGNED',
  'ON_THE_WAY',
  'NO_PARTNER',
  'AWAITING_VENDOR',
]);
