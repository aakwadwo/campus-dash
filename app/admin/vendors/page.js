import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listVendors, listVendorCategories } from '@/lib/admin';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Cedis,
  FilterBar,
  FilterChip,
} from '../ui';
import CreateVendorForm from './create-vendor-form';
import CategoryForms from './category-forms';

export const dynamic = 'force-dynamic';

const STATUS_TONE = {
  ACTIVE: 'good',
  PENDING_APPROVAL: 'warn',
  DRAFT: 'warn',
  SUSPENDED: 'bad',
  REJECTED: 'bad',
};

const STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DRAFT'];

/**
 * The vendor queue and the vendor list, in one screen.
 *
 * Applications awaiting review sort to the top, because that is the only thing
 * here with somebody waiting on the other end of it. Filtering is applied in
 * the DATABASE — narrowing a list is not a security boundary (is_admin() inside
 * admin_vendors() is), but a pilot with sixty stores should not ship all sixty
 * to a phone so the browser can hide most of them.
 */
export default async function VendorsPage({ searchParams }) {
  const params = await searchParams;
  const status = typeof params?.status === 'string' ? params.status : null;
  const search = typeof params?.q === 'string' ? params.q : null;
  const categoryId = typeof params?.category === 'string' ? params.category : null;

  const supabase = await createClient();

  const [vendors, categories, { data: locations }] = await Promise.all([
    listVendors({ status, search, categoryId }).catch(() => null),
    listVendorCategories().catch(() => []),
    supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
  ]);

  const pending = (vendors ?? []).filter((v) => v.status === 'PENDING_APPROVAL').length;

  const chip = (label, value) => {
    const query = new URLSearchParams();
    if (value) query.set('status', value);
    if (search) query.set('q', search);
    if (categoryId) query.set('category', categoryId);
    const qs = query.toString();
    return (
      <FilterChip
        key={label}
        active={status === value || (!status && !value)}
        href={`/admin/vendors${qs ? `?${qs}` : ''}`}
        label={label}
      />
    );
  };

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Vendors</h1>
      <p className="text-muted mb-6 text-sm">
        {pending > 0
          ? `${pending} application${pending === 1 ? '' : 's'} awaiting review.`
          : 'No applications awaiting review.'}
      </p>

      <FilterBar>
        {chip('All', null)}
        {STATUSES.map((value) => chip(value.replace('_', ' ').toLowerCase(), value))}
      </FilterBar>

      <form method="get" className="mb-6 flex gap-2">
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <input
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search by store, owner or phone"
          className="border-line-strong bg-surface h-10 flex-1 rounded border px-3 text-sm"
        />
        <select
          name="category"
          defaultValue={categoryId ?? ''}
          className="border-line-strong bg-surface h-10 rounded border px-3 text-sm"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button type="submit" className="bg-surface-2 h-10 rounded px-4 text-sm font-medium">
          Filter
        </button>
      </form>

      <Panel
        title="All vendors"
        description="Stores register themselves at /vendor/signup. Approval, suspension and catalogue entries are decided here."
      >
        {vendors === null ? (
          <Unavailable>The vendor list could not be loaded.</Unavailable>
        ) : vendors.length === 0 ? (
          <Empty>Nothing matches those filters.</Empty>
        ) : (
          <Table
            head={[
              'Store',
              'Owner',
              'Category',
              'Status',
              'Scans',
              'Photos',
              'Menu',
              'Orders',
              'Owed',
            ]}
            minWidth="62rem"
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
                <Cell>
                  {vendor.owner_user_id ? (
                    <>
                      {vendor.owner_name ?? '-'}
                      <span className="text-muted block text-xs tabular-nums">
                        {vendor.owner_phone ?? vendor.phone}
                      </span>
                    </>
                  ) : (
                    // A NULL owner is not a missing value. It is a catalogue
                    // entry: listed so a scan can be fetched from it, operating
                    // no dashboard, with nobody able to sign in as it.
                    <span className="text-muted text-xs">catalogue only</span>
                  )}
                </Cell>
                <Cell>{vendor.category_name ?? '-'}</Cell>
                <Cell>
                  <Badge tone={STATUS_TONE[vendor.status]}>{vendor.status}</Badge>
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
                <Cell numeric>{vendor.image_count}</Cell>
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
        title="Categories"
        description="Disabling a category hides it from the sign-up form and the customer filter. It never detaches the stores already in it, and never touches a historical order."
      >
        <CategoryForms categories={categories} />
      </Panel>

      <Panel
        title="Add a catalogue entry"
        description="For a business that has not signed up and will not: a restaurant a scan is fetched from. It gets no account and no dashboard."
      >
        <CreateVendorForm locations={locations ?? []} categories={categories} />
      </Panel>
    </>
  );
}
