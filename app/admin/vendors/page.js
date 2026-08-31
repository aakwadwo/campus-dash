import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { Panel, Badge, Empty } from '../ui';
import CreateVendorForm from './create-vendor-form';

export const dynamic = 'force-dynamic';

const STATUS_TONE = { ACTIVE: 'good', DRAFT: 'warn', SUSPENDED: 'bad' };

export default async function VendorsPage() {
  const supabase = await createClient();

  const [{ data: vendors }, { data: locations }] = await Promise.all([
    supabase
      .from('vendors')
      .select('id, name, phone, status, is_accepting_orders, location_id')
      .order('name'),
    supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
  ]);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Vendors</h1>

      <Panel title="All vendors" description="Registration is closed — vendors are created here.">
        {vendors?.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Phone</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Taking orders</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((vendor) => (
                <tr key={vendor.id} className="border-t border-black/5">
                  <td className="py-2">
                    <Link
                      href={`/admin/vendors/${vendor.id}`}
                      className="text-brand-700 underline underline-offset-4"
                    >
                      {vendor.name}
                    </Link>
                  </td>
                  <td className="py-2 tabular-nums">{vendor.phone}</td>
                  <td className="py-2">
                    <Badge tone={STATUS_TONE[vendor.status]}>{vendor.status}</Badge>
                  </td>
                  <td className="py-2">
                    {vendor.is_accepting_orders ? (
                      <Badge tone="good">open</Badge>
                    ) : (
                      <Badge>closed</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No vendors yet.</Empty>
        )}
      </Panel>

      <Panel
        title="Create a vendor"
        description="Created as DRAFT and closed; going live is a separate step."
      >
        <CreateVendorForm locations={locations ?? []} />
      </Panel>
    </>
  );
}
