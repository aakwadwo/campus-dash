import Link from 'next/link';
import { orderBoard, orderBoardSummary } from '@/lib/admin';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty } from '../ui';

export const dynamic = 'force-dynamic';

const ATTENTION = {
  DISPUTED: { label: 'Disputed', tone: 'bad' },
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

export default async function AdminOrdersPage({ searchParams }) {
  const params = await searchParams;
  const filter = typeof params?.attention === 'string' ? params.attention : null;

  const [orders, summary] = await Promise.all([orderBoard(filter, 200), orderBoardSummary()]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Orders</h1>
      <p className="text-muted mb-5 text-sm">
        Sorted by how much a human is needed: problems first, then work in flight, then the settled
        past.
      </p>

      <div className="mb-6 flex flex-wrap gap-2">
        <FilterChip active={!filter} href="/admin/orders" label="Everything" />
        {(summary ?? []).map((row) => (
          <FilterChip
            key={row.attention}
            active={filter === row.attention}
            href={`/admin/orders?attention=${row.attention}`}
            label={`${ATTENTION[row.attention]?.label ?? row.attention} (${row.count})`}
          />
        ))}
      </div>

      <Panel title={filter ? (ATTENTION[filter]?.label ?? filter) : 'All orders'}>
        {orders?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th className="pb-2 font-medium">Order</th>
                  <th className="pb-2 font-medium">Needs</th>
                  <th className="pb-2 font-medium">Vendor</th>
                  <th className="pb-2 font-medium">Customer</th>
                  <th className="pb-2 font-medium">Partner</th>
                  <th className="pb-2 font-medium">States</th>
                  <th className="pb-2 font-medium">Total</th>
                  <th className="pb-2 font-medium">Age</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.order_id} className="border-t border-black/5">
                    <td className="py-2">
                      <Link
                        href={`/admin/orders/${order.order_id}`}
                        className="text-brand-700 font-mono underline underline-offset-4"
                      >
                        {order.order_number}
                      </Link>
                    </td>
                    <td className="py-2">
                      <Badge tone={ATTENTION[order.attention]?.tone ?? 'neutral'}>
                        {ATTENTION[order.attention]?.label ?? order.attention}
                      </Badge>
                    </td>
                    <td className="py-2">{order.vendor_name}</td>
                    <td className="py-2">{order.customer_name ?? '—'}</td>
                    <td className="py-2">{order.partner_name ?? '—'}</td>
                    <td className="text-muted py-2 font-mono text-xs">
                      {order.order_status}/{order.payment_status}/{order.delivery_status}
                    </td>
                    <td className="py-2 tabular-nums">{formatPesewas(order.total_pesewas)}</td>
                    <td className="text-muted py-2 tabular-nums">{age(order.age_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing here.</Empty>
        )}
      </Panel>
    </>
  );
}

function FilterChip({ active, href, label }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
        active ? 'bg-brand-600 text-white' : 'bg-white ring-1 ring-black/10'
      }`}
    >
      {label}
    </Link>
  );
}

function age(seconds) {
  if (seconds == null) return '—';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
