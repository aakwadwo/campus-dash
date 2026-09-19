import { notFound } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import { getPlatformConfig } from '@/lib/platform-config';
import SiteHeader from '../../site-header';
import { OrderingGate } from '../page';
import MenuAndBasket from './menu-and-basket';
import { Container, ImagePlaceholder, BackLink } from '../../ui';
import { catalogueLabel } from '@/lib/util/catalogue';

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
 * A store. Readable by anyone; orderable by a Customer.
 *
 * The gate is passed down rather than applied here so that someone signed out
 * can still build a basket and see prices. Losing that on the way to a login
 * screen is how a marketplace loses people who were nearly ready to buy.
 */
export default async function VendorMenuPage({ params }) {
  const { vendorId } = await params;
  const me = await getCapabilities();

  const result = await getVendorWithMenu(vendorId);
  if (!result) notFound();

  // Where a Partner could bring it. Fetched here rather than on demand so the
  // Partner option does not pop a second loading state inside the checkout.
  const [locations, platform] = await Promise.all([
    listDeliverableLocations().catch(() => []),
    getPlatformConfig(),
  ]);

  const { vendor } = result;
  // Items only; the dishes are listed by name and price. Store photos are the
  // pictures, and they belong to the store rather than to each line.
  const menu = result.menu;
  const images = (vendor.images ?? []).map((image) => ({
    ...image,
    url: vendorImageUrl(image.storage_path),
  }));
  const [primary, ...more] = images;
  const label = catalogueLabel(vendor.category_slug);

  // THE STORE'S HEADER, handed to the menu so it can step aside at checkout:
  // a checkout under a store's photo had two back links and began mid-page.
  const hero = (
    <div className="mb-8">
      <BackLink href="/order" className="mb-3 sm:mb-5">
        Browse
      </BackLink>

      {/* THE STORE'S MAIN PHOTO, large, because this is the page somebody
              opened to see the place. The rest of its photos follow in a row
              underneath: they are the reason to open a store rather than read its
              card, so they live here and nowhere else. */}
      <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:items-end sm:gap-8">
        {primary ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={primary.url}
            alt=""
            className="rounded-panel bg-surface-2 aspect-[16/10] w-full object-cover"
          />
        ) : (
          <ImagePlaceholder name={vendor.name} className="rounded-panel" />
        )}

        <div className="min-w-0">
          <h1 className="text-display text-2xl font-semibold break-words sm:text-4xl">
            {vendor.name}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
            {vendor.is_accepting_orders ? (
              <span className="text-good inline-flex items-center gap-1.5 font-semibold">
                <span className="bg-good size-1.5 rounded-full" />
                Open
              </span>
            ) : (
              <span className="bg-ink rounded-full px-2.5 py-0.5 text-xs font-semibold text-white">
                Closed
              </span>
            )}
            {vendor.category_name ? (
              <>
                <span className="text-faint">·</span>
                <span className="text-muted">{vendor.category_name}</span>
              </>
            ) : null}
            {vendor.location_path ? (
              <>
                <span className="text-faint">·</span>
                <span className="text-muted">{vendor.location_path}</span>
              </>
            ) : null}
          </p>
          {vendor.description ? (
            <p className="text-muted mt-2 leading-relaxed">{vendor.description}</p>
          ) : null}
        </div>
      </div>

      {more.length ? (
        <ul className="-mx-4 mt-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {more.map((image) => (
            <li key={image.id} className="shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.caption ?? ''}
                loading="lazy"
                className="rounded-card bg-surface-2 h-24 w-36 object-cover sm:h-32 sm:w-48"
              />
            </li>
          ))}
        </ul>
      ) : null}

      {!vendor.is_accepting_orders ? (
        <p className="text-muted mt-6 text-sm">Closed right now. You can look, but not order.</p>
      ) : null}
      <OrderingGate me={me} className="mt-6" />
    </div>
  );

  return (
    <div className="min-h-dvh">
      <SiteHeader active="browse" />

      <main className="pb-40">
        <Container size="wide" className="pt-4 sm:pt-6">
          {/* THE INTENDED ORDER IS PRESERVED. Whichever way an unauthenticated
              visitor is sent, `next` brings them back to this store with their
              basket still in the page. */}
          <MenuAndBasket
            header={hero}
            vendor={vendor}
            menu={menu}
            label={label}
            locations={locations}
            deliveryAvailable={platform.partner_delivery_enabled !== false}
            // For the LABEL on the Partner option only. The figure that is
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
