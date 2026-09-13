import { notFound } from 'next/navigation';
import { getOrderDetail, getHandoffCode } from '@/lib/vendor';
import { orderLabel } from '@/lib/orders/state';
import { formatPesewas } from '@/lib/util/money';
import { BackLink, Card, Facts, Fact } from '@/app/ui';
import OrderActions from './order-actions';

export const dynamic = 'force-dynamic';

const STATUS_COPY = {
  ACCEPTED: 'Paid. Start preparing',
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
    <main className="mx-auto max-w-2xl px-4 pt-3 pb-16 sm:px-6 sm:pt-6">
      <BackLink href={`/vendor/${vendorId}`}>Orders</BackLink>

      {/* The number first and biggest: it is what gets called out. */}
      <header className="mt-3 mb-6">
        <p className="text-muted text-sm font-medium">Order</p>
        <h1 className="text-6xl leading-none font-bold tabular-nums">{orderLabel(order)}</h1>
        <p className="mt-3 text-lg font-semibold">
          {STATUS_COPY[order.order_status] ?? order.order_status}
        </p>
        {order.cancellation_reason ? (
          <p className="text-muted mt-1 text-sm">{order.cancellation_reason}</p>
        ) : null}
      </header>

      {/* WHAT TO DO comes before what the order contains. */}
      <OrderActions order={order} vendorId={vendorId} handoffCode={handoffCode} />

      <Card className="mt-6 p-5">
        <h2 className="mb-2 font-semibold">Items</h2>
        <ul className="divide-line divide-y">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="font-semibold tabular-nums">{item.quantity}×</span> {item.name}
              </span>
              <span className="text-muted shrink-0 text-sm tabular-nums">
                {formatPesewas(item.line_total_pesewas)}
              </span>
            </li>
          ))}
        </ul>

        {/* THE STORE'S AMOUNT, and only that. The fees on this order belong to
            Campus Dash and the Partner and are not returned to this screen. */}
        <div className="border-line mt-3 flex items-baseline justify-between gap-3 border-t pt-3">
          <span className="font-semibold">Your amount</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatPesewas(order.vendor_amount_pesewas)}
          </span>
        </div>
      </Card>

      <Card className="mt-4 px-5 py-2">
        <Facts>
          <Fact
            label="Collected by"
            value={
              order.fulfilment_type === 'PICKUP'
                ? (order.customer_first_name ?? 'The customer')
                : 'A Campus Dash Partner'
            }
          />
          {order.fulfilment_type === 'DELIVERY' ? (
            <Fact
              label="Partner"
              value={order.partner_assigned ? (order.partner_name ?? 'Assigned') : 'Not yet'}
            />
          ) : null}
          {order.fulfilment_type === 'DELIVERY' ? (
            <Fact label="Going to" value={order.destination_zone ?? 'Campus'} />
          ) : null}
          <Fact label="Payment" value={paymentCopy(order.payment_status)} />
          <Fact label="Placed" value={formatAge(order.age_seconds)} />
        </Facts>
      </Card>
    </main>
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
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`;
  return `${Math.floor(minutes / (24 * 60))} days ago`;
}
