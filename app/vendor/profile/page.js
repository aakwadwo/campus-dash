import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import {
  getMyVendors,
  listCategories,
  listImages,
  listCampusLocations,
  getPayoutDestination,
} from '@/lib/vendor';
import { vendorImageUrl } from '@/lib/verification/documents';
import { signOut } from '@/app/(auth)/login/actions';
import { PageHeader, Button, Callout, Card, Disclosure } from '@/app/ui';
import { StoreDetailsForm, ImageForms, PayoutForm } from './profile-forms';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Store' };

/**
 * Everything about the store that is not an order.
 *
 * PHOTOS FIRST, because they are what a customer sees and the thing a store
 * most often comes here to change. Details and payouts are set once and then
 * left alone, so they sit behind a tap with a one-line summary of what is set.
 * Opening and closing lives on Orders, where the store actually is when it
 * decides.
 *
 * Every write goes through vendor_update_profile() / vendor_add_image() and
 * friends, which re-check ownership in SQL. This page decides what to show,
 * never who may change it.
 */
export default async function VendorProfilePage() {
  await requireVendorStaff();

  const vendors = await getMyVendors();
  const vendor = vendors[0];
  if (!vendor) notFound();

  const [categories, locations, images, payout] = await Promise.all([
    listCategories(),
    listCampusLocations(),
    listImages(vendor.vendor_id),
    getPayoutDestination(),
  ]);

  const gallery = images.map((image) => ({ ...image, url: vendorImageUrl(image.storage_path) }));
  const category = categories.find((c) => c.id === vendor.category_id)?.name ?? null;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader title="Store" />

      {vendor.status !== 'ACTIVE' ? (
        <Callout tone="warn" className="mb-6">
          {vendor.status === 'SUSPENDED'
            ? 'Your store is suspended by Campus Dash. Customers cannot see it until it is reinstated.'
            : 'Your store is not live yet. Customers will see it once Campus Dash approves it.'}
        </Callout>
      ) : null}

      <section>
        <h2 className="mb-3 font-semibold">Photos</h2>
        <ImageForms vendorId={vendor.vendor_id} images={gallery} />
      </section>

      <Card className="mt-8 px-5">
        <Disclosure title="Details" summary={[vendor.name, category].filter(Boolean).join(' · ')}>
          <StoreDetailsForm vendor={vendor} categories={categories} locations={locations} />
        </Disclosure>

        <Disclosure
          title="Getting paid"
          summary={
            payout ? `${payout.momo_network} ending ${payout.account_last3}` : 'Not set up yet'
          }
          defaultOpen={!payout}
        >
          <PayoutForm vendor={vendor} destination={payout} />
          {payout ? (
            <p className="text-muted mt-4 text-sm leading-relaxed">
              {payout.split_ready
                ? 'Your share of each order is paid to you through Paystack when the customer pays. Paystack then settles it to this account on its own schedule.'
                : 'Not yet set up with our payment provider. Until it is, your share of each order is owed to you and Campus Dash pays it to this account.'}
            </p>
          ) : null}
        </Disclosure>
      </Card>

      {/* SIGN-OUT LIVES HERE. A store phone is often shared, and a vendor-only
          account has no account area to find it in. */}
      <form action={signOut} className="mt-10">
        <Button type="submit" variant="ghost" block className="text-muted">
          Sign out
        </Button>
      </form>
    </main>
  );
}
