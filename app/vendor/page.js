import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMyVendors } from '@/lib/vendor';

export const dynamic = 'force-dynamic';

/**
 * Most people work for exactly one stall, so send them straight there. The
 * picker only appears for someone who genuinely staffs several.
 */
export default async function VendorIndexPage() {
  const vendors = await getMyVendors();

  if (vendors.length === 1) redirect(`/vendor/${vendors[0].id}`);
  if (vendors.length === 0) redirect('/account');

  return (
    <main className="mx-auto max-w-md px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a stall</h1>
      <ul className="mt-6 space-y-2">
        {vendors.map((vendor) => (
          <li key={vendor.id}>
            <Link
              href={`/vendor/${vendor.id}`}
              className="flex items-center justify-between rounded-lg bg-white px-4 py-4 ring-1 ring-black/5"
            >
              <span className="font-medium">{vendor.name}</span>
              <span
                className={
                  vendor.is_accepting_orders ? 'text-brand-700 text-sm' : 'text-muted text-sm'
                }
              >
                {vendor.is_accepting_orders ? 'Open' : 'Closed'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
