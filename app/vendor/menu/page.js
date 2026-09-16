import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import { getMyVendors, listMenu } from '@/lib/vendor';
import { vendorImageUrl } from '@/lib/verification/documents';
import { PageHeader } from '@/app/ui';
import MenuManager from './menu-manager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Menu', robots: { index: false, follow: false } };

/**
 * The store's menu, owned by the store.
 *
 * IT USED TO BE READ-ONLY. A vendor could mark an item sold out and nothing
 * else: adding a dish, fixing a typo in a price or putting a photograph on
 * something meant emailing Campus Dash. The stated reason was that a price
 * must not move under an order somebody is halfway through placing — which
 * price_order() had already made impossible by snapshotting every figure onto
 * the order at submission. The restriction protected nothing and cost a cook
 * the ability to run their own shop.
 */
export default async function VendorMenuPage() {
  await requireVendorStaff();

  const vendors = await getMyVendors();
  const vendor = vendors[0];
  if (!vendor) notFound();

  const menu = await listMenu(vendor.vendor_id);
  const items = menu.map((item) => ({ ...item, image_url: vendorImageUrl(item.image_path) }));

  const soldOut = items.filter(
    (i) => !i.is_available && i.unavailable_reason === 'SOLD_OUT'
  ).length;
  const withdrawn = items.filter((i) => i.unavailable_reason === 'WITHDRAWN').length;
  const on = items.filter((i) => i.is_available).length;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader
        title="Menu"
        description={
          items.length === 0
            ? 'Nothing on your menu yet. Add your first item and it appears to customers straight away.'
            : `${on} on the menu${soldOut ? `, ${soldOut} sold out` : ''}${
                withdrawn ? `, ${withdrawn} off` : ''
              }.`
        }
      />

      <MenuManager vendorId={vendor.vendor_id} items={items} />
    </main>
  );
}
