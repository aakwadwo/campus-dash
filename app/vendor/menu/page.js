import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import { getMyVendors, listMenu } from '@/lib/vendor';
import { vendorImageUrl } from '@/lib/verification/documents';
import { PageHeader } from '@/app/ui';
import MenuManager from './menu-manager';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Menu', robots: { index: false, follow: false } };

/**
 * The store's items, and which of them it is serving.
 *
 * ONE LIST, NOT TWO SCREENS. A persistent catalogue and an active menu are two
 * ideas, but a vendor manages them in one place — the item and its switch on
 * the same line — because a separate "catalogue" page would be a second place
 * to go and a second thing to keep in step.
 *
 * WHETHER THE STORE IS OPEN IS ON THIS PAGE, and it belongs here rather than
 * only on the board: turning the last item off closes the shop and turning one
 * on opens it, so the consequence has to be visible where the act happens.
 */
export default async function VendorMenuPage() {
  await requireVendorStaff();

  const vendors = await getMyVendors();
  const vendor = vendors[0];
  if (!vendor) notFound();

  const menu = await listMenu(vendor.vendor_id);
  const items = menu.map((item) => ({ ...item, image_url: vendorImageUrl(item.image_path) }));

  const on = items.filter((i) => i.is_active);
  const soldOut = on.filter((i) => !i.is_available).length;
  const open = vendor.is_accepting_orders;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader
        title="Menu"
        description={
          items.length === 0
            ? 'Add everything you sell. Turn things on when you are serving them, and off when you are not — nothing is deleted by a switch.'
            : open
              ? `Open, serving ${on.length} item${on.length === 1 ? '' : 's'}${
                  soldOut ? `, ${soldOut} sold out` : ''
                }.`
              : 'Closed. Turn an item on and your store opens.'
        }
      />

      <MenuManager vendorId={vendor.vendor_id} items={items} storeOpen={open} />
    </main>
  );
}
