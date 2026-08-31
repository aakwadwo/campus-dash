import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listVendors } from '@/lib/customer';

export const metadata = { title: 'Order · Campus Dash' };
export const dynamic = 'force-dynamic';

export default async function VendorListPage() {
  await requireUser('/order');
  const vendors = await listVendors();

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <header className="mb-5 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Order</h1>
        </div>
        <Link href="/orders" className="text-brand-700 text-sm underline underline-offset-4">
          My orders
        </Link>
      </header>

      {vendors.length ? (
        <ul className="space-y-2">
          {vendors.map((vendor) => (
            <li key={vendor.id}>
              {vendor.is_accepting_orders ? (
                <Link
                  href={`/order/${vendor.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg bg-white px-4 py-4 ring-1 ring-black/5"
                >
                  <span className="font-medium">{vendor.name}</span>
                  <span className="text-brand-700 text-sm font-semibold">Open</span>
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.03] px-4 py-4 ring-1 ring-black/5">
                  <span className="text-muted font-medium">{vendor.name}</span>
                  <span className="text-muted text-sm">Closed</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted py-10 text-center text-sm">
          No vendors are set up yet. Check back soon.
        </p>
      )}
    </main>
  );
}
