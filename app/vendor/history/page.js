import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import { getMyVendors, getDailySales } from '@/lib/vendor';
import { todayKey, dayLabel } from '@/lib/vendor/days';
import { formatPesewas } from '@/lib/util/money';
import { PageHeader, Card, EmptyState, Unavailable, ChevronRightIcon, ClockIcon } from '@/app/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Order history' };

const DAYS = 30;

/**
 * Order history, a day at a time.
 *
 * NOT AN ANALYTICS SCREEN. A store owner's question is "how did today go, and
 * how does it compare with yesterday", so this is a list of days — orders and
 * sales on each — and a tap opens the orders behind one. No charts, no ranges,
 * no averages.
 *
 * Sales are the store's own amount: the sum of its VENDOR allocations, which is
 * the food it sold. Fees are not in the figure and not on the page.
 */
export default async function VendorHistoryPage() {
  await requireVendorStaff();
  const vendor = (await getMyVendors())[0];
  if (!vendor) notFound();

  const days = await getDailySales(vendor.vendor_id, DAYS).catch(() => null);

  // Today always leads, even at zero: "nothing yet today" is an answer.
  const today = todayKey();
  const rows =
    days === null
      ? null
      : days.some((d) => d.order_day === today)
        ? days
        : [{ order_day: today, order_count: 0, sales_pesewas: 0, placeholder: true }, ...days];

  const monthOrders = (days ?? []).reduce((sum, d) => sum + Number(d.order_count), 0);
  const monthSales = (days ?? []).reduce((sum, d) => sum + Number(d.sales_pesewas), 0);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader
        title="Order history"
        description={
          days && monthOrders > 0
            ? `${monthOrders} order${monthOrders === 1 ? '' : 's'} and ${formatPesewas(monthSales)} in sales over the last ${DAYS} days.`
            : `Your orders and sales for the last ${DAYS} days.`
        }
      />

      {rows === null ? (
        <Unavailable>
          Your history could not be loaded just now. This is not the same as having no sales. Try
          again in a moment.
        </Unavailable>
      ) : rows.length === 1 && rows[0].placeholder ? (
        <Card>
          <EmptyState
            icon={<ClockIcon className="size-6" />}
            title="No sales yet"
            description="Every paid order shows up here, grouped by day, with what you made."
          />
        </Card>
      ) : (
        <Card as="ul" className="divide-line divide-y overflow-hidden">
          {rows.map((day) => {
            // Only the "today, nothing yet" placeholder has nothing to open. A
            // day the database returned has orders behind it, even when every
            // one of them was refunded and the sales figure is zero.
            const empty = Boolean(day.placeholder);
            const noSales = Number(day.order_count) === 0;
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{dayLabel(day.order_day)}</span>
                  <span className="text-muted mt-0.5 block text-sm tabular-nums">
                    {empty
                      ? 'No orders yet'
                      : noSales
                        ? 'No sales. Refunded orders only'
                        : `${day.order_count} order${day.order_count === 1 ? '' : 's'}`}
                  </span>
                </span>
                <span className="shrink-0 text-lg font-semibold tabular-nums">
                  {formatPesewas(Number(day.sales_pesewas))}
                </span>
                {empty ? (
                  <span className="size-5 shrink-0" aria-hidden />
                ) : (
                  <ChevronRightIcon className="text-faint size-5 shrink-0" />
                )}
              </>
            );
            return (
              <li key={day.order_day}>
                {empty ? (
                  <div className="flex min-h-16 items-center gap-4 px-5 py-3">{body}</div>
                ) : (
                  <Link
                    href={`/vendor/history/${day.order_day}`}
                    className="press-sm hover:bg-surface-2 flex min-h-16 items-center gap-4 px-5 py-3 transition-colors"
                  >
                    {body}
                  </Link>
                )}
              </li>
            );
          })}
        </Card>
      )}

      <p className="text-muted mt-4 text-sm leading-relaxed">
        Sales are the amount you receive for the food. Refunded orders are not counted.
      </p>
    </main>
  );
}
