import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getOffers, getActiveDeliveries, getMyApplication, getCapacity } from '@/lib/partner';
import { getPollIntervals } from '@/lib/platform-config';
import { formatPesewas } from '@/lib/util/money';
import OfferList from './offer-list';

export const dynamic = 'force-dynamic';

export default async function PartnerOffersPage() {
  const me = await getCapabilities();
  if (!me.is_partner) redirect('/partner');

  const [active, application, capacity] = await Promise.all([
    getActiveDeliveries(),
    getMyApplication(),
    getCapacity(),
  ]);
  // Only at the LIMIT is the offer list pointless. Carrying one still leaves
  // room for another whenever the configured maximum is above one, and the
  // claim would refuse anyway — this only avoids offering a button that cannot
  // succeed.
  if (active.length >= capacity.maxActive) redirect('/partner');

  const [offers, intervals] = await Promise.all([
    application?.is_available ? getOffers() : Promise.resolve([]),
    getPollIntervals(),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-16">
      <Link href="/partner" className="text-muted text-sm underline underline-offset-4">
        ← Partner
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Available orders</h1>

      {!application?.is_available ? (
        <p className="rounded-card bg-warn-bg text-warn mt-4 px-4 py-3 text-sm">
          You are offline, so nothing is shown here. Go online from the Partner home screen.
        </p>
      ) : (
        <OfferList offers={offers ?? []} pollMs={intervals.partnerMs} />
      )}

      <p className="text-muted mt-6 text-xs leading-relaxed">
        Every order here has been paid for. Some are still being prepared — take one early and the
        store will tell you when it is ready, so you are never left standing at a counter. You can
        carry {capacity.maxActive} at once. The customer&apos;s first name, exact room and phone
        number appear as soon as an order is yours, and only while you are carrying it.
      </p>
    </main>
  );
}

export { formatPesewas };
