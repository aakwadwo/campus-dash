import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import { getMyVendors, getOrdersOnDay } from '@/lib/vendor';
import { isDayKey, dayLabel, longDayLabel } from '@/lib/vendor/days';
import { orderLabel } from '@/lib/orders/state';
import { formatPesewas } from '@/lib/util/money';
import { PageHeader, Card, Stat, EmptyState, Unavailable, ChevronRightIcon } from '@/app/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders on a day' };

/**
 * One day's orders: the summary first, then every order, each opening to its
 * detail. The same numbers as the History row that led here, because they are
 * counted by the same rule — an order is a sale while it is PAID and has a live
 * VENDOR allocation, so a refunded order is listed, marked, and left out of the
 * total.
 */
export default async function VendorHistoryDayPage({ params }) {
  const { day } = await params;
  if (!isDayKey(day)) notFound();

  await requireVendorStaff();
  const vendor = (await getMyVendors())[0];
  if (!vendor) notFound();

  const orders = await getOrdersOnDay(vendor.vendor_id, day).catch(() => null);
  const sales = (orders ?? []).filter((o) => o.counts_as_sale);
  const salesPesewas = sales.reduce((sum, o) => sum + Number(o.vendor_amount_pesewas), 0);
  const label = dayLabel(day);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-3 pb-16 sm:px-6 sm:pt-6">
      <PageHeader
        back={{ href: '/vendor/history', label: 'Order history' }}
        title={label === 'Today' || label === 'Yesterday' ? label : longDayLabel(day)}
        description={label === 'Today' || label === 'Yesterday' ? longDayLabel(day) : undefined}
      />

      {orders === null ? (
        <Unavailable>These orders could not be loaded. Try again in a moment.</Unavailable>
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState title="No orders on this day" />
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <Stat label="Orders" value={sales.length} />
            <Stat label="Sales" value={formatPesewas(salesPesewas)} />
          </dl>

          <Card as="ul" className="divide-line mt-6 divide-y overflow-hidden">
            {orders.map((order) => {
              // Labelled from the order's own refund state; excluded from the
              // total by counts_as_sale, which applies the same rule in SQL.
              const notASale = !order.counts_as_sale;
              return (
                <li key={order.order_id}>
                  <Link
                    href={`/vendor/${vendor.vendor_id}/orders/${order.order_id}`}
                    className="press-sm hover:bg-surface-2 flex min-h-16 items-center gap-4 px-5 py-3 transition-colors"
                  >
                    <span className="w-12 shrink-0 text-lg font-bold tabular-nums">
                      {orderLabel(order)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">
                        {order.payment_status === 'REFUNDED'
                          ? 'Refunded'
                          : order.payment_status === 'REFUND_PENDING'
                            ? 'Refund pending'
                            : order.order_status === 'COMPLETED'
                              ? order.fulfilment_type === 'PICKUP'
                                ? 'Collected'
                                : 'Delivered'
                              : ['CANCELLED', 'CANCELLED_BY_VENDOR'].includes(order.order_status)
                                ? 'Cancelled'
                                : 'In progress'}
                      </span>
                      <span className="text-muted block text-sm">
                        {time(order.submitted_at)} · {order.item_count} item
                        {order.item_count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 font-semibold tabular-nums ${notASale ? 'text-faint line-through' : ''}`}
                    >
                      {formatPesewas(Number(order.vendor_amount_pesewas))}
                    </span>
                    <ChevronRightIcon className="text-faint size-5 shrink-0" />
                  </Link>
                </li>
              );
            })}
          </Card>
        </>
      )}
    </main>
  );
}

function time(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Accra',
  });
}
