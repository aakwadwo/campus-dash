import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMyVendors } from '@/lib/vendor';
import { myLanding } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Most people work for exactly one stall, so send them straight there. The
 * picker only appears for someone who genuinely staffs several.
 */
export default async function VendorIndexPage() {
  const vendors = await getMyVendors();

  if (vendors.length === 1) redirect(`/vendor/${vendors[0].id}`);

  // Nobody has linked this account to a stall. Say so. Silently redirecting
  // here is what made an administrator visiting /vendor look like a routing
  // bug: they landed on /admin with no explanation and reasonably concluded
  // the vendor area was resolving to the admin one.
  if (vendors.length === 0) {
    const home = await myLanding();
    return (
      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">No stall yet</h1>
        <p className="text-muted mt-3 text-sm">
          This account is not linked to a vendor, so there is no order board to show. An
          administrator adds vendor staff by phone number under Admin → Vendors → the stall → Staff.
        </p>
        <Link href={home} className="text-brand-700 mt-6 inline-block text-sm font-medium">
          Go to your own area →
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Choose a stall</h1>
      <ul className="mt-6 space-y-2">
        {vendors.map((vendor) => (
          <li key={vendor.id}>
            <Link
              href={`/vendor/${vendor.id}`}
              className="rounded-card bg-surface ring-line flex items-center justify-between px-4 py-4 ring-1"
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
