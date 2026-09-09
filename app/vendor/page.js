import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getMyVendors } from '@/lib/vendor';
import { getCapabilities, myLanding } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * One account, one store — so this is almost always a redirect.
 *
 * The three other answers all matter, and all used to be the same silent bounce
 * to landingFor(): an applicant waiting on review, an applicant who was turned
 * down, and an account with no store at all. Each gets its own destination,
 * because "you landed on /admin" is not an answer to "where is my store".
 */
export default async function VendorIndexPage() {
  const me = await getCapabilities();

  if (me.vendor_ids?.length) {
    const vendors = await getMyVendors();
    if (vendors.length > 0) redirect(`/vendor/${vendors[0].vendor_id}`);
  }

  if (me.vendor_status && me.vendor_status !== 'NOT_APPLIED') {
    redirect('/vendor/application');
  }

  const home = await myLanding();
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">No store on this account</h1>
      <p className="text-muted mt-3 text-sm leading-relaxed">
        This account does not run a store yet, so there is no order board to show. Registering one
        takes a minute and does not affect anything else this account can do.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/vendor/signup"
          className="bg-brand-700 rounded-full px-5 py-2.5 text-sm font-semibold text-white"
        >
          Register a store
        </Link>
        <Link href={home} className="text-brand-700 py-2.5 text-sm font-medium">
          Go to your own area →
        </Link>
      </div>
    </main>
  );
}
