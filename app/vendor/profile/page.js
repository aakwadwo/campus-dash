import { notFound } from 'next/navigation';
import Link from 'next/link';
import { requireVendorStaff } from '@/lib/auth/session';
import {
  getMyVendors,
  listCategories,
  listImages,
  listCampusLocations,
  getPayoutDestination,
} from '@/lib/vendor';
import { vendorImageUrl } from '@/lib/verification/documents';
import { Panel, PageHeader, Badge } from '@/app/ui';
import { StoreDetailsForm, ImageForms, PayoutForm } from './profile-forms';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Store details · Campus Dash' };

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
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <PageHeader
        eyebrow="Vendor"
        title="Store details"
        description="What students see when they find you."
        back={{ href: `/vendor/${vendor.vendor_id}`, label: 'Orders' }}
      />

      <div className="mt-6 space-y-6">
        <Panel
          title="Status"
          description="Approval is Campus Dash's decision. Opening and closing is yours."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={vendor.status === 'ACTIVE' ? 'good' : 'warn'}>{vendor.status}</Badge>
            <Badge tone={vendor.is_accepting_orders ? 'good' : 'neutral'}>
              {vendor.is_accepting_orders ? 'Open' : 'Closed'}
            </Badge>
          </div>
          <p className="text-muted mt-3 text-sm leading-relaxed">
            Closing the store stops NEW orders arriving. Orders already in your kitchen are
            unaffected and still have to be finished.
          </p>
        </Panel>

        <Panel title="Details">
          <StoreDetailsForm vendor={vendor} categories={categories} locations={locations} />
        </Panel>

        <Panel title="Photos" description="Shown on your storefront, to anyone browsing.">
          <ImageForms vendorId={vendor.vendor_id} images={gallery} />
        </Panel>

        <Panel
          title="Getting paid"
          description="The mobile money account your food money is sent to."
        >
          <PayoutForm vendor={vendor} destination={payout} />
          {payout ? (
            <p className="text-muted mt-4 text-sm leading-relaxed">
              {payout.split_ready
                ? 'Set up. When a customer pays, your share of the order goes straight to this account. Campus Dash keeps only the service fee and the delivery fee.'
                : 'Saved, and being registered with our payment provider. Until that finishes, your share is held by Campus Dash and settled in the daily run.'}
            </p>
          ) : null}
        </Panel>

        <Panel title="Menu" description="Items, prices and what is available today.">
          <p className="text-muted text-sm leading-relaxed">
            Menu items are managed from your order board.{' '}
            <Link href={`/vendor/${vendor.vendor_id}`} className="text-brand-700 font-medium">
              Go to orders
            </Link>
          </p>
        </Panel>
      </div>
    </main>
  );
}
