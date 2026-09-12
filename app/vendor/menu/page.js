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
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <PageHeader
        eyebrow="Vendor"
        title="Menu"
        description={
          menu.length === 0
            ? 'Nothing on your menu yet. Campus Dash adds items for you — ask us and we will set them up.'
            : soldOut === 0
              ? 'Everything is available. Mark anything you run out of as sold out.'
              : `${soldOut} of ${menu.length} marked sold out.`
        }
        back={{ href: `/vendor/${vendor.vendor_id}`, label: 'Orders' }}
      />

      <div className="mt-6 space-y-6">
        <Panel
          title="What you have today"
          description="A sold-out item still shows on your storefront, marked sold out, so students can see you sell it. They just cannot order it."
        >
          <MenuAvailability vendorId={vendor.vendor_id} menu={menu} />
        </Panel>

        <p className="text-muted text-sm leading-relaxed">
          Everything here goes back to available the next time you open the store, so you never have
          to walk through the menu in the morning.
        </p>
      </div>
    </main>
  );
}
