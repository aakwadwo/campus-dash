import { notFound } from 'next/navigation';
import { getOrderDetail, getHandoffCode } from '@/lib/vendor';
import { vendorScanImageUrl } from '@/lib/scan';
import { orderLabel } from '@/lib/orders/state';
import { formatPesewas } from '@/lib/util/money';
import { BackLink, Card, Facts, Fact, Badge } from '@/app/ui';
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
          {order.order_type === 'SCAN' ? <Badge tone="brand">Meal scan</Badge> : null}
        </p>
        <h1 className="text-6xl leading-none font-bold tabular-nums">{orderLabel(order)}</h1>
        <p className="mt-3 text-lg font-semibold">
          {STATUS_COPY[order.order_status] ?? order.order_status}
        </p>
        {order.cancellation_reason ? (
          <p className="text-muted mt-1 text-sm">{order.cancellation_reason}</p>
        ) : null}
      </header>

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
            Campus Dash and the Partner and are not returned to this screen.
            On a meal scan Campus Dash pays nothing at all — the university's
            system settles it — so the scan's value is named for what it is
            rather than shown as a GH₵0.00 that reads like a mistake. */}
        <div className="border-line mt-3 flex items-baseline justify-between gap-3 border-t pt-3">
          <span className="font-semibold">
            {order.order_type === 'SCAN' ? 'Redeemed on scan' : 'Your amount'}
          </span>
          <span className="text-lg font-semibold tabular-nums">
            {formatPesewas(
              order.order_type === 'SCAN' ? order.scan_value_pesewas : order.vendor_amount_pesewas
            )}
          </span>
        </div>
        {order.order_type === 'SCAN' ? (
          <p className="text-muted mt-2 text-xs leading-relaxed">
            Settled through the campus meal system, not by Campus Dash.
          </p>
        ) : null}
      </Card>

      {order.scan_details ? (
        <Card className="mt-4 p-5">
          <h2 className="mb-1.5 font-semibold">Note from the customer</h2>
          <p className="text-muted text-sm leading-relaxed">{order.scan_details}</p>
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
            <Fact label="Meal scan" value={scanCopy(order.scan_status)} />
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
    RELEASED: 'Waiting for you to check it',
    REDEEMED: 'Verified and redeemed',
    REFUSED: 'Refused',
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
