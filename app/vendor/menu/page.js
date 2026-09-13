import { notFound } from 'next/navigation';
import { requireVendorStaff } from '@/lib/auth/session';
import { getMyVendors, listMenu } from '@/lib/vendor';
import { PageHeader, Panel } from '@/app/ui';
import MenuAvailability from './menu-availability';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Menu · Campus Dash' };

/**
 * Today's menu: what is on, and what has run out.
 *
 * A VENDOR DOES NOT CREATE OR PRICE ITEMS HERE. An administrator does that, so
 * a catalogue cannot be rewritten mid-service and a price cannot move under an
 * order somebody is halfway through placing. What a vendor owns is whether
 * something is available right now, which is the thing that changes forty times
 * a day and which nobody should have to email about.
 */
export default async function VendorMenuPage() {
  await requireVendorStaff();

  const vendors = await getMyVendors();
  const vendor = vendors[0];
  if (!vendor) notFound();

  const menu = await listMenu(vendor.vendor_id);
  const soldOut = menu.filter((item) => !item.is_available).length;

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      <PageHeader
        title="Menu"
        description={
          menu.length === 0
            ? 'Nothing on your menu yet. Campus Dash adds items for you, so ask us and we will set them up.'
            : soldOut === 0
              ? 'Everything is available. Mark anything you run out of as sold out.'
              : `${soldOut} of ${menu.length} sold out. Students can see these but cannot order them.`
        }
      />

      <Panel title="Available today">
        <MenuAvailability vendorId={vendor.vendor_id} menu={menu} />
      </Panel>

      <p className="text-muted mt-4 text-sm leading-relaxed">
        Sold-out items come back on automatically the next time you open the store. To add an item
        or change a price, contact Campus Dash.
      </p>
    </main>
  );
}
