import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { listScanRestaurants } from '@/lib/scan';
import { listDeliverableLocations } from '@/lib/customer';
import ScanForm from './scan-form';

export const metadata = { title: 'Scan delivery · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Scan delivery.
 *
 * "I already have prepaid food. I want someone to go and get it."
 *
 * WHY THIS PAGE IS GATED WHEN /order IS NOT. Browsing a menu costs nobody
 * anything, so the marketplace is open. This page's first act is to take a
 * private document off somebody's phone, and there is no version of that which
 * makes sense for a visitor with no account. So the gate is here, at the upload,
 * rather than at the price — which is also why the restaurant list below is
 * public and this screen is not.
 */
export default async function ScanPage() {
  const me = await getCapabilities();

  if (!me.authenticated) redirect('/login?next=%2Fscan');
  // Same rule as ordering: a verified phone is an identity, ordering is a
  // capability, and it is acquired by completing student onboarding.
  if (!me.can_order) redirect('/onboarding?next=%2Fscan');

  const [restaurants, locations] = await Promise.all([
    listScanRestaurants(),
    listDeliverableLocations(),
  ]);

  const open = restaurants.filter((r) => r.is_accepting_orders);

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <Link href="/order" className="text-muted text-sm underline underline-offset-4">
        ← Ordering
      </Link>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">Scan delivery</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        Already have a meal scan? Send a Partner to redeem it and bring the food to you. You have
        paid for the food already — Campus Dash charges only for the errand.
      </p>

      {restaurants.length === 0 ? (
        <p className="text-muted mt-8 rounded-lg bg-white p-4 text-sm ring-1 ring-black/5">
          No restaurants are set up for scan delivery yet. Check back soon.
        </p>
      ) : open.length === 0 ? (
        <p className="mt-8 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
          Every scan restaurant is closed right now, so a Partner cannot redeem anything. Try again
          when one reopens.
        </p>
      ) : (
        <ScanForm restaurants={open} locations={locations ?? []} />
      )}
    </main>
  );
}
