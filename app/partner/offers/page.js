import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getOffers, getActiveDelivery, getMyApplication } from '@/lib/partner';
import { getPollIntervals } from '@/lib/platform-config';
import { formatPesewas } from '@/lib/util/money';
import OfferList from './offer-list';

export const dynamic = 'force-dynamic';

export default async function PartnerOffersPage() {
  const me = await getCapabilities();
  if (!me.is_partner) redirect('/partner');

  const [active, application] = await Promise.all([getActiveDelivery(), getMyApplication()]);
  if (active) redirect('/partner/delivery');

  const [offers, intervals] = await Promise.all([
    application?.is_available ? getOffers() : Promise.resolve([]),
    getPollIntervals(),
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-16">
      <Link href="/partner" className="text-muted text-sm underline underline-offset-4">
        ← Partner
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Available deliveries</h1>

      {!application?.is_available ? (
        <p className="rounded-card bg-warn-bg text-warn mt-4 px-4 py-3 text-sm">
          You are offline, so no offers are shown. Go online from the Partner home screen.
        </p>
      ) : (
        <OfferList offers={offers ?? []} pollMs={intervals.partnerMs} />
      )}

      <p className="text-muted mt-6 text-xs leading-relaxed">
        Every job here has food already cooked and waiting. You are never sent to stand at a stall.
        The exact room is released once the vendor hands the order to you.
      </p>
    </main>
  );
}

export { formatPesewas };
