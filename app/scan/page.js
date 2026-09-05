import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { listScanRestaurants } from '@/lib/scan';
import { listDeliverableLocations } from '@/lib/customer';
import ScanForm from './scan-form';
import SiteHeader from '@/app/site-header';
import { Container } from '@/app/ui';

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
    <div className="min-h-dvh">
      <SiteHeader active="browse" />
      <main className="pb-24 sm:pb-16">
        <Container size="narrow" className="pt-8 sm:pt-12">
          <h1 className="text-display text-3xl font-semibold sm:text-4xl">Scan delivery</h1>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            Already have a meal scan? Send a Partner to redeem it and bring the food to you. You
            have paid for the food already, so Campus Dash charges only for the errand.
          </p>

          {restaurants.length === 0 ? (
            <p className="text-muted rounded-card bg-surface ring-line mt-8 p-4 text-sm ring-1">
              No restaurants are set up for scan delivery yet. Check back soon.
            </p>
          ) : open.length === 0 ? (
            <p className="rounded-card bg-warn-bg text-warn mt-8 p-4 text-sm">
              Every scan restaurant is closed right now, so a Partner cannot redeem anything. Try
              again when one reopens.
            </p>
          ) : (
            <ScanForm restaurants={open} locations={locations ?? []} />
          )}
        </Container>
      </main>
    </div>
  );
}
