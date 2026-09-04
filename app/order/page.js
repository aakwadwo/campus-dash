import Link from 'next/link';
import { getCapabilities } from '@/lib/auth/session';
import { listVendors } from '@/lib/customer';

export const metadata = { title: 'Order · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * The marketplace. Open to everyone; ordering is not.
 *
 * Browsing needs no account — vendors and menu items are readable by `anon`
 * under their own RLS policies, so this page hits exactly the same queries
 * signed out as it does signed in. What an account (and student onboarding)
 * buys is the ability to place an order, and that is enforced in
 * submit_order_for(), not by hiding the menu.
 */
export default async function VendorListPage() {
  const me = await getCapabilities();
  const vendors = await listVendors();

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <header className="mb-5 flex items-baseline justify-between gap-3">
        <div>
          <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Order</h1>
        </div>
        {me.can_order ? (
          <Link href="/orders" className="text-brand-700 text-sm underline underline-offset-4">
            My orders
          </Link>
        ) : null}
      </header>

      <OrderingGate me={me} />

      {/* The second way in. It is not a vendor, so it does not belong in the
          list below — and it answers a different question from "what is open?":
          somebody arriving here with a scan already knows what they want. */}
      <Link
        href="/scan"
        className="border-brand-600/60 bg-brand-50/60 mb-4 flex items-center justify-between gap-3 rounded-lg border px-4 py-3"
      >
        <span>
          <span className="block text-sm font-semibold">Have a meal scan?</span>
          <span className="text-muted block text-xs">
            Send a Partner to redeem it. You pay only for the errand.
          </span>
        </span>
        <span className="text-brand-700 text-sm font-semibold">→</span>
      </Link>

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

/**
 * Says what is missing and links to the one thing that fixes it. Two different
 * states, because "sign in" and "finish your student details" are two different
 * problems and telling someone the wrong one wastes their time.
 */
export function OrderingGate({ me }) {
  if (me.can_order) return null;

  const { href, label, body } = !me.authenticated
    ? {
        href: '/login?next=%2Forder',
        label: 'Sign in',
        body: 'Browse as much as you like. To place an order you need a Campus Dash account.',
      }
    : {
        href: '/onboarding?next=%2Forder',
        label: 'Add your student details',
        body: 'Campus Dash is for Academic City students. Add your student details to this account and you can order.',
      };

  return (
    <div className="border-brand-600/60 bg-brand-50/60 mb-5 rounded-lg border p-4">
      <p className="text-sm leading-relaxed">{body}</p>
      <Link href={href} className="text-brand-700 mt-2 inline-block text-sm font-semibold">
        {label} →
      </Link>
    </div>
  );
}
