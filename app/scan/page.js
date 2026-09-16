import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { listScanRestaurants } from '@/lib/scan';
import { vendorImageUrl } from '@/lib/verification/documents';
import SiteHeader from '@/app/site-header';
import SiteFooter from '@/app/site-footer';
import { Container, Callout, BackLink, VendorCard } from '@/app/ui';

export const metadata = {
  title: 'Use a meal scan',
  description:
    'Order with your campus meal scan from stores around Academic City. Collect it yourself, or have a Campus Dash Partner bring it to you.',
  robots: { index: false, follow: false },
};
export const dynamic = 'force-dynamic';

/**
 * Stores that take a meal scan.
 *
 * WHY THIS PAGE IS GATED WHEN /order IS NOT. Browsing a menu costs nobody
 * anything, so the marketplace is open. This route's whole purpose is to take a
 * private document off somebody's phone, and there is no version of that which
 * makes sense for a visitor with no account. The gate is here rather than at
 * the price, which is also why scan_restaurants() itself stays public.
 *
 * A store appears only when it has something eligible on its menu. A store with
 * the switch on and nothing marked is a dead end, and listing it sends somebody
 * to an empty menu to find that out.
 */
export default async function ScanPage() {
  const me = await getCapabilities();

  if (!me.authenticated) redirect('/login?next=%2Fscan');
  // Same rule as ordering: a verified address is an identity, ordering is a
  // capability, and it is acquired by completing student onboarding.
  if (!me.can_order) redirect('/signup?next=%2Fscan');

  const restaurants = await listScanRestaurants().catch(() => []);
  const stores = restaurants.map((store) => ({
    ...store,
    image_url: vendorImageUrl(store.image_path),
  }));
  const open = stores.filter((store) => store.is_accepting_orders);

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex-1 pb-24 sm:pb-16">
        <Container size="wide" className="pt-6 sm:pt-10">
          <BackLink href="/order" className="mb-4 sm:mb-5">
            All stores
          </BackLink>

          <h1 className="text-display text-2xl font-semibold sm:text-4xl">Use a meal scan</h1>
          <p className="text-muted mt-2 max-w-prose leading-relaxed">
            Your scan pays the store for the food. Campus Dash charges only for putting the order
            through and, if you want it, for a Partner to bring it to you.
          </p>

          {stores.length === 0 ? (
            <Callout className="mt-8">
              No stores are set up for meal scans yet. Check back shortly.
            </Callout>
          ) : open.length === 0 ? (
            <Callout tone="warn" className="mt-8">
              Every store that takes meal scans is closed right now. Try again when one reopens.
            </Callout>
          ) : (
            <ul className="mt-7 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
              {stores.map((store) => (
                <li key={store.id}>
                  {/* The same card the marketplace uses. A closed store still
                      appears, desaturated and unlinked, because knowing a place
                      exists but is shut is useful and a store that vanishes at
                      9pm reads as one that has left. */}
                  <VendorCard
                    vendor={{ name: store.name, is_accepting_orders: store.is_accepting_orders }}
                    href={`/scan/${store.id}`}
                    imageUrl={store.image_url}
                    meta={
                      <span>
                        {store.eligible_item_count}{' '}
                        {store.eligible_item_count === 1 ? 'item' : 'items'} on scan
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
