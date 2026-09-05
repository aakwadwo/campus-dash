import Link from 'next/link';
import { orderBoard, orderBoardSummary, vendors as listVendors } from '@/lib/admin';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Cedis,
  FilterBar,
  FilterChip,
  ATTENTION,
  ORDER_BOARD_ATTENTION,
  SCAN_STATUS,
  age,
} from '../ui';

export const dynamic = 'force-dynamic';

/**
 * Orders — food and scan, in one board.
 *
 * There is no separate scan-orders screen and there should not be: a scan
 * errand is an `orders` row with a different order_type, and giving it its own
 * page would let the two drift until an operator has to remember which screen
 * shows the truth. The nav's "Scan orders" entry is this page with ?type=SCAN.
 *
 * FILTERS ARE URL STATE. Every filter is a query parameter applied in the
 * database, so a filtered board is a link an operator can bookmark, reload and
 * hand to somebody else — and the browser never receives rows it will hide.
 */

const ORDER_STATUSES = [
  'SUBMITTED',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'REJECTED',
  'EXPIRED',
];
const PAYMENT_STATUSES = ['UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED'];

/** Only keeps a value the database will recognise. Anything else becomes null. */
function pick(value, allowed) {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : null;
  return v && allowed.includes(v) ? v : null;
}

export default async function AdminOrdersPage({ searchParams }) {
  const params = (await searchParams) ?? {};

  const filters = {
    // ORDER_BOARD_ATTENTION, not ATTENTION. The wider map exists so the
    // exceptions queue can label FAILED_PAYOUT and RECONCILIATION rows, and
    // neither is a state an order can be in: admin_order_board(p_filter) would
    // match no row and render an empty table that looks exactly like "no orders
    // need this" — a filter that appears to have worked and silently did not.
    attention: pick(params.attention, Object.keys(ORDER_BOARD_ATTENTION)),
    orderType: pick(params.type, ['FOOD', 'SCAN']),
    orderStatus: pick(params.status, ORDER_STATUSES),
    paymentStatus: pick(params.payment, PAYMENT_STATUSES),
    partnerState: pick(params.partner, ['ASSIGNED', 'UNASSIGNED']),
    vendorId: typeof params.vendor === 'string' && params.vendor ? params.vendor : null,
    since: typeof params.since === 'string' && params.since ? params.since : null,
    search: typeof params.q === 'string' && params.q.trim() ? params.q.trim() : null,
    limit: 200,
  };

  const [orders, summary, vendorList] = await Promise.all([
    orderBoard(filters).catch(() => null),
    orderBoardSummary().catch(() => []),
    listVendors().catch(() => []),
  ]);

  // Rebuilds the current URL with one parameter changed, so chips compose
  // instead of resetting each other.
  const url = (changes) => {
    const next = new URLSearchParams();
    const current = {
      attention: filters.attention,
      type: filters.orderType,
      status: filters.orderStatus,
      payment: filters.paymentStatus,
      partner: filters.partnerState,
      vendor: filters.vendorId,
      since: filters.since,
      q: filters.search,
      ...changes,
    };
    for (const [k, v] of Object.entries(current)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/orders?${qs}` : '/admin/orders';
  };

  const anyFilter = Object.entries(filters).some(([k, v]) => k !== 'limit' && v);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Orders</h1>
      <p className="text-muted mb-5 text-sm">
        Sorted by how much a human is needed: problems first, then work in flight, then the settled
        past.
      </p>

      {/* What needs attention — the counts are the whole board, unfiltered. */}
      <FilterBar>
        <FilterChip active={!filters.attention} href={url({ attention: null })} label="Any state" />
        {(summary ?? []).map((row) => (
          <FilterChip
            key={row.attention}
            active={filters.attention === row.attention}
            href={url({ attention: row.attention })}
            label={`${ATTENTION[row.attention]?.label ?? row.attention} (${row.count})`}
          />
        ))}
      </FilterBar>

      <FilterBar>
        <span className="text-muted text-xs font-semibold uppercase">Type</span>
        <FilterChip active={!filters.orderType} href={url({ type: null })} label="All" />
        <FilterChip
          active={filters.orderType === 'FOOD'}
          href={url({ type: 'FOOD' })}
          label="Food"
        />
        <FilterChip
          active={filters.orderType === 'SCAN'}
          href={url({ type: 'SCAN' })}
          label="Scan"
        />

        <span className="text-muted ml-4 text-xs font-semibold uppercase">Partner</span>
        <FilterChip active={!filters.partnerState} href={url({ partner: null })} label="Any" />
        <FilterChip
          active={filters.partnerState === 'ASSIGNED'}
          href={url({ partner: 'ASSIGNED' })}
          label="Assigned"
        />
        <FilterChip
          active={filters.partnerState === 'UNASSIGNED'}
          href={url({ partner: 'UNASSIGNED' })}
          label="Unassigned"
        />
      </FilterBar>

      {/* Search and the long dropdowns are a GET form: no client state, and the
          resulting URL is shareable. */}
      <form method="get" action="/admin/orders" className="mb-6 flex flex-wrap items-end gap-3">
        {filters.attention ? (
          <input type="hidden" name="attention" value={filters.attention} />
        ) : null}
        {filters.orderType ? <input type="hidden" name="type" value={filters.orderType} /> : null}
        {filters.partnerState ? (
          <input type="hidden" name="partner" value={filters.partnerState} />
        ) : null}

        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Search</span>
          <input
            name="q"
            defaultValue={filters.search ?? ''}
            placeholder="Order number or customer"
            className="border-line-strong mt-1 block w-56 rounded border px-3 py-1.5 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Vendor</span>
          <select
            name="vendor"
            defaultValue={filters.vendorId ?? ''}
            className="border-line-strong bg-surface mt-1 block w-48 rounded border px-3 py-1.5 text-sm"
          >
            <option value="">Any vendor</option>
            {(vendorList ?? []).map((v) => (
              <option key={v.vendor_id} value={v.vendor_id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Order status</span>
          <select
            name="status"
            defaultValue={filters.orderStatus ?? ''}
            className="border-line-strong bg-surface mt-1 block w-40 rounded border px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {ORDER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Payment</span>
          <select
            name="payment"
            defaultValue={filters.paymentStatus ?? ''}
            className="border-line-strong bg-surface mt-1 block w-40 rounded border px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {PAYMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Since</span>
          <input
            type="date"
            name="since"
            defaultValue={filters.since ?? ''}
            className="border-line-strong mt-1 block rounded border px-3 py-1.5 text-sm"
          />
        </label>

        <button
          type="submit"
          className="bg-brand-500 text-ink rounded px-4 py-1.5 text-sm font-semibold"
        >
          Apply
        </button>
        {anyFilter ? (
          <Link href="/admin/orders" className="text-muted py-1.5 text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel
        title={filters.orderType === 'SCAN' ? 'Scan orders' : 'Orders'}
        description={orders ? `${orders.length} shown` : undefined}
      >
        {orders === null ? (
          <Unavailable>The order board could not be loaded.</Unavailable>
        ) : orders.length === 0 ? (
          <Empty>
            {anyFilter ? 'No orders match these filters.' : 'No orders have been placed yet.'}
          </Empty>
        ) : (
          <Table
            head={[
              'Order',
              'Type',
              'Needs',
              'Vendor',
              'Customer',
              'Partner',
              'States',
              'Total',
              'Age',
            ]}
            minWidth="58rem"
          >
            {orders.map((o) => (
              <Row key={o.order_id}>
                <Cell>
                  <Link
                    href={`/admin/orders/${o.order_id}`}
                    className="text-brand-700 font-mono text-xs underline underline-offset-4"
                  >
                    {o.order_number}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={o.order_type === 'SCAN' ? 'warn' : 'neutral'}>{o.order_type}</Badge>
                </Cell>
                <Cell>
                  <Badge tone={ATTENTION[o.attention]?.tone ?? 'neutral'}>
                    {ATTENTION[o.attention]?.label ?? o.attention}
                  </Badge>
                </Cell>
                <Cell>{o.vendor_name}</Cell>
                <Cell>{o.customer_name ?? '-'}</Cell>
                <Cell>{o.partner_name ?? '-'}</Cell>
                <Cell mono muted>
                  {o.order_status}/{o.payment_status}/{o.delivery_status}
                  {o.scan_status ? (
                    <>
                      {' '}
                      <span className="text-warn">scan:{o.scan_status}</span>
                    </>
                  ) : null}
                </Cell>
                <Cell numeric>
                  <Cedis pesewas={o.total_pesewas} />
                </Cell>
                <Cell muted numeric>
                  {age(o.age_seconds)}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      {filters.orderType === 'SCAN' ? (
        <p className="text-muted text-xs">
          Scan lifecycle: UPLOADED → RELEASED (Partner assigned) → REDEEMED or REFUSED. Redemption
          is a separate act from delivery completion. See{' '}
          {Object.entries(SCAN_STATUS)
            .map(([k]) => k)
            .join(' · ')}
          .
        </p>
      ) : null}
    </>
  );
}
