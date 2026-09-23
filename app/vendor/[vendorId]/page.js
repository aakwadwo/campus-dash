import { notFound } from 'next/navigation';
import {
  getOrderBoard,
  getMyVendors,
  groupBoard,
  getPendingCount,
  getDailySales,
  getPayoutDays,
  listMenu,
} from '@/lib/vendor';
import { payoutOutlook, payoutDayLabel } from '@/lib/settlement/schedule';
import { getPollIntervals } from '@/lib/platform-config';
import { todayKey } from '@/lib/vendor/days';
import OrderBoard from './order-board';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Orders' };

/**
 * The store dashboard.
 *
 * It answers three questions, in the order a store owner asks them: how many
 * orders today, how much have I made today, and what needs me right now. The
 * first two come from vendor_daily_sales(), which sums this store's own
 * allocation and nothing else. The third is the board.
 */
export default async function VendorBoardPage({ params }) {
  const { vendorId } = await params;

  // getMyVendors is already narrowed to stores this user owns, so an id they
  // do not work for simply is not here.
  const vendors = await getMyVendors();
  const vendor = vendors.find((v) => v.vendor_id === vendorId);
  if (!vendor) notFound();

  const [rows, pending, intervals, days, payoutDays] = await Promise.all([
    // Only the most recent finished orders: the full record is History.
    getOrderBoard(vendorId, 5),
    getPendingCount(vendorId),
    getPollIntervals(),
    // null, not [], when it cannot be read: "no sales" and "could not ask"
    // must not look the same.
    getDailySales(vendorId, 1).catch(() => null),
    getPayoutDays(vendorId).catch(() => null),
  ]);

  // WHEN THE MONEY ARRIVES. Paystack settles a store's split money to its
  // mobile money on the next Ghana working day; Campus Dash does not send it.
  // Worked out here, on the server, from the day each order was paid.
  const now = new Date();
  const outlook = payoutDays ? payoutOutlook(payoutDays, now) : null;
  const payout = outlook
    ? {
        pendingPesewas: outlook.pendingPesewas,
        next: outlook.nextPayoutDay ? payoutDayLabel(outlook.nextPayoutDay, now) : null,
      }
    : null;

  const today = days ? (days.find((d) => d.order_day === todayKey()) ?? null) : null;

  // OPENING IS REFUSED WITH NOTHING ON THE MENU, so the board needs to know
  // before the tap rather than after it — a button that always fails is worse
  // than one that says where to go. Asked only while the store is CLOSED: an
  // open store provably has an active item, so the question is already
  // answered and an extra query per poll would buy nothing.
  const hasActiveItems = vendor.is_accepting_orders
    ? true
    : await listMenu(vendorId)
        .then((menu) => menu.some((item) => item.is_active))
        .catch(() => true);

  return (
    <OrderBoard
      vendor={vendor}
      buckets={groupBoard(rows)}
      initialPending={pending}
      hasActiveItems={hasActiveItems}
      pollMs={intervals.vendorMs}
      payout={payout}
      today={
        days === null
          ? null
          : { orders: today?.order_count ?? 0, salesPesewas: Number(today?.sales_pesewas ?? 0) }
      }
    />
  );
}
