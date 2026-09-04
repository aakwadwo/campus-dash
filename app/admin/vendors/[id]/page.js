import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { formatPesewas, cedisInputFromPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable } from '../../ui';
import VendorSettingsForm from './vendor-settings-form';
import VendorStatusForm from './vendor-status-form';
import VendorScansForm from './vendor-scans-form';
import VendorStaffForms from './vendor-staff-forms';
import MenuForms from './menu-forms';

export const dynamic = 'force-dynamic';

/**
 * NO SUCH VENDOR AND WE COULD NOT ASK ARE DIFFERENT ANSWERS.
 *
 * `.maybeSingle()` rather than `.single()` precisely so the two can be told
 * apart: no row is `data: null, error: null` and becomes a 404, while a real
 * failure carries an error and gets the Unavailable state. `.single()` reports
 * both as an error, and 404-ing a vendor that exists sends an operator looking
 * for a record they were told is gone.
 *
 * The three secondary reads are caught separately. A menu that will not load
 * should cost the reader the menu panel, not the status and staff controls
 * above it — and a null menu must never render as "No menu items yet", which is
 * an invitation to type the whole thing in again.
 */
export default async function VendorDetailPage({ params }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: vendor, error: vendorError } = await supabase
    .from('vendors')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (vendorError) {
    return (
      <>
        <p className="text-muted mb-2 text-sm">
          <Link href="/admin/vendors" className="underline underline-offset-4">
            Vendors
          </Link>
        </p>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Vendor</h1>
        <Unavailable>
          This vendor could not be loaded. That is not the same as it not existing — do not create a
          replacement from this screen.
        </Unavailable>
      </>
    );
  }
  if (!vendor) notFound();

  const [staffResult, menuResult, locationsResult] = await Promise.all([
    supabase.from('vendor_users').select('user_id, created_at').eq('vendor_id', id),
    supabase.from('menu_items').select('*').eq('vendor_id', id).order('sort_order'),
    supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
  ]);

  const staff = staffResult.error ? null : (staffResult.data ?? []);
  const menu = menuResult.error ? null : (menuResult.data ?? []);
  const locations = locationsResult.error ? null : (locationsResult.data ?? []);

  // vendor_users only carries ids; the names come from public.users, which
  // admin RLS allows us to read.
  const staffIds = (staff ?? []).map((s) => s.user_id);
  const { data: staffUsers, error: staffUsersError } = staffIds.length
    ? await supabase.from('users').select('id, full_name, phone').in('id', staffIds)
    : { data: [], error: null };
  const staffRows =
    staff === null || staffUsersError
      ? null
      : (staffUsers ?? []).map((u) => ({
          ...u,
          since: staff.find((s) => s.user_id === u.id)?.created_at,
        }));

  return (
    <>
      <p className="text-muted mb-2 text-sm">
        <Link href="/admin/vendors" className="underline underline-offset-4">
          Vendors
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{vendor.name}</h1>
      <p className="mb-6 flex items-center gap-2 text-sm">
        <Badge
          tone={vendor.status === 'ACTIVE' ? 'good' : vendor.status === 'DRAFT' ? 'warn' : 'bad'}
        >
          {vendor.status}
        </Badge>
        {vendor.is_accepting_orders ? <Badge tone="good">open</Badge> : <Badge>closed</Badge>}
        <span className="text-muted tabular-nums">{vendor.phone}</span>
      </p>

      <Panel title="Status" description="Only an ACTIVE vendor can be open for orders.">
        <VendorStatusForm vendor={vendor} />
      </Panel>

      <Panel title="Details">
        {locations === null ? (
          <Unavailable>
            The location list could not be loaded, so this vendor&apos;s pickup point cannot be
            edited safely here.
          </Unavailable>
        ) : (
          <VendorSettingsForm vendor={vendor} locations={locations} />
        )}
      </Panel>

      <Panel
        title="Scan delivery"
        description="Whether a Partner may bring a customer's prepaid campus meal scan here to redeem. Campus Dash pays this restaurant nothing for a scan order — the meal is settled by the university."
      >
        <VendorScansForm vendor={vendor} />
      </Panel>

      <Panel
        title="Staff"
        description="They must have signed in once — we never create an account on someone's behalf."
      >
        {staffRows === null ? (
          <Unavailable>The staff list could not be loaded.</Unavailable>
        ) : (
          <VendorStaffForms vendorId={vendor.id} staff={staffRows} />
        )}
      </Panel>

      <Panel title="Menu" description="Changing a price never alters an order already placed.">
        {menu === null ? (
          <Unavailable>
            The menu could not be loaded. This vendor may well have one — do not re-enter it.
          </Unavailable>
        ) : menu.length ? (
          <ul className="mb-6 divide-y divide-black/5 text-sm">
            {menu.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className="font-medium">{item.name}</span>
                <span className="tabular-nums">{formatPesewas(item.price_pesewas)}</span>
                {item.is_available ? <Badge tone="good">available</Badge> : <Badge>disabled</Badge>}
                {item.description ? (
                  <span className="text-muted w-full text-xs">{item.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No menu items yet.</Empty>
        )}

        {menu === null ? null : (
          <MenuForms
            vendorId={vendor.id}
            items={menu.map((i) => ({
              ...i,
              price_cedis: cedisInputFromPesewas(i.price_pesewas),
            }))}
          />
        )}
      </Panel>
    </>
  );
}
