import { notFound } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import { getPlatformConfig } from '@/lib/platform-config';
import SiteHeader from '../../site-header';
import { OrderingGate } from '../page';
import MenuAndBasket from './menu-and-basket';
import { Container, ImagePlaceholder, Callout, BackLink } from '../../ui';

export const dynamic = 'force-dynamic';

/**
 * A STORE PAGE IS PUBLIC AND WORTH FINDING. Somebody searching for a restaurant
 * by name should land on its menu, so this is the one dynamic route in the
 * sitemap and the one that earns a real description.
 */
export async function generateMetadata({ params }) {
  const { vendorId } = await params;
  const result = await getVendorWithMenu(vendorId).catch(() => null);
  if (!result) return { title: 'Store' };

  const { vendor } = result;
  const description =
    vendor.description?.trim() ||
    `Order from ${vendor.name} around Academic City. Collect it yourself, or have a Campus Dash Partner bring it to you.`;

  return {
    title: vendor.name,
    description,
    alternates: { canonical: `/order/${vendorId}` },
    openGraph: { title: vendor.name, description, url: `/order/${vendorId}` },
  };
}

/**
 * A store's menu. Readable by anyone; orderable by a Customer.
 *
 * The gate is passed down rather than applied here so that someone signed out
 * can still build a basket and see prices — losing that on the way to a login
 * screen is how a marketplace loses people who were nearly ready to buy.
 */
export default async function VendorMenuPage({ params }) {
  const { vendorId } = await params;
  const me = await getCapabilities();

  const result = await getVendorWithMenu(vendorId);
  if (!result) notFound();

  // Where a Partner could bring it. Fetched here rather than on demand so the
  // delivery option does not pop a second loading state inside the checkout.
  const [locations, platform] = await Promise.all([
    listDeliverableLocations().catch(() => []),
    getPlatformConfig(),
  ]);

  const { vendor } = result;
  // The dish photographs, resolved here: a client component has no business
  // reading configuration, and a server component cannot hand it a function.
  const menu = result.menu.map((item) => ({
    ...item,
    image_url: vendorImageUrl(item.image_path),
  }));
  const available = menu.filter((item) => item.is_available).length;
  const images = (vendor.images ?? []).map((image) => ({
    ...image,
    url: vendorImageUrl(image.storage_path),
  }));

  return (
    <div className="min-h-dvh">
      <SiteHeader active="browse" />

      {/* The vendor "hero". A store that has uploaded photographs gets them; one
          that has not gets the designed placeholder rather than a grey box —
          see ImagePlaceholder. Short and full-bleed on mobile, framed on
          desktop, which is how the references handle a store header. */}
      <div className="border-line border-b">
        <Container size="wide" className="pt-4 pb-5 sm:pt-6 sm:pb-7">
          <BackLink href="/order" className="mb-3 sm:mb-5">
            All vendors
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
              <h1 className="text-display text-xl font-semibold break-words sm:text-4xl">
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
                  {available} {available === 1 ? 'item' : 'items'} available
                </span>
              </p>
              {vendor.description ? (
                <p className="text-muted mt-1.5 text-sm leading-relaxed">{vendor.description}</p>
              ) : null}
            </div>
          </div>

          {images.length > 1 ? (
            <ul className="-mx-4 mt-5 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
              {images.slice(1).map((image) => (
                <li key={image.id} className="shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt={image.caption ?? ''}
                    loading="lazy"
                    className="rounded-card h-28 w-40 object-cover sm:h-36 sm:w-52"
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </Container>
      </div>

      <main className="pb-40">
        <Container size="wide" className="pt-6">
          {!vendor.is_accepting_orders ? (
            <Callout tone="warn" className="mb-6">
              This store is closed right now, so you cannot place an order. You can still look
              through the menu.
            </Callout>
          ) : null}

          <OrderingGate me={me} className="mb-6" />

          {/* THE INTENDED ORDER IS PRESERVED. Whichever way an unauthenticated
              visitor is sent, `next` brings them back to this store's menu with
              their basket still in the page — losing it on the way to a sign-up
              screen is how a marketplace loses people who were nearly ready. */}
          <MenuAndBasket
            vendor={vendor}
            menu={menu}
            locations={locations}
            deliveryAvailable={platform.partner_delivery_enabled !== false}
            // For the LABEL on the delivery option only. The figure that is
            // charged always comes back from quote_order().
            deliveryFeePesewas={Number(platform.delivery_fee_pesewas ?? 0)}
            gate={
              me.can_order
                ? null
                : {
                    href: `/signup?next=${encodeURIComponent(`/order/${vendorId}`)}`,
                    label: me.authenticated ? 'Finish signing up' : 'Sign up to order',
                  }
            }
          />
        </Container>
      </main>
    </div>
  );
}
