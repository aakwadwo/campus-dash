import { notFound } from 'next/navigation';
import { getOrderDetail, getHandoffCode } from '@/lib/vendor';
import { vendorScanImageUrl } from '@/lib/scan';
import { orderLabel } from '@/lib/orders/state';
import { formatPesewas } from '@/lib/util/money';
import { BackLink, Card, Facts, Fact, Badge } from '@/app/ui';
import OrderActions from './order-actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Order' };

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

  // THE SCAN ITSELF, for the store that is about to honour it. Signed
  // server-side and short-lived; vendor_scan_image_path() re-checks that this
  // caller staffs the store and that the order is still live, so this returns
  // null the moment it leaves the board.
  const scanUrl =
    order.order_type === 'SCAN' ? await vendorScanImageUrl(orderId).catch(() => null) : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-3 pb-16 sm:px-6 sm:pt-6">
      <BackLink href={`/vendor/${vendorId}`}>Orders</BackLink>

      {/* The number first and biggest: it is what gets called out. */}
      <header className="mt-3 mb-6">
        <p className="text-muted flex items-center gap-2 text-sm font-medium">
          Order
          {order.order_type === 'SCAN' ? <Badge tone="brand">Meal Scan</Badge> : null}
        </p>
        <h1 className="text-6xl leading-none font-bold tabular-nums">{orderLabel(order)}</h1>
        <p className="mt-3 text-lg font-semibold">
          {STATUS_COPY[order.order_status] ?? order.order_status}
        </p>
        {order.cancellation_reason ? (
          <p className="text-muted mt-1 text-sm">{order.cancellation_reason}</p>
        ) : null}
      </header>

      {/* PACK INCLUDED is part of the job, so it is said before anything else
          about the order. */}
      {Number(order.vendor_pack_pesewas) > 0 ? (
        <p className="bg-ink rounded-card mb-4 px-4 py-3 text-sm font-semibold text-white">
          Pack included. Pack this order.
        </p>
      ) : null}

      {/* WHAT TO DO comes before what the order contains. */}
      <OrderActions order={order} vendorId={vendorId} handoffCode={handoffCode} scanUrl={scanUrl} />

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
            Campus Dash and the Partner and are not returned to this screen. On
            a Meal Scan the food is settled through the campus meal system, so
            its value is named for what it is; the pack, when there is one, is
            the store's money through Campus Dash. */}
        <dl className="border-line mt-3 space-y-1.5 border-t pt-3 text-sm">
          {order.order_type === 'SCAN' ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Food, on the Meal Scan</dt>
              <dd className="tabular-nums">{formatPesewas(order.scan_value_pesewas)}</dd>
            </div>
          ) : null}
          {Number(order.vendor_pack_pesewas) > 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted">Pack</dt>
              <dd className="tabular-nums">{formatPesewas(order.vendor_pack_pesewas)}</dd>
            </div>
          ) : null}
          {order.order_type !== 'SCAN' || Number(order.vendor_amount_pesewas) > 0 ? (
            <div className="flex items-baseline justify-between gap-3 pt-1">
              <dt className="font-semibold">Your amount</dt>
              <dd className="text-base font-semibold tabular-nums">
                {formatPesewas(order.vendor_amount_pesewas)}
              </dd>
            </div>
          ) : null}
        </dl>
      </Card>

      {/* ORDER INFORMATION, in the customer's words, and only when they wrote
          some. It is the note about the food. What they wrote for their
          Partner is never returned to a store. */}
      {order.order_information ? (
        <Card className="mt-4 p-5">
          <h2 className="mb-1.5 font-semibold">Order information</h2>
          <p className="text-ink leading-relaxed whitespace-pre-line">{order.order_information}</p>
        </Card>
      ) : null}

      {/* WHERE IT IS GOING IS NOT HERE, and neither is who is carrying it. A
          store hands food across a counter to whoever reads back four digits;
          the destination is the Partner's business and the customer's, and a
          screen that shows it to a store is showing it to a room. */}
      <Card className="mt-4 px-5 py-2">
        <Facts>
          <Fact label="Payment" value={paymentCopy(order.payment_status)} />
          {order.order_type === 'SCAN' ? (
            <Fact label="Meal Scan" value={scanCopy(order.scan_status)} />
          ) : null}
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

function scanCopy(status) {
  return {
    UPLOADED: 'Waiting for you to check it',
    // Nothing writes RELEASED any more — a Partner never sees a Meal Scan —
    // but an order from before that changed can still be carrying it.
    RELEASED: 'Waiting for you to check it',
    REDEEMED: 'Approved by you',
    REFUSED: 'Marked invalid — this order is cancelled',
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
