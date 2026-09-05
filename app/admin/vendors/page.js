import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { vendors as listVendors } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis } from '../ui';
import CreateVendorForm from './create-vendor-form';

export const dynamic = 'force-dynamic';

const STATUS_TONE = { ACTIVE: 'good', DRAFT: 'warn', SUSPENDED: 'bad' };

export default async function VendorsPage() {
  const supabase = await createClient();

  // admin_vendors() carries the operational facts a list has to show — staff,
  // menu size, order count, money owed and whether the stall takes scans —
  // which a plain select on `vendors` cannot without four more round trips.
  const [vendors, { data: locations }] = await Promise.all([
    listVendors().catch(() => null),
    supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
  ]);

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Vendors</h1>

      <Panel title="All vendors" description="Registration is closed. Vendors are created here.">
        {vendors === null ? (
          <Unavailable>The vendor list could not be loaded.</Unavailable>
        ) : vendors.length === 0 ? (
          <Empty>No vendors yet. Create one below.</Empty>
        ) : (
          <Table
            head={['Name', 'Phone', 'Status', 'Orders', 'Scans', 'Staff', 'Menu', 'Placed', 'Owed']}
            minWidth="52rem"
          >
            {vendors.map((vendor) => (
              <Row key={vendor.vendor_id}>
                <Cell>
                  <Link
                    href={`/admin/vendors/${vendor.vendor_id}`}
                    className="text-brand-700 underline underline-offset-4"
                  >
                    {vendor.name}
                  </Link>
                  <span className="text-muted block text-xs">{vendor.location_path ?? '-'}</span>
                </Cell>
                <Cell mono>{vendor.phone}</Cell>
                <Cell>
                  <Badge tone={STATUS_TONE[vendor.status]}>{vendor.status}</Badge>
                </Cell>
                <Cell>
                  {vendor.is_accepting_orders ? (
                    <Badge tone="good">open</Badge>
                  ) : (
                    <Badge>closed</Badge>
                  )}
                </Cell>
                <Cell>
                  {/* Off unless somebody deliberately turned it on: a scan errand
                      sends a Partner to a counter expecting to be served free. */}
                  {vendor.can_accept_scans ? (
                    <Badge tone="warn">accepts scans</Badge>
                  ) : (
                    <span className="text-muted text-xs">no</span>
                  )}
                </Cell>
                <Cell numeric>{vendor.staff_count}</Cell>
                <Cell numeric>{vendor.menu_count}</Cell>
                <Cell numeric>{vendor.order_count}</Cell>
                <Cell numeric>
                  <Cedis pesewas={vendor.owed_pesewas} />
                </Cell>
              </Row>
            ))}
          </Table>
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
