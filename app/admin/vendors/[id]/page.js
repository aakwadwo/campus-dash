import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { formatPesewas, cedisInputFromPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty } from '../../ui';
import VendorSettingsForm from './vendor-settings-form';
import VendorStatusForm from './vendor-status-form';
import VendorStaffForms from './vendor-staff-forms';
import MenuForms from './menu-forms';

export const dynamic = 'force-dynamic';

export default async function VendorDetailPage({ params }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: vendor } = await supabase.from('vendors').select('*').eq('id', id).single();
  if (!vendor) notFound();

  const [{ data: staff }, { data: menu }, { data: locations }] = await Promise.all([
    supabase.from('vendor_users').select('user_id, created_at').eq('vendor_id', id),
    supabase.from('menu_items').select('*').eq('vendor_id', id).order('sort_order'),
    supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
  ]);

  // vendor_users only carries ids; the names come from public.users, which
  // admin RLS allows us to read.
  const staffIds = (staff ?? []).map((s) => s.user_id);
  const { data: staffUsers } = staffIds.length
    ? await supabase.from('users').select('id, full_name, phone').in('id', staffIds)
    : { data: [] };

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
        <VendorSettingsForm vendor={vendor} locations={locations ?? []} />
      </Panel>

      <Panel
        title="Staff"
        description="They must have signed in once — we never create an account on someone's behalf."
      >
        <VendorStaffForms
          vendorId={vendor.id}
          staff={(staffUsers ?? []).map((u) => ({
            ...u,
            since: staff.find((s) => s.user_id === u.id)?.created_at,
          }))}
        />
      </Panel>

      <Panel title="Menu" description="Changing a price never alters an order already placed.">
        {menu?.length ? (
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

        <MenuForms
          vendorId={vendor.id}
          items={(menu ?? []).map((i) => ({
            ...i,
            price_cedis: cedisInputFromPesewas(i.price_pesewas),
          }))}
        />
      </Panel>
    </>
  );
}
