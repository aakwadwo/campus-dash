import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderDetail, getHandoffCode } from '@/lib/vendor';
import { orderLabel } from '@/lib/orders/state';
import { formatPesewas } from '@/lib/util/money';
import OrderActions from './order-actions';

export const dynamic = 'force-dynamic';

const STATUS_COPY = {
  ACCEPTED: 'Paid — start preparing',
  PREPARING: 'Preparing',
  READY: 'Ready for pickup',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  CANCELLED_BY_VENDOR: 'You cancelled this order',
  // Only reachable on an order placed before orders arrived paid for.
  SUBMITTED: 'Waiting for your answer',
  REJECTED: 'You rejected this order',
  EXPIRED: 'Expired, no answer in time',
};

export default async function VendorOrderPage({ params }) {
  const { vendorId, orderId } = await params;

  // Returns nothing unless the caller staffs this order's vendor, so another
  // vendor's order id lands on a 404 rather than a permissions message that
  // confirms it exists.
  const order = await getOrderDetail(orderId);
  if (!order || order.vendor_id !== vendorId) notFound();

  // Fetched only when somebody is actually due to collect — a Partner at the
  // counter, or a customer whose food is made. vendor_handoff_code() refuses at
  // any other moment, so this is not the guard; it is what stops a pointless
  // call on every other order.
  const handoffCode = order.handoff_code_available
    ? await getHandoffCode(orderId).catch(() => null)
    : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-24">
      <Link
        href={`/vendor/${vendorId}`}
        className="text-muted text-sm underline underline-offset-4"
      >
        ← All orders
      </Link>

      <header className="mt-3 mb-5">
        <p className="text-muted text-xs font-semibold tracking-[0.14em] uppercase">Order number</p>
        <h1 className="text-5xl leading-none font-bold tabular-nums">{orderLabel(order)}</h1>
        <p className="mt-2 font-medium">{STATUS_COPY[order.order_status] ?? order.order_status}</p>
        {order.cancellation_reason ? (
          <p className="text-muted mt-1 text-sm">{order.cancellation_reason}</p>
        ) : null}
      </header>

      <section className="rounded-card bg-surface ring-line mb-4 p-4 ring-1">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Items</h2>
        <ul className="divide-line divide-y">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-baseline justify-between gap-3 py-2">
              <span>
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
              </span>
              <span className="tabular-nums">{formatPesewas(item.line_total_pesewas)}</span>
            </li>
          ))}
        </ul>

        <dl className="border-line mt-3 space-y-1 border-t pt-3 text-sm">
          <Row label="Food" value={formatPesewas(order.subtotal_pesewas)} />
          <Row label="Service fee" value={formatPesewas(order.service_fee_pesewas)} />
          {order.delivery_fee_pesewas > 0 ? (
            <Row label="Partner delivery" value={formatPesewas(order.delivery_fee_pesewas)} />
          ) : null}
          <Row label="Customer paid" value={formatPesewas(order.total_pesewas)} strong />
        </dl>
        <p className="text-muted mt-3 text-xs">
          You receive the food amount. The service and delivery fees are not yours, and are settled
          separately.
        </p>
      </section>

      <section className="rounded-card bg-surface ring-line mb-4 p-4 ring-1">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Details</h2>
        <dl className="space-y-1 text-sm">
          <Row
            label="Collected by"
            value={
              order.fulfilment_type === 'PICKUP'
                ? (order.customer_first_name ?? 'The customer')
                : 'A Campus Dash Partner'
            }
          />
          {order.fulfilment_type === 'DELIVERY' ? (
            <Row label="Destination zone" value={order.destination_zone ?? 'Campus'} />
          ) : null}
          <Row label="Payment" value={paymentCopy(order.payment_status)} />
          {order.fulfilment_type === 'DELIVERY' ? (
            <Row
              label="Partner"
              value={order.partner_assigned ? (order.partner_name ?? 'Assigned') : 'Searching…'}
            />
          ) : null}
          <Row label="Order age" value={formatAge(order.age_seconds)} />
        </dl>
      </section>

      <OrderActions order={order} vendorId={vendorId} handoffCode={handoffCode} />
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
  if (seconds == null) return '-';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
