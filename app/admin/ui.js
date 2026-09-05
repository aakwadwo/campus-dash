/**
 * Shared admin building blocks.
 *
 * DENSER THAN THE MARKETPLACE, AND THE SAME PRODUCT. An operations console
 * earns its density — an operator scanning a settlement run wants rows, not
 * generous cards — so the spacing here stays tight. Everything else is shared
 * with app/ui.js: the same tokens, the same radii, the same pill buttons, the
 * same status colours, the same focus ring. The rule is that admin may be
 * compact, never foreign.
 */

export function Panel({ title, description, children, actions }) {
  return (
    <section className="rounded-card bg-surface ring-line mb-6 ring-1">
      <header className="border-line flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        {description ? <p className="text-muted text-sm">{description}</p> : null}
        {actions ? <div className="ml-auto">{actions}</div> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  name,
  type = 'text',
  required,
  defaultValue,
  placeholder,
  hint,
  ...rest
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required ? <span className="text-bad"> *</span> : null}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        placeholder={placeholder}
        className="focus:border-brand-600 rounded-input border-line-strong bg-surface text-ink placeholder:text-faint mt-1 w-full border px-3 py-2 text-sm transition-colors outline-none"
        {...rest}
      />
      {hint ? <span className="text-muted mt-1 block text-xs">{hint}</span> : null}
    </label>
  );
}

export function Select({ label, name, options, defaultValue, required, hint }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required ? <span className="text-bad"> *</span> : null}
      </span>
      <select
        name={name}
        required={required}
        defaultValue={defaultValue ?? ''}
        className="focus:border-brand-600 rounded-input border-line-strong bg-surface text-ink mt-1 w-full border px-3 py-2 text-sm transition-colors outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <span className="text-muted mt-1 block text-xs">{hint}</span> : null}
    </label>
  );
}

/**
 * Every administrative override records WHY. The database enforces a minimum
 * length, so this is required in the markup too rather than failing later.
 */
export function ReasonField({ placeholder = 'Why are you doing this?' }) {
  return (
    <Field
      label="Reason (recorded in the audit log)"
      name="reason"
      required
      minLength={3}
      placeholder={placeholder}
    />
  );
}

export function Button({ children, variant = 'primary', ...rest }) {
  const styles = {
    primary: 'bg-brand-500 text-ink hover:bg-brand-600',
    secondary: 'bg-surface text-ink ring-1 ring-line-strong hover:bg-surface-2',
    danger: 'bg-surface text-bad ring-1 ring-bad/30 hover:bg-bad-bg',
  };
  return (
    <button
      type="submit"
      className={`press rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-55 ${styles[variant]}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'neutral' }) {
  const tones = {
    neutral: 'bg-surface-2 text-muted',
    good: 'bg-good-bg text-good',
    warn: 'bg-warn-bg text-warn',
    bad: 'bg-bad-bg text-bad',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

export function Empty({ children }) {
  return <p className="text-muted py-6 text-center text-sm">{children}</p>;
}

/** Renders the outcome of the last server action, success or failure. */
export function ActionResult({ state }) {
  if (!state?.message) return null;
  return (
    <p role="status" className={`mt-3 text-sm ${state.ok ? 'text-brand-700' : 'text-bad'}`}>
      {state.message}
    </p>
  );
}

// --- Operating-console primitives -------------------------------------------

/**
 * One number, with the words needed to know whether it is good news.
 *
 * `tone` is for the number being ABNORMAL, not merely non-zero: five orders
 * today is neutral, five failed payouts is not. A dashboard that shouts about
 * ordinary activity teaches people to ignore it.
 */
export function Stat({ label, value, hint, tone = 'neutral', href }) {
  const tones = {
    neutral: 'text-ink',
    good: 'text-brand-700',
    warn: 'text-warn',
    bad: 'text-bad',
  };
  const body = (
    <>
      <p className="text-muted text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone]}`}>{value}</p>
      {hint ? <p className="text-muted mt-0.5 text-xs">{hint}</p> : null}
    </>
  );
  const className = 'block rounded-card bg-surface p-4 ring-1 ring-line transition-colors';
  return href ? (
    <a href={href} className={`${className} press hover:ring-brand-600/50`}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function StatGrid({ children }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/** A horizontally scrollable table. Wide data must never make the page scroll. */
export function Table({ head, children, minWidth = '46rem' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="text-muted text-left text-xs uppercase">
          <tr>
            {head.map((h) => (
              <th key={h} className="pb-2 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Row({ children }) {
  return <tr className="border-line border-t">{children}</tr>;
}

export function Cell({ children, mono = false, numeric = false, muted = false }) {
  return (
    <td
      className={`py-2 pr-3 ${mono ? 'font-mono text-xs' : ''} ${numeric ? 'tabular-nums' : ''} ${
        muted ? 'text-muted' : ''
      }`}
    >
      {children}
    </td>
  );
}

/**
 * A GET filter bar.
 *
 * Filters are links and query parameters, not client state, so a filtered view
 * is a URL an operator can bookmark, reload and send to somebody else. It also
 * means the server does the filtering, which is where the data is.
 */
export function FilterChip({ active, href, label }) {
  return (
    <a
      href={href}
      className={`press-sm rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
        active ? 'bg-brand-500 text-ink' : 'bg-surface ring-line hover:ring-line-strong ring-1'
      }`}
    >
      {label}
    </a>
  );
}

export function FilterBar({ children }) {
  return <div className="mb-5 flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * A label/value list for detail pages.
 *
 * Children rather than an array of tuples, deliberately. Tuples read fine but
 * put JSX inside an array literal, which is both a lint false-positive and a
 * shape React never actually sees — `Fact` is a real element with a real
 * position, so conditional rows are ordinary `{cond ? <Fact/> : null}`.
 */
export function Facts({ children }) {
  return <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{children}</dl>;
}

export function Fact({ label, value }) {
  return (
    <div className="border-line flex justify-between gap-4 border-b py-1.5">
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-right text-sm">{value ?? '-'}</dd>
    </div>
  );
}

/**
 * Says a thing is not available, as opposed to empty.
 *
 * "No vendors yet" and "vendor data could not be loaded" look identical if both
 * render as an empty table, and an operator acting on the first when it is
 * really the second makes a bad decision confidently.
 */
export function Unavailable({ children }) {
  return (
    <p className="rounded-input bg-warn-bg text-warn px-4 py-3 text-sm leading-relaxed">
      {children ?? 'This information could not be loaded.'}
    </p>
  );
}

/** Money, always from integer pesewas. Never a float, never a client calculation. */
export function Cedis({ pesewas, zero = 'GH₵0.00' }) {
  const n = Number(pesewas ?? 0);
  if (!Number.isFinite(n)) return <span className="text-muted">-</span>;
  return <span className="tabular-nums">{n === 0 ? zero : `GH₵${(n / 100).toFixed(2)}`}</span>;
}

export function age(seconds) {
  if (seconds == null) return '-';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function when(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Every classification `admin_order_board()` can put in its `attention` column.
 *
 * THIS LIST IS THE ORDER BOARD'S FILTER VOCABULARY, and it is deliberately its
 * own constant rather than a subset of ATTENTION below. The CASE expression in
 * admin_order_board() produces exactly these twelve values and nothing else, so
 * this is what `?attention=` may legally contain.
 *
 * Keep it in step with that CASE expression. If the two disagree, the board
 * quietly returns nothing for a filter that looks perfectly valid in the URL.
 */
export const ORDER_BOARD_ATTENTION = {
  DISPUTED: { label: 'Disputed', tone: 'bad' },
  SCAN_REFUSED: { label: 'Scan refused', tone: 'bad' },
  CUSTOMER_ABSENT: { label: 'Customer absent', tone: 'bad' },
  NO_PARTNER: { label: 'No Partner', tone: 'bad' },
  REFUND_PENDING: { label: 'Refund pending', tone: 'warn' },
  PAYMENT_FAILED: { label: 'Payment failed', tone: 'bad' },
  AWAITING_VENDOR: { label: 'Awaiting vendor', tone: 'warn' },
  AWAITING_PAYMENT: { label: 'Awaiting payment', tone: 'warn' },
  SEARCHING_PARTNER: { label: 'Searching Partner', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'neutral' },
  DONE: { label: 'Done', tone: 'good' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

/**
 * The shared vocabulary for "what does this order need from a person?".
 *
 * A SUPERSET, for LABELLING ONLY. The exceptions queue (`admin_exceptions`)
 * draws from three sources, and two of its `kind` values — FAILED_PAYOUT and
 * RECONCILIATION — are not order-board classifications at all: a failed payout
 * has no order, and a reconciliation discrepancy is not a state an order can be
 * in. They belong here so /admin/disputes can render one badge vocabulary
 * across all three sources.
 *
 * NEVER USE THIS TO VALIDATE `?attention=`. `admin_order_board(p_filter)`
 * compares p_filter against the CASE expression, so FAILED_PAYOUT matches
 * nothing and the board renders an empty table that is indistinguishable from
 * "no orders are in this state" — a filter that looks like it worked and did
 * not. Validate against ORDER_BOARD_ATTENTION above.
 */
export const ATTENTION = {
  ...ORDER_BOARD_ATTENTION,
  FAILED_PAYOUT: { label: 'Failed payout', tone: 'bad' },
  RECONCILIATION: { label: 'Reconciliation', tone: 'bad' },
};

/** Scan lifecycle, kept visibly separate from delivery state. */
export const SCAN_STATUS = {
  UPLOADED: { label: 'Uploaded', tone: 'neutral' },
  RELEASED: { label: 'Released to Partner', tone: 'warn' },
  REDEEMED: { label: 'Redeemed', tone: 'good' },
  REFUSED: { label: 'Refused by restaurant', tone: 'bad' },
};
