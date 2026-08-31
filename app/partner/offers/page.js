import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getOffers, getActiveDelivery, getMyApplication } from '@/lib/partner';
import { formatPesewas } from '@/lib/util/money';
import OfferList from './offer-list';

export const dynamic = 'force-dynamic';

export default async function PartnerOffersPage() {
  const me = await getCapabilities();
  if (!me.is_partner) redirect('/partner');

  const [active, application] = await Promise.all([getActiveDelivery(), getMyApplication()]);
  if (active) redirect('/partner/delivery');

  const offers = application?.is_available ? await getOffers() : [];

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <Link href="/partner" className="text-muted text-sm underline underline-offset-4">
        ← Partner
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">Available deliveries</h1>

      {!application?.is_available ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          You are offline, so no offers are shown. Go online from the Partner home screen.
        </p>
      ) : (
        <OfferList offers={offers ?? []} />
      )}

      <p className="text-muted mt-6 text-xs leading-relaxed">
        Every job here has food already cooked and waiting — you are never sent to stand at a stall.
        The exact room is released once the vendor hands the order to you.
      </p>
    </main>
  );
}

export { formatPesewas };
