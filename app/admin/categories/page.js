import Link from 'next/link';
import { listVendorCategories } from '@/lib/admin';
import { Panel, Empty, Unavailable, Stat, StatGrid } from '../ui';
import CategoryForms from './category-forms';

export const dynamic = 'force-dynamic';

/**
 * Categories, on their own screen.
 *
 * THEY WERE A PANEL AT THE BOTTOM OF /admin/vendors, below a table of every
 * store — which is where you put something nobody is expected to look at. They
 * are the vocabulary the whole marketplace is filed under: a customer filters
 * by them, a store picks one at sign-up, and getting one wrong is visible on
 * the front page.
 *
 * WHAT AN OPERATOR NEEDS TO KNOW BEFORE TOUCHING ONE is how many stores are in
 * it, so every row carries its count and a way to see them. A category with
 * stores in it cannot be deleted at all — see below — so the count is not a
 * warning, it is the answer.
 *
 * THERE IS NO DELETE, DELIBERATELY. Deleting a category would either orphan the
 * stores filed under it or rewrite what they chose, and neither is something an
 * operator should be able to do by accident. Disabling does what anybody
 * reaching for delete actually wants: it disappears from the sign-up form and
 * the customer filter, while every store already in it keeps trading and every
 * historical order keeps the category it was placed under.
 */
export default async function AdminCategoriesPage() {
  const categories = await listVendorCategories().catch(() => null);

  const active = (categories ?? []).filter((c) => c.is_active);
  const used = (categories ?? []).filter((c) => Number(c.vendor_count) > 0);
  const empty = active.filter((c) => Number(c.vendor_count) === 0);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Categories</h1>
      <p className="text-muted mb-6 text-sm">
        How the marketplace is filed. A store picks one when it registers and customers filter by
        them, so a category nobody is in is a filter that always comes back empty.
      </p>

      {categories ? (
        <StatGrid>
          <Stat label="Active" value={active.length} hint={`${categories.length} in total`} />
          <Stat label="With stores in them" value={used.length} />
          <Stat
            label="Active but empty"
            value={empty.length}
            hint={empty.length ? 'Shown to customers with nothing behind them' : undefined}
            tone={empty.length ? 'warn' : 'neutral'}
          />
        </StatGrid>
      ) : null}

      <Panel
        title="Every category"
        description="Disabling hides one from sign-up and from the customer filter. Stores already in it keep trading."
      >
        {categories === null ? (
          <Unavailable>The categories could not be loaded.</Unavailable>
        ) : categories.length === 0 ? (
          <Empty>No categories yet.</Empty>
        ) : (
          <CategoryForms categories={categories} />
        )}
      </Panel>

      <p className="text-muted mt-6 text-sm leading-relaxed">
        Looking for the stores themselves?{' '}
        <Link href="/admin/vendors" className="text-brand-700 underline underline-offset-4">
          Vendors
        </Link>
        .
      </p>
    </>
  );
}
