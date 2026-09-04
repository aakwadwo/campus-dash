import Link from 'next/link';
import { ledger, ledgerTotals, vendors as listVendors } from '@/lib/admin';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Cedis,
  Stat,
  StatGrid,
  FilterBar,
  FilterChip,
  when,
} from '../ui';

export const dynamic = 'force-dynamic';

const ALLOCATION_TONE = {
  PENDING: 'neutral',
  ELIGIBLE: 'warn',
  SETTLING: 'warn',
  SETTLED: 'good',
  CANCELLED: 'bad',
};
const PAYOUT_TONE = {
  PENDING: 'neutral',
  PROCESSING: 'warn',
  PAID: 'good',
  FAILED: 'bad',
  CANCELLED: 'neutral',
  REVERSED: 'bad',
};

const PAYEES = ['VENDOR', 'PARTNER', 'PLATFORM'];
const ALLOC_STATES = ['PENDING', 'ELIGIBLE', 'SETTLING', 'SETTLED', 'CANCELLED'];

function pick(value, allowed) {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : null;
  return v && allowed.includes(v) ? v : null;
}

/**
 * Finance — where every cedi is.
 *
 * One row per allocation, which is the unit the ledger actually works in. An
 * order appears once per payee, and the three of them sum to what the customer
 * paid; that is the invariant the balance trigger enforces in the database, and
 * this page is where a human can see it holding.
 *
 * PAYSTACK'S FEE IS NOT IN HERE, and its absence is deliberate rather than an
 * omission: the schema records the gross collected and has no fee column
 * anywhere, so a processing fee cannot be netted off a vendor's or a Partner's
 * entitlement. It lands on the platform's share because that is the only place
 * left for it to land. Saying so in words beats inventing a number.
 */
export default async function AdminFinancePage({ searchParams }) {
  const params = (await searchParams) ?? {};

  const filters = {
    orderType: pick(params.type, ['FOOD', 'SCAN']),
    payeeType: pick(params.payee, PAYEES),
    allocationStatus: pick(params.state, ALLOC_STATES),
    vendorId: typeof params.vendor === 'string' && params.vendor ? params.vendor : null,
    since: typeof params.since === 'string' && params.since ? params.since : null,
    limit: 300,
  };

  const [rows, totals, vendorList] = await Promise.all([
    ledger(filters).catch(() => null),
    ledgerTotals({ orderType: filters.orderType, since: filters.since }).catch(() => null),
    listVendors().catch(() => []),
  ]);

  const url = (changes) => {
    const next = new URLSearchParams();
    const current = {
      type: filters.orderType,
      payee: filters.payeeType,
      state: filters.allocationStatus,
      vendor: filters.vendorId,
      since: filters.since,
      ...changes,
    };
    for (const [k, v] of Object.entries(current)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/finance?${qs}` : '/admin/finance';
  };

  const anyFilter = Object.entries(filters).some(([k, v]) => k !== 'limit' && v);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Finance</h1>
      <p className="text-muted mb-5 text-sm">
        Every allocation: who is owed what, on which order, and whether it has moved.
      </p>

      {totals === null ? (
        <Unavailable>The finance totals could not be loaded.</Unavailable>
      ) : (
        <StatGrid>
          <Stat
            label="Orders"
            value={totals.orders ?? 0}
            hint={filters.orderType ?? 'food and scan'}
          />
          <Stat
            label="Customers paid"
            value={<Cedis pesewas={totals.gross_pesewas} />}
            hint="Gross"
          />
          <Stat
            label="Vendors"
            value={<Cedis pesewas={totals.vendor_pesewas} />}
            hint="Food sold through us"
          />
          <Stat
            label="Partners"
            value={<Cedis pesewas={totals.partner_pesewas} />}
            hint="Delivery fees"
          />
          {/* CAMPUS DASH'S SHARE IS TWO NUMBERS, NOT ONE.
              The PLATFORM allocation holds the service fee AND, until a Partner
              is settled, the delivery fee — because at payment time there is no
              Partner row to hold it. Reporting the whole allocation as "service
              fees" credited Campus Dash with every undelivered delivery fee in
              the pilot. */}
          <Stat
            label="Campus Dash"
            value={<Cedis pesewas={totals.platform_pesewas} />}
            hint="Service fees earned"
          />
          <Stat
            label="Delivery fees held"
            value={<Cedis pesewas={totals.delivery_fees_held_pesewas} />}
            tone={Number(totals.delivery_fees_held_pesewas ?? 0) > 0 ? 'warn' : 'neutral'}
            hint="Owed to Partners, not yet settled"
          />
          <Stat
            label="Allocated"
            value={<Cedis pesewas={totals.allocated_pesewas} />}
            tone={
              Number(totals.allocated_pesewas ?? 0) === Number(totals.gross_pesewas ?? 0)
                ? 'good'
                : 'bad'
            }
            hint={
              Number(totals.allocated_pesewas ?? 0) === Number(totals.gross_pesewas ?? 0)
                ? 'Balances against gross'
                : 'Does NOT balance'
            }
          />
        </StatGrid>
      )}

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

        <span className="text-muted ml-4 text-xs font-semibold uppercase">Payee</span>
        <FilterChip active={!filters.payeeType} href={url({ payee: null })} label="All" />
        {PAYEES.map((p) => (
          <FilterChip
            key={p}
            active={filters.payeeType === p}
            href={url({ payee: p })}
            label={p === 'PLATFORM' ? 'Campus Dash' : p.charAt(0) + p.slice(1).toLowerCase()}
          />
        ))}
      </FilterBar>

      <FilterBar>
        <span className="text-muted text-xs font-semibold uppercase">Allocation</span>
        <FilterChip active={!filters.allocationStatus} href={url({ state: null })} label="Any" />
        {ALLOC_STATES.map((s) => (
          <FilterChip
            key={s}
            active={filters.allocationStatus === s}
            href={url({ state: s })}
            label={s}
          />
        ))}
      </FilterBar>

      <form method="get" action="/admin/finance" className="mb-6 flex flex-wrap items-end gap-3">
        {filters.orderType ? <input type="hidden" name="type" value={filters.orderType} /> : null}
        {filters.payeeType ? <input type="hidden" name="payee" value={filters.payeeType} /> : null}
        {filters.allocationStatus ? (
          <input type="hidden" name="state" value={filters.allocationStatus} />
        ) : null}
        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Vendor</span>
          <select
            name="vendor"
            defaultValue={filters.vendorId ?? ''}
            className="mt-1 block w-48 rounded border border-black/15 bg-white px-3 py-1.5 text-sm"
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
          <span className="text-muted text-xs font-semibold uppercase">Since</span>
          <input
            type="date"
            name="since"
            defaultValue={filters.since ?? ''}
            className="mt-1 block rounded border border-black/15 px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="bg-brand-500 text-ink rounded px-4 py-1.5 text-sm font-semibold"
        >
          Apply
        </button>
        {anyFilter ? (
          <Link href="/admin/finance" className="text-muted py-1.5 text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title="Ledger" description={rows ? `${rows.length} allocations` : undefined}>
        {rows === null ? (
          <Unavailable>The ledger could not be loaded.</Unavailable>
        ) : rows.length === 0 ? (
          <Empty>
            {anyFilter
              ? 'No allocations match these filters.'
              : 'No money has been allocated yet — allocations are written when a payment is confirmed.'}
          </Empty>
        ) : (
          <Table
            head={[
              'Order',
              'Type',
              'Payee',
              'Who',
              'Amount',
              'Allocation',
              'Payout',
              'Settled',
              'Placed',
            ]}
            minWidth="62rem"
          >
            {rows.map((r) => (
              <Row key={r.allocation_id}>
                <Cell>
                  <Link
                    href={`/admin/orders/${r.order_id}`}
                    className="text-brand-700 font-mono text-xs underline underline-offset-4"
                  >
                    {r.order_number}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={r.order_type === 'SCAN' ? 'warn' : 'neutral'}>{r.order_type}</Badge>
                </Cell>
                <Cell>{r.payee_type}</Cell>
                <Cell>{r.payee_name ?? '—'}</Cell>
                <Cell numeric>
                  <Cedis pesewas={r.amount_pesewas} />
                </Cell>
                <Cell>
                  <Badge tone={ALLOCATION_TONE[r.allocation_status] ?? 'neutral'}>
                    {r.allocation_status}
                  </Badge>
                </Cell>
                <Cell>
                  {r.payout_status ? (
                    <Badge tone={PAYOUT_TONE[r.payout_status] ?? 'neutral'}>
                      {r.payout_status}
                    </Badge>
                  ) : (
                    <span className="text-muted text-xs">not in a run</span>
                  )}
                </Cell>
                <Cell muted>{when(r.settled_at)}</Cell>
                <Cell muted>{when(r.order_created_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="How an order divides">
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Food order</h3>
            <p className="text-muted text-sm leading-relaxed">
              Campus Dash sells the food. The customer pays the food price, a 5% service fee on that
              food, and the delivery fee. The vendor is owed the food, the Partner the delivery, and
              Campus Dash the service fee.
            </p>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Scan delivery</h3>
            <p className="text-muted text-sm leading-relaxed">
              Campus Dash sells only the errand. The meal was already paid for through the campus
              system, so the food is GH₵0 here and{' '}
              <strong>no vendor allocation row is written at all</strong> — not a zero-value one.
              The Partner is owed the delivery fee, Campus Dash the flat scan service fee.
            </p>
          </div>
        </div>
        <div className="mt-4 border-t border-black/5 pt-3">
          <h3 className="mb-2 text-sm font-semibold">
            Why &ldquo;Campus Dash&rdquo; is smaller than the PLATFORM rows below
          </h3>
          <p className="text-muted text-sm leading-relaxed">
            At payment time no Partner exists yet — dispatch has not opened — so the ledger writes
            two rows, and everything that is not the food goes on the PLATFORM one: the service fee{' '}
            <em>and</em> the delivery fee. When a delivery is completed, the Partner&apos;s share is
            carved out of that row into a PARTNER row naming the person who walked it. Until then
            the delivery fee is sitting in the platform&apos;s allocation as a{' '}
            <strong>liability, not revenue</strong>, and it is reported above as{' '}
            <strong>Delivery fees held</strong>. The three figures — service fees earned, delivery
            fees held, and what Partners have already been allocated — are what the PLATFORM and
            PARTNER rows below add up to.
          </p>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            The <strong>Allocated</strong> tile is unaffected by that split and still balances
            against gross: it is the sum of every allocation row, however it is later described.
          </p>
          <p className="text-muted mt-3 text-xs">
            Paystack&apos;s processing fee is a platform expense. It is not recorded in this ledger
            and is never deducted from a vendor&apos;s or a Partner&apos;s entitlement.
          </p>
        </div>
      </Panel>
    </>
  );
}
