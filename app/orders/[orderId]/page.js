import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireCustomer } from '@/lib/auth/session';
import { getMyOrder } from '@/lib/customer';
import { getPollIntervals } from '@/lib/platform-config';
import { formatPesewas } from '@/lib/util/money';
import { STAGE } from '../stage';
import OrderStatus from './order-status';

export const dynamic = 'force-dynamic';

export default async function CustomerOrderPage({ params }) {
  const { orderId } = await params;
  // The capabilities come back from the database on this request; `email` is
  // read from them so the pay button can ask for one when the provider needs it.
  const me = await requireCustomer(`/orders/${orderId}`);

  // Returns nothing unless the order belongs to the signed-in customer, so
  // another customer's id lands on a 404 rather than a message confirming it
  // exists.
  const [order, intervals] = await Promise.all([getMyOrder(orderId), getPollIntervals()]);
  if (!order) notFound();

  const stage = STAGE[order.stage] ?? { label: order.stage, tone: '', detail: null };

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <Link href="/orders" className="text-muted text-sm underline underline-offset-4">
        ← My orders
      </Link>

      <header className="mt-3 mb-5">
        <p className="text-muted text-sm">{order.vendor_name}</p>
        <h1 className={`text-2xl font-semibold tracking-tight ${stage.tone}`}>{stage.label}</h1>
        {stage.detail ? <p className="text-muted mt-1 text-sm">{stage.detail}</p> : null}
        {order.cancellation_reason ? (
          <p className="mt-1 text-sm">Reason: {order.cancellation_reason}</p>
        ) : null}
        <p className="text-muted mt-2 font-mono text-xs">{order.order_number}</p>
      </header>

      <OrderStatus order={order} email={me.email ?? null} pollMs={intervals.customerMs} />

      <section className="mt-4 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">Your order</h2>
        <ul className="divide-y divide-black/5">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-baseline justify-between gap-3 py-2 text-sm">
              <span>
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
              </span>
              <span className="tabular-nums">{formatPesewas(item.line_total_pesewas)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-black/5 pt-3 text-sm">
          <Line label="Food" value={order.subtotal_pesewas} />
          <Line label="Service fee" value={order.service_fee_pesewas} />
          {order.delivery_fee_pesewas > 0 ? (
            <Line label="Delivery fee" value={order.delivery_fee_pesewas} />
          ) : null}
          <div className="flex justify-between border-t border-black/5 pt-2 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatPesewas(order.total_pesewas)}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-4 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">Details</h2>
        <dl className="space-y-1 text-sm">
          <Row
            label="Fulfilment"
            value={order.fulfilment_type === 'PICKUP' ? 'You collect' : 'Delivered to you'}
          />
          {order.destination ? <Row label="Destination" value={order.destination} /> : null}
          {order.destination_note ? <Row label="Note" value={order.destination_note} /> : null}
        </dl>
        {order.fulfilment_type === 'DELIVERY' && order.order_status === 'READY' ? (
          <p className="text-muted mt-3 text-sm">
            Your food is ready. A Partner will be found to bring it to you.
          </p>
        ) : null}
      </section>
    </main>
  );
}

function Line({ label, value }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{formatPesewas(value)}</dd>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
