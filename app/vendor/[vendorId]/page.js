import { notFound } from 'next/navigation';
import {
  getOrderBoard,
  getMyVendors,
  groupBoard,
  getPendingCount,
  getDailySales,
} from '@/lib/vendor';
import { getPollIntervals } from '@/lib/platform-config';
import { todayKey } from '@/lib/vendor/days';
import OrderBoard from './order-board';

export const dynamic = 'force-dynamic';

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

  const [rows, pending, intervals, days] = await Promise.all([
    // Only the most recent finished orders: the full record is History.
    getOrderBoard(vendorId, 5),
    getPendingCount(vendorId),
    getPollIntervals(),
    // null, not [], when it cannot be read: "no sales" and "could not ask"
    // must not look the same.
    getDailySales(vendorId, 1).catch(() => null),
  ]);

  const today = days ? (days.find((d) => d.order_day === todayKey()) ?? null) : null;

  return (
    <OrderBoard
      vendor={vendor}
      buckets={groupBoard(rows)}
      initialPending={pending}
      pollMs={intervals.vendorMs}
      today={
        days === null
          ? null
          : { orders: today?.order_count ?? 0, salesPesewas: Number(today?.sales_pesewas ?? 0) }
      }
    />
  );
}
