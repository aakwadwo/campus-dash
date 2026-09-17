import Link from 'next/link';
import { BackLink } from '@/app/ui';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { formatPesewas, cedisInputFromPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable } from '../../ui';
import VendorSettingsForm from './vendor-settings-form';
import VendorStatusForm from './vendor-status-form';
import VendorScansForm from './vendor-scans-form';
import VendorReviewForm from './vendor-review-form';
import VendorImageForms from './vendor-image-forms';
import MenuForms from './menu-forms';
import DeleteVendorForm from './delete-vendor-form';
import { vendorImageUrl } from '@/lib/verification/documents';

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
        <BackLink href="/admin/vendors" className="mb-2">
          Vendors
        </BackLink>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Vendor</h1>
        <Unavailable>
          This vendor could not be loaded. That is not the same as it not existing, so do not create
          a replacement from this screen.
        </Unavailable>
      </>
    );
  }
  if (!vendor) notFound();

  const [menuResult, locationsResult, imagesResult, categoriesResult, orderCountResult] =
    await Promise.all([
      supabase.from('menu_items').select('*').eq('vendor_id', id).order('sort_order'),
      supabase.from('locations').select('id, name, kind, is_active').order('sort_order'),
      supabase
        .from('vendor_images')
        .select('id, storage_path, caption, sort_order')
        .eq('vendor_id', id)
        .order('sort_order'),
      supabase.from('vendor_categories').select('id, name, is_active').order('sort_order'),
      // Only the COUNT: whether this store has ever traded is the one thing the
      // delete panel needs, and admin_delete_vendor() checks it again anyway.
      supabase.from('orders').select('id', { count: 'exact', head: true }).eq('vendor_id', id),
    ]);

  const menu = menuResult.error ? null : (menuResult.data ?? []);
  const locations = locationsResult.error ? null : (locationsResult.data ?? []);
  const categories = categoriesResult.error ? [] : (categoriesResult.data ?? []);
  const orderCount = orderCountResult.error ? 0 : (orderCountResult.count ?? 0);
  const images = imagesResult.error
    ? null
    : (imagesResult.data ?? []).map((image) => ({
        ...image,
        url: vendorImageUrl(image.storage_path),
      }));

  // The OWNER, and the fact that there may not be one. A NULL owner is a
  // catalogue entry: listed so a scan can be fetched from it, operating no
  // dashboard, with nobody able to sign in as it.
  const { data: owner } = vendor.owner_user_id
    ? await supabase
        .from('users')
        .select('id, full_name, phone, is_suspended')
        .eq('id', vendor.owner_user_id)
        .maybeSingle()
    : { data: null };

  return (
    <>
      <BackLink href="/admin/vendors" className="mb-2">
        Vendors
      </BackLink>
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

      {vendor.status === 'PENDING_APPROVAL' || vendor.status === 'REJECTED' ? (
        <Panel
          title="Application"
          description="Approving grants the vendor capability. It does not open the store; that is the owner's own decision."
        >
          <dl className="mb-5 space-y-1.5 text-sm">
            <FactRow label="Applicant" value={vendor.applicant_name ?? '-'} />
            <FactRow
              label="Student"
              value={
                vendor.owner_is_student === null ? '-' : vendor.owner_is_student ? 'Yes' : 'No'
              }
            />
            <FactRow label="Phone" value={owner?.phone ?? vendor.phone} />
            <FactRow label="Describes itself as" value={vendor.description ?? '-'} />
            {vendor.rejection_reason ? (
              <FactRow label="Previously rejected because" value={vendor.rejection_reason} />
            ) : null}
          </dl>
          <VendorReviewForm vendor={vendor} />
        </Panel>
      ) : null}

      <Panel
        title="Owner"
        description="The identity that operates this store. There is no staff list: one account, one store."
      >
        {owner ? (
          <dl className="space-y-1.5 text-sm">
            <FactRow label="Name" value={owner.full_name ?? '-'} />
            <FactRow label="Phone (sign-in)" value={owner.phone ?? '-'} />
            <FactRow label="Account" value={owner.is_suspended ? 'Suspended' : 'Active'} />
          </dl>
        ) : (
          <Empty>
            Catalogue entry: no owner, no dashboard, nobody can sign in as this vendor. It exists so
            a Partner can be sent here to redeem a prepaid meal scan.
          </Empty>
        )}
      </Panel>

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
          <VendorSettingsForm vendor={vendor} locations={locations} categories={categories} />
        )}
      </Panel>

      <Panel
        title="Photos"
        description="Shown on the storefront to anyone browsing. The vendor can manage these too."
      >
        {images === null ? (
          <Unavailable>The photo list could not be loaded.</Unavailable>
        ) : (
          <VendorImageForms vendorId={vendor.id} images={images} />
        )}
      </Panel>

      <Panel
        title="Scan delivery"
        description="Whether a Partner may bring a customer's prepaid campus meal scan here to redeem. Campus Dash pays this restaurant nothing for a scan order, because the meal is settled by the university."
      >
        <VendorScansForm vendor={vendor} />
      </Panel>

      <Panel title="Menu" description="Changing a price never alters an order already placed.">
        {menu === null ? (
          <Unavailable>
            The menu could not be loaded. This vendor may well have one, so do not re-enter it.
          </Unavailable>
        ) : menu.length ? (
          <ul className="divide-line mb-6 divide-y text-sm">
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

      {/* LAST ON THE PAGE, and not next to the status control. Suspension and
          deletion look similar in a list of buttons and are nothing alike. */}
      <Panel
        title="Delete this store"
        description="For a store that never traded. One that has orders against it is suspended, never deleted — the payment and settlement records behind those orders are what reconcile the money."
      >
        <DeleteVendorForm
          vendor={vendor}
          hasOwner={Boolean(vendor.owner_user_id)}
          orderCount={orderCount}
        />
      </Panel>
    </>
  );
}

function FactRow({ label, value }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
