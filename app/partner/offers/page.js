import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getOffers, getActiveDeliveries, getMyApplication, getCapacity } from '@/lib/partner';
import { getPollIntervals } from '@/lib/platform-config';
import { formatPesewas } from '@/lib/util/money';
import OfferList from './offer-list';
import { BackLink, Callout, ButtonLink } from '@/app/ui';

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
    <main className="mx-auto max-w-2xl px-4 pt-3 pb-16 sm:px-6 sm:pt-6">
      <BackLink href="/partner">Partner home</BackLink>
      <h1 className="text-display mt-3 text-2xl font-semibold sm:text-3xl">Available orders</h1>
      <p className="text-muted mt-1.5 text-sm">
        Paid for and waiting for a Partner. You can carry {capacity.maxActive} at once
        {active.length ? `, and you have ${active.length} now` : ''}.
      </p>

      {!application?.is_available ? (
        <Callout tone="warn" className="mt-5">
          <p className="font-semibold">You are offline</p>
          <p className="mt-1">Go online from Partner home to see orders here.</p>
          <ButtonLink href="/partner" size="sm" variant="secondary" className="mt-3">
            Go to Partner home
          </ButtonLink>
        </Callout>
      ) : (
        <OfferList offers={offers ?? []} pollMs={intervals.partnerMs} />
      )}

      <p className="text-muted mt-6 text-sm leading-relaxed">
        Some orders are still being prepared. Take one early and the store tells you when it is
        ready. The customer&apos;s first name, room and phone number appear once an order is yours,
        and only while you are carrying it.
      </p>
    </main>
  );
}

export { formatPesewas };
