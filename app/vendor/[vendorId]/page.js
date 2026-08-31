import { notFound } from 'next/navigation';
import { getOrderBoard, getMyVendors, groupBoard, getPendingCount } from '@/lib/vendor';
import { getPollIntervals } from '@/lib/platform-config';
import OrderBoard from './order-board';

export const dynamic = 'force-dynamic';

export default async function VendorBoardPage({ params }) {
  const { vendorId } = await params;

  // getMyVendors is already narrowed to stalls this user staffs, so an id they
  // do not work for simply is not here.
  const vendors = await getMyVendors();
  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) notFound();

  const [rows, pending, intervals] = await Promise.all([
    getOrderBoard(vendorId),
    getPendingCount(vendorId),
    getPollIntervals(),
  ]);

  return (
    <OrderBoard
      vendor={vendor}
      buckets={groupBoard(rows)}
      initialPending={pending}
      pollMs={intervals.vendorMs}
    />
  );
}
