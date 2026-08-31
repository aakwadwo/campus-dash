import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderDetail } from '@/lib/vendor';
import { formatPesewas } from '@/lib/util/money';
import OrderActions from './order-actions';

export const dynamic = 'force-dynamic';

const STATUS_COPY = {
  SUBMITTED: 'Waiting for your answer',
  ACCEPTED: 'Accepted — waiting for payment',
  PREPARING: 'Preparing',
  READY: 'Ready',
  COMPLETED: 'Completed',
  REJECTED: 'You rejected this order',
  EXPIRED: 'Expired — no answer in time',
  CANCELLED: 'Cancelled',
  CANCELLED_BY_VENDOR: 'You cancelled this order',
};

export default async function VendorOrderPage({ params }) {
  const { vendorId, orderId } = await params;

  // Returns nothing unless the caller staffs this order's vendor, so another
  // vendor's order id lands on a 404 rather than a permissions message that
  // confirms it exists.
  const order = await getOrderDetail(orderId);
  if (!order || order.vendor_id !== vendorId) notFound();

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-24">
      <Link
        href={`/vendor/${vendorId}`}
        className="text-muted text-sm underline underline-offset-4"
      >
        ← All orders
      </Link>

      <header className="mt-3 mb-5">
        <h1 className="font-mono text-2xl font-semibold">{order.order_number}</h1>
        <p className="mt-1 font-medium">{STATUS_COPY[order.order_status] ?? order.order_status}</p>
        {order.cancellation_reason ? (
          <p className="text-muted mt-1 text-sm">{order.cancellation_reason}</p>
        ) : null}
      </header>

      <section className="mb-4 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Items</h2>
        <ul className="divide-y divide-black/5">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-baseline justify-between gap-3 py-2">
              <span>
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
              </span>
              <span className="tabular-nums">{formatPesewas(item.line_total_pesewas)}</span>
            </li>
          ))}
        </ul>

        <dl className="mt-3 space-y-1 border-t border-black/5 pt-3 text-sm">
          <Row label="Food" value={formatPesewas(order.subtotal_pesewas)} />
          <Row label="Service fee" value={formatPesewas(order.service_fee_pesewas)} />
          {order.delivery_fee_pesewas > 0 ? (
            <Row label="Delivery fee" value={formatPesewas(order.delivery_fee_pesewas)} />
          ) : null}
          <Row label="Customer pays" value={formatPesewas(order.total_pesewas)} strong />
        </dl>
        <p className="text-muted mt-3 text-xs">
          You receive the food amount. The service and delivery fees are not yours, and are settled
          separately.
        </p>
      </section>

      <section className="mb-4 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Details</h2>
        <dl className="space-y-1 text-sm">
          <Row
            label="Fulfilment"
            value={order.fulfilment_type === 'PICKUP' ? 'Customer collects' : 'Partner delivers'}
          />
          {order.fulfilment_type === 'DELIVERY' ? (
            <Row label="Destination zone" value={order.destination_zone ?? 'Campus'} />
          ) : null}
          <Row label="Payment" value={paymentCopy(order.payment_status)} />
          {order.fulfilment_type === 'DELIVERY' && order.order_status === 'READY' ? (
            <Row
              label="Partner"
              value={order.partner_assigned ? 'Assigned — coming to collect' : 'Searching…'}
            />
          ) : null}
          <Row label="Order age" value={formatAge(order.age_seconds)} />
        </dl>
      </section>

      <OrderActions order={order} vendorId={vendorId} />
    </main>
  );
}

function Row({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}

function paymentCopy(status) {
  return {
    UNPAID: 'Not paid yet',
    PENDING: 'Payment processing',
    PAID: 'Paid',
    FAILED: 'Payment failed',
    REFUND_PENDING: 'Refund pending',
    REFUNDED: 'Refunded',
  }[status];
}

function formatAge(seconds) {
  if (seconds == null) return '—';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
