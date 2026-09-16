import { notFound, redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { listScanMenu } from '@/lib/scan';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import { getPlatformConfig } from '@/lib/platform-config';
import { vendorImageUrl } from '@/lib/verification/documents';
import SiteHeader from '@/app/site-header';
import { Container, ImagePlaceholder, Callout, BackLink } from '@/app/ui';
import ScanOrderBuilder from './scan-order-builder';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { vendorId } = await params;
  const result = await getVendorWithMenu(vendorId).catch(() => null);
  return {
    title: result ? `Meal scan at ${result.vendor.name}` : 'Meal scan',
    robots: { index: false, follow: false },
  };
}

/**
 * Ordering with a meal scan, at one store.
 *
 * The same shape as the food checkout, deliberately: pick items, choose how you
 * want it, see the price, pay. The scan is the one extra thing, and it is asked
 * for in the same screen rather than in a separate flow, because "I am using my
 * scan" is a payment method rather than a different product.
 *
 * THE MENU IS THE ELIGIBLE HALF ONLY. scan_menu() returns the items this store
 * honours a scan for, so nothing on this page can be added and then refused at
 * the counter. price_scan_order() re-checks each one anyway.
 */
export default async function ScanVendorPage({ params }) {
  const { vendorId } = await params;
  const me = await getCapabilities();

  if (!me.authenticated) redirect(`/login?next=${encodeURIComponent(`/scan/${vendorId}`)}`);
  if (!me.can_order) redirect(`/signup?next=${encodeURIComponent(`/scan/${vendorId}`)}`);

  const [result, menu, locations, platform] = await Promise.all([
    getVendorWithMenu(vendorId).catch(() => null),
    listScanMenu(vendorId).catch(() => []),
    listDeliverableLocations().catch(() => []),
    getPlatformConfig(),
  ]);

  if (!result) notFound();

  const { vendor } = result;
  const available = menu
    .filter((item) => item.is_available)
    .map((item) => ({ ...item, image_url: vendorImageUrl(item.image_path) }));
  const images = (vendor.images ?? []).map((image) => ({
    ...image,
    url: vendorImageUrl(image.storage_path),
  }));

  return (
    <div className="min-h-dvh">
      <SiteHeader />

      <div className="border-line border-b">
        <Container size="wide" className="pt-4 pb-5 sm:pt-6 sm:pb-7">
          <BackLink href="/scan" className="mb-3 sm:mb-5">
            Stores that take scans
          </BackLink>

          <div className="flex items-center gap-4">
            {images[0] ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={images[0].url}
                alt=""
                className="rounded-card w-14 shrink-0 object-cover sm:w-24"
                style={{ aspectRatio: '1 / 1' }}
              />
            ) : (
              <ImagePlaceholder
                name={vendor.name}
                ratio="aspect-square"
                className="w-14 shrink-0 sm:w-24"
              />
            )}
            <div className="min-w-0">
              <p className="text-muted text-sm font-semibold">Paying with a meal scan</p>
              <h1 className="text-display mt-0.5 text-xl font-semibold break-words sm:text-4xl">
                {vendor.name}
              </h1>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
                {vendor.is_accepting_orders ? (
                  <span className="text-good inline-flex items-center gap-1.5 font-semibold">
                    <span className="bg-good size-1.5 rounded-full" />
                    Open now
                  </span>
                ) : (
                  <span className="text-muted font-semibold">Closed right now</span>
                )}
                <span className="text-faint">·</span>
                <span className="text-muted">
                  {available.length} {available.length === 1 ? 'item' : 'items'} on scan
                </span>
              </p>
            </div>
          </div>
        </Container>
      </div>

      <main className="pb-40">
        <Container size="wide" className="pt-6">
          {!vendor.is_accepting_orders ? (
            <Callout tone="warn" className="mb-6">
              This store is closed right now, so you cannot put a scan through. You can still look
              at what they take.
            </Callout>
          ) : null}

          {available.length === 0 ? (
            <Callout className="mb-6">
              {vendor.name} takes meal scans but has not marked anything available right now.
            </Callout>
          ) : null}

          <ScanOrderBuilder
            vendor={{
              vendor_id: vendorId,
              name: vendor.name,
              is_accepting_orders: vendor.is_accepting_orders,
            }}
            menu={available}
            locations={locations}
            partnerAvailable={platform.partner_delivery_enabled !== false}
            // For the LABEL on the Partner option only. What is charged always
            // comes back from quote_scan_order().
            partnerFeePesewas={Number(platform.delivery_fee_pesewas ?? 0)}
            packFeePesewas={Number(platform.scan_pack_fee_pesewas ?? 0)}
          />
        </Container>
      </main>
    </div>
  );
}
