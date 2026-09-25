import { redirect } from 'next/navigation';
import { ButtonLink, TextLink } from '@/app/ui';
import { getMyVendors } from '@/lib/vendor';
import { getCapabilities, myLanding } from '@/lib/auth/session';
import { vendorStoreId } from '@/lib/auth/landing';

export const dynamic = 'force-dynamic';

const HOME_LABEL = {
  '/admin': 'Go to the admin console',
  '/order': 'Order food instead',
  '/partner': 'Go to Partner deliveries',
  '/partner/apply': 'Apply to be a Partner',
  '/signup': 'Finish signing up',
};

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

  if (vendorStoreId(me)) {
    const vendors = await getMyVendors();
    if (vendors.length > 0) redirect(`/vendor/${vendors[0].vendor_id}`);
  }

  if (me.vendor_status && me.vendor_status !== 'NOT_APPLIED') {
    redirect('/vendor/application');
  }

  const home = await myLanding();
  return (
    <main className="mx-auto max-w-2xl px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">No store on this account</h1>
      <p className="text-muted mt-3 leading-relaxed">
        This account does not run a store yet, so there are no orders to show. Registering one takes
        a minute and does not change anything else this account can do.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
        <ButtonLink href="/vendor/signup" size="lg">
          Register a store
        </ButtonLink>
        <TextLink href={home} className="inline-flex min-h-11 items-center">
          {HOME_LABEL[home] ?? 'Go to Campus Dash'}
        </TextLink>
      </div>
    </main>
  );
}
