import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import MenuAndBasket from './menu-and-basket';

export const dynamic = 'force-dynamic';

export default async function VendorMenuPage({ params }) {
  const { vendorId } = await params;
  await requireUser(`/order/${vendorId}`);

  const result = await getVendorWithMenu(vendorId);
  if (!result) notFound();

  const locations = await listDeliverableLocations();

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-40">
      <Link href="/order" className="text-muted text-sm underline underline-offset-4">
        ← All vendors
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{result.vendor.name}</h1>
      {!result.vendor.is_accepting_orders ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This stall is closed right now, so you cannot place an order.
        </p>
      ) : null}

      <MenuAndBasket vendor={result.vendor} menu={result.menu} locations={locations ?? []} />
    </main>
  );
}
