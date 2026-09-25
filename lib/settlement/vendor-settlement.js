/**
 * Paystack vendor settlements, as rules with no I/O.
 *
 * THREE DIFFERENT FACTS, AND THIS FILE ONLY EVER SPEAKS TO THE THIRD.
 *
 *   PAYMENT      the customer paid. Campus Dash's payments row.
 *   SPLIT        Paystack credited the store's subaccount with its share at the
 *                charge. Proved by the signed charge.success split shares; see
 *                split-record.js. It is NOT a settlement and NOT a payout.
 *   SETTLEMENT   Paystack later paid the subaccount's balance out to the
 *                store's bank or mobile money. Proved only by a settlement
 *                whose own transaction list contains the charge.
 *
 * Campus Dash does not start, schedule or control a settlement, and Paystack
 * sends no webhook for one, so nothing here is stored. Every answer is read
 * from Paystack when the screen asks, and an answer Paystack could not give is
 * UNAVAILABLE, never "none".
 */

/** What an administrator reads for each settlement status. */
export const SETTLEMENT_LABEL = {
  SETTLED: { label: 'Settled', tone: 'good' },
  PROCESSING: { label: 'Processing', tone: 'warn' },
  PENDING: { label: 'Pending', tone: 'warn' },
  FAILED: { label: 'Failed', tone: 'bad' },
  UNKNOWN: { label: 'Unrecognised status', tone: 'neutral' },
};

/**
 * An order's vendor settlement, as one state:
 *
 *   SETTLED / PROCESSING / PENDING / FAILED / UNKNOWN
 *               a settlement containing this charge exists, with that status;
 *   NOT_FOUND   Paystack was read and no settlement it listed contains this
 *               charge. It has not been settled YET, as far as Paystack says;
 *   INCOMPLETE  not found in what was read, but not everything could be read,
 *               so absence is not established either;
 *   UNAVAILABLE Paystack could not be asked;
 *   NOT_SPLIT   the store's share was not split, so there is no Paystack
 *               settlement to look for. It is a manual vendor payment.
 */
export const ORDER_SETTLEMENT_LABEL = {
  ...SETTLEMENT_LABEL,
  NOT_FOUND: { label: 'Not settled yet', tone: 'warn' },
  INCOMPLETE: { label: 'Not found in what Paystack returned', tone: 'neutral' },
  UNAVAILABLE: { label: 'Could not be read from Paystack', tone: 'neutral' },
  NOT_SPLIT: { label: 'Not a Paystack split', tone: 'neutral' },
};

function timeOf(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The date a settlement is known by: its settlement date, or when it was made. */
export function settlementTime(settlement) {
  return timeOf(settlement?.settlementDate) ?? timeOf(settlement?.createdAt);
}

/** Newest first. A settlement with no date at all sorts last. */
export function newestFirst(settlements) {
  return [...(settlements ?? [])].sort(
    (a, b) => (settlementTime(b) ?? -Infinity) - (settlementTime(a) ?? -Infinity)
  );
}

/**
 * The summary line for one store: the newest settlement of any status, and
 * the newest one Paystack reports as SETTLED. They are often the same; when
 * they are not, the newest is the one still in flight or failed.
 */
export function settlementSummary(settlements) {
  const ordered = newestFirst(settlements);
  return {
    latest: ordered[0] ?? null,
    lastSettled: ordered.find((s) => s.status === 'SETTLED') ?? null,
    count: ordered.length,
  };
}

/**
 * Finds the settlement that contains one charge.
 *
 * Only settlements dated on or after the day the customer paid can contain
 * it, so those are read, OLDEST FIRST: the first one to list the reference is
 * the one that carried it. Settlements with no date are read too, last,
 * because excluding them would be a guess.
 *
 * `transactionsFor(id)` returns { transactions, truncated }. Reading stops at
 * `maxSettlements`, and a reference not found in a truncated list, or beyond
 * the bound, is INCOMPLETE rather than NOT_FOUND.
 */
export async function locateCharge({
  reference,
  paidAt,
  settlements,
  transactionsFor,
  maxSettlements = 8,
  listComplete = true,
}) {
  const paidDay = timeOf(paidAt);
  const dayStart = paidDay === null ? null : paidDay - (paidDay % 86_400_000);

  const dated = [];
  const undated = [];
  for (const s of settlements ?? []) {
    const t = settlementTime(s);
    if (t === null) undated.push(s);
    else if (dayStart === null || t >= dayStart) dated.push(s);
  }
  dated.sort((a, b) => settlementTime(a) - settlementTime(b));
  const candidates = [...dated, ...undated];

  let incomplete = !listComplete || candidates.length > maxSettlements;
  let searched = 0;
  for (const settlement of candidates.slice(0, maxSettlements)) {
    const { transactions, truncated } = await transactionsFor(settlement.id);
    searched += 1;
    const transaction = (transactions ?? []).find((t) => t.reference === reference) ?? null;
    if (transaction) return { state: settlement.status, settlement, transaction, searched };
    if (truncated) incomplete = true;
  }

  return {
    state: incomplete ? 'INCOMPLETE' : 'NOT_FOUND',
    settlement: null,
    transaction: null,
    searched,
  };
}

/**
 * A settlement's transactions, each matched to the Campus Dash order it paid
 * for when its reference is one of our payment ids.
 *
 * `payments` are { id, order_id, order_number } for this store. A transaction
 * we cannot match is kept and marked, not dropped: a settlement is Paystack's
 * record, and hiding lines of it would make the total disagree with the rows.
 */
export function matchTransactions(transactions, payments) {
  const byReference = new Map((payments ?? []).map((p) => [p.id, p]));
  return (transactions ?? []).map((t) => {
    const payment = t.reference ? byReference.get(t.reference) : null;
    return {
      ...t,
      orderId: payment?.order_id ?? null,
      orderNumber: payment?.order_number ?? null,
      vendorSharePesewas: payment?.vendor_share_pesewas ?? null,
    };
  });
}

/**
 * A timestamp in Ghana time, labelled as such. Africa/Accra is UTC+0 with no
 * daylight saving, but a settlement time is evidence and says which clock it
 * is on rather than leaving the reader to assume one.
 */
export function accraTime(value) {
  const t = timeOf(value);
  if (t === null) return null;
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Accra',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(t));
  return `${text} Accra`;
}
