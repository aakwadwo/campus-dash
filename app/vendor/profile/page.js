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
import { Panel, PageHeader, Badge, Button } from '@/app/ui';
import { StoreDetailsForm, ImageForms, PayoutForm } from './profile-forms';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Store' };

/**
 * Everything about the store that is not an order.
 *
 * A vendor owns these facts and should not have to email an administrator to
 * fix a typo in their own shop name. Every write goes through
 * vendor_update_profile() / vendor_add_image(), which re-check ownership in
 * SQL — this page decides what to show, never who may change it.
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

  // The public URL is resolved HERE. A server component cannot hand a function
  // to a client one, and a client component has no business reading config.
  const gallery = images.map((image) => ({ ...image, url: vendorImageUrl(image.storage_path) }));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader
        title="Store"
        description="What students see when they find you, and how you get paid."
      />

      <div className="space-y-6">
        <Panel title="Status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={vendor.status === 'ACTIVE' ? 'good' : 'warn'}>
              {vendor.status === 'ACTIVE' ? 'Approved' : 'Not approved'}
            </Badge>
            <Badge tone={vendor.is_accepting_orders ? 'good' : 'neutral'}>
              {vendor.is_accepting_orders ? 'Open for orders' : 'Closed'}
            </Badge>
          </div>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            Open and close the store from Orders. Closing stops new orders arriving; orders already
            in your kitchen still need finishing.
          </p>
        </Panel>

        <Panel title="Details">
          <StoreDetailsForm vendor={vendor} categories={categories} locations={locations} />
        </Panel>

        <Panel title="Photos" description="Shown on your storefront, to anyone browsing.">
          <ImageForms vendorId={vendor.vendor_id} images={gallery} />
        </Panel>

        <Panel title="Getting paid" description="The mobile money account your sales are sent to.">
          <PayoutForm vendor={vendor} destination={payout} />
          {payout ? (
            <p className="text-muted mt-4 text-sm leading-relaxed">
              {payout.split_ready
                ? 'Set up. When a customer pays, your amount for the food goes straight to this account.'
                : 'Saved, and being registered with our payment provider. Until that finishes, Campus Dash holds your amount and settles it in the daily run.'}
            </p>
          ) : null}
        </Panel>

        {/* SIGN-OUT LIVES HERE. A store phone is often shared, and a vendor-only
            account has no account area to find it in. */}
        <form action={signOut} className="border-line border-t pt-6">
          <Button type="submit" variant="danger" block>
            Sign out
          </Button>
        </form>
      </div>
    </main>
  );
}
