import { notFound } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import SiteHeader from '../../site-header';
import { OrderingGate } from '../page';
import MenuAndBasket from './menu-and-basket';
import { Container, ImagePlaceholder, Callout, ArrowLeftIcon } from '../../ui';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }) {
  const { vendorId } = await params;
  const result = await getVendorWithMenu(vendorId).catch(() => null);
  return { title: result ? `${result.vendor.name} · Campus Dash` : 'Vendor · Campus Dash' };
}

/**
 * A stall's menu. Readable by anyone; orderable by a Customer.
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

  const locations = me.can_order ? await listDeliverableLocations() : [];
  const { vendor, menu } = result;
  const available = menu.filter((item) => item.is_available).length;

  return (
    <div className="min-h-dvh">
      <SiteHeader active="browse" />

      {/* The vendor "hero". Campus Dash has no photographs, so the ground is a
          designed placeholder rather than a grey box — see ImagePlaceholder. It
          is short and full-bleed on mobile, framed on desktop, which is how the
          references handle a store header. */}
      <div className="border-line border-b">
        <Container size="wide" className="pt-4 pb-5 sm:pt-6 sm:pb-7">
          <Link
            href="/order"
            className="text-muted hover:text-ink press-sm mb-3 -ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-full pr-3 pl-1 text-sm font-medium transition-colors sm:mb-5"
          >
            <ArrowLeftIcon className="size-4" />
            All vendors
          </Link>

          <div className="flex items-center gap-4">
            <ImagePlaceholder
              name={vendor.name}
              ratio="aspect-square"
              className="w-14 shrink-0 sm:w-24"
            />
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
            </div>
          </div>
        </Container>
      </div>

      <main className="pb-40">
        <Container size="wide" className="pt-6">
          {!vendor.is_accepting_orders ? (
            <Callout tone="warn" className="mb-6">
              This stall is closed right now, so you cannot place an order. You can still look
              through the menu.
            </Callout>
          ) : null}

          <OrderingGate me={me} className="mb-6" />

          <MenuAndBasket
            vendor={vendor}
            menu={menu}
            locations={locations ?? []}
            gate={
              me.can_order
                ? null
                : {
                    href: me.authenticated
                      ? `/onboarding?next=${encodeURIComponent(`/order/${vendorId}`)}`
                      : `/login?next=${encodeURIComponent(`/order/${vendorId}`)}`,
                    label: me.authenticated ? 'Add your details' : 'Sign in to order',
                  }
            }
          />
        </Container>
      </main>
    </div>
  );
}
