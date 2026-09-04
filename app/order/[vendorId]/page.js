import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getVendorWithMenu, listDeliverableLocations } from '@/lib/customer';
import { OrderingGate } from '../page';
import MenuAndBasket from './menu-and-basket';

export const dynamic = 'force-dynamic';

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

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-40">
      <Link href="/order" className="text-muted text-sm underline underline-offset-4">
        ← All vendors
      </Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">{result.vendor.name}</h1>
      {!result.vendor.is_accepting_orders ? (
        <p className="mt-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This stall is closed right now, so you cannot place an order.
        </p>
      ) : null}

      <div className="mt-4">
        <OrderingGate me={me} />
      </div>

      <MenuAndBasket
        vendor={result.vendor}
        menu={result.menu}
        locations={locations ?? []}
        gate={
          me.can_order
            ? null
            : {
                href: me.authenticated
                  ? `/onboarding?next=${encodeURIComponent(`/order/${vendorId}`)}`
                  : `/login?next=${encodeURIComponent(`/order/${vendorId}`)}`,
                label: me.authenticated ? 'Add your student details' : 'Sign in to order',
              }
        }
      />
    </main>
  );
}
