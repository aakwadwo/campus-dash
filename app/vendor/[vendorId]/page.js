import { notFound } from 'next/navigation';
import { getOrderBoard, getMyVendors, groupBoard } from '@/lib/vendor';
import { getPendingCount } from '@/lib/vendor';
import OrderBoard from './order-board';

export const dynamic = 'force-dynamic';

export default async function VendorBoardPage({ params }) {
  const { vendorId } = await params;

  // getMyVendors is already narrowed to stalls this user staffs, so an id they
  // do not work for simply is not here.
  const vendors = await getMyVendors();
  const vendor = vendors.find((v) => v.id === vendorId);
  if (!vendor) notFound();

  const [rows, pending] = await Promise.all([getOrderBoard(vendorId), getPendingCount(vendorId)]);

  return <OrderBoard vendor={vendor} buckets={groupBoard(rows)} initialPending={pending} />;
}
