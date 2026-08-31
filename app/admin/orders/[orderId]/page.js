import Link from 'next/link';
import { notFound } from 'next/navigation';
import { orderMoney } from '@/lib/admin';
import { createClient } from '@/lib/supabase/server';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge } from '../../ui';
import OrderOverrides from './order-overrides';

export const dynamic = 'force-dynamic';

export default async function AdminOrderPage({ params }) {
  const { orderId } = await params;

  const money = await orderMoney(orderId);
  if (!money) notFound();

  const supabase = await createClient();
  const [{ data: order }, { data: events }] = await Promise.all([
    supabase.from('orders').select('*').eq('id', orderId).maybeSingle(),
    supabase
      .from('order_events')
      .select('event, actor_role, accepted, reason, created_at')
      .eq('order_id', orderId)
      .order('id'),
  ]);

  return (
    <>
      <p className="text-muted mb-2 text-sm">
        <Link href="/admin/orders" className="underline underline-offset-4">
          Orders
        </Link>
      </p>
      <h1 className="mb-1 font-mono text-2xl font-semibold">{money.order_number}</h1>
      <p className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{order?.order_status}</Badge>
        <Badge tone={order?.payment_status === 'PAID' ? 'good' : 'warn'}>
          {order?.payment_status}
        </Badge>
        <Badge>{order?.delivery_status}</Badge>
        {order?.disputed_at && !order?.dispute_resolved_at ? (
          <Badge tone="bad">DISPUTED</Badge>
        ) : null}
      </p>

      <Panel
        title="Money"
        description="What the customer paid, where we said it goes, and whether it has left."
      >
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Row label="Customer paid" value={formatPesewas(money.paid_pesewas)} />
          <Row label="Order total" value={formatPesewas(money.total_pesewas)} />
          <Row
            label={`Vendor · ${money.vendor_name}`}
            value={formatPesewas(money.vendor_allocation)}
          />
          <Row label="Campus Dash" value={formatPesewas(money.platform_allocation)} />
          <Row
            label={`Partner · ${money.partner_name ?? 'none'}`}
            value={formatPesewas(money.partner_allocation)}
          />
          <Row label="Allocated in total" value={formatPesewas(money.allocated_pesewas)} />
        </dl>

        <p
          className={`mt-3 text-sm font-medium ${money.balances ? 'text-brand-700' : 'text-red-700'}`}
        >
          {money.balances
            ? '✓ Allocations balance against the order total.'
            : '✗ Allocations do NOT balance — this order needs investigating.'}
        </p>

        <div className="text-muted mt-4 space-y-1 text-xs">
          <p>
            Provider: {money.payment_provider ?? '—'} · txn{' '}
            <span className="font-mono">{money.provider_transaction_id ?? '—'}</span> ·{' '}
            {money.payment_txn_status ?? 'no payment'}
          </p>
        </div>

        {money.allocations?.length ? (
          <table className="mt-4 w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Payee</th>
                <th className="pb-2 font-medium">Amount</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Settled</th>
              </tr>
            </thead>
            <tbody>
              {money.allocations.map((a, i) => (
                <tr key={i} className="border-t border-black/5">
                  <td className="py-2">{a.payee_type}</td>
                  <td className="py-2 tabular-nums">{formatPesewas(a.amount_pesewas)}</td>
                  <td className="py-2">{a.status}</td>
                  <td className="text-muted py-2">
                    {a.settled_at ? new Date(a.settled_at).toLocaleString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Panel>

      <Panel title="Overrides" description="Every one of these is recorded with your reason.">
        <OrderOverrides order={order} />
      </Panel>

      <Panel title="History" description="Every attempted transition, accepted or rejected.">
        <ul className="divide-y divide-black/5 text-sm">
          {(events ?? []).map((event, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
              <span className={`font-mono text-xs ${event.accepted ? '' : 'text-red-700'}`}>
                {event.accepted ? '' : '✗ '}
                {event.event}
              </span>
              <span className="text-muted text-xs">{event.actor_role}</span>
              {event.reason ? <span className="text-muted text-xs">— {event.reason}</span> : null}
              <span className="text-muted ml-auto text-xs tabular-nums">
                {new Date(event.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
