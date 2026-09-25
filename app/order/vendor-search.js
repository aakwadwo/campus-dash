'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { matchesQuery } from '@/lib/util/catalogue';
import { vendorLocationLine } from '@/lib/util/vendor-location';
import { isVariablePrice, priceSummary } from '@/lib/util/item-price';
import { SearchIcon, VendorCard, Money, ChevronRightIcon, ImagePlaceholder } from '../ui';

/**
 * The marketplace, with ONE search box over all of it.
 *
 * It finds stores by name, description or category, and it finds the things
 * they sell (food, drinks, chargers, printing) by name or description, so
 * somebody who knows what they want but not who sells it can type "waakye" and
 * be taken to it. Results are grouped: stores first, then items, each item
 * showing which store has it and what it costs. An item opens its store with
 * that item in view.
 *
 * CLIENT-SIDE ON PURPOSE. A campus has tens of stores, not thousands; filtering
 * what is already in the page is instant and works on a bad connection. The
 * server renders the full list first, so nothing depends on this script.
 *
 * A closed store stays in the results, looking like itself, with a "Closed"
 * chip, and is not a link. Its items are left out of the item results, because
 * a result that cannot be ordered is a dead end.
 */
export default function VendorSearch({ vendors, categories, items = [] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');

  const term = query.trim();
  const byId = useMemo(() => new Map(vendors.map((v) => [v.vendor_id, v])), [vendors]);

  const inCategory = (v) => !category || v.category_id === category;

  const stores = useMemo(
    () =>
      vendors.filter(
        (v) =>
          inCategory(v) &&
          matchesQuery(`${v.name} ${v.description ?? ''} ${v.category_name ?? ''}`, term)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vendors, term, category]
  );

  const foundItems = useMemo(() => {
    if (!term) return [];
    return items
      .filter((item) => {
        const vendor = byId.get(item.vendor_id);
        return (
          vendor?.is_accepting_orders &&
          inCategory(vendor) &&
          matchesQuery(`${item.name} ${item.description ?? ''}`, term)
        );
      })
      .slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, term, category, byId]);

  const open = stores.filter((v) => v.is_accepting_orders);
  const closed = stores.filter((v) => !v.is_accepting_orders);
  const nothing = vendors.length > 0 && stores.length === 0 && foundItems.length === 0;

  // Only categories that actually contain a store. An empty chip is a promise
  // the catalogue cannot keep.
  const present = useMemo(() => {
    const ids = new Set(vendors.map((v) => v.category_id));
    return categories.filter((c) => ids.has(c.id));
  }, [vendors, categories]);

  return (
    <div>
      {vendors.length ? (
        <div className="relative">
          <SearchIcon className="text-muted pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search stores, food and more"
            aria-label="Search stores and what they sell"
            enterKeyHint="search"
            className="bg-surface-2 rounded-input text-ink placeholder:text-faint focus:bg-surface focus:border-brand-600 h-12 w-full border border-transparent pr-4 pl-12 text-base transition-colors outline-none"
          />
        </div>
      ) : null}

      {present.length > 1 ? (
        <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
          <Chip active={category === ''} onClick={() => setCategory('')}>
            All
          </Chip>
          {present.map((c) => (
            <Chip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)}>
              {c.name}
            </Chip>
          ))}
        </div>
      ) : null}

      {nothing ? (
        <p className="text-muted py-16 text-center" role="status">
          {term ? `Nothing matches “${term}”.` : 'Nothing here yet.'}
        </p>
      ) : null}

      {open.length ? (
        <section className="mt-7">
          {term ? <GroupTitle>Stores</GroupTitle> : null}
          <StoreGrid vendors={open} />
        </section>
      ) : null}

      {foundItems.length ? (
        <section className="mt-9">
          <GroupTitle>Items</GroupTitle>
          <ul className="divide-line border-line divide-y border-y">
            {foundItems.map((item) => (
              <li key={item.id}>
                <ItemResult item={item} vendor={byId.get(item.vendor_id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closed.length ? (
        <section className="mt-10">
          <GroupTitle>Closed now</GroupTitle>
          <StoreGrid vendors={closed} />
        </section>
      ) : null}
    </div>
  );
}

function StoreGrid({ vendors }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-7 lg:grid-cols-4">
      {vendors.map((vendor) => (
        <li key={vendor.vendor_id}>
          <VendorCard
            vendor={vendor}
            href={`/order/${vendor.vendor_id}`}
            imageUrl={vendor.image_url}
            meta={vendor.category_name}
            location={vendorLocationLine(vendor)}
          />
        </li>
      ))}
    </ul>
  );
}

/** One thing a store sells, and which store. Opens the store at that item. */
function ItemResult({ item, vendor }) {
  return (
    <Link
      href={`/order/${item.vendor_id}#item-${item.id}`}
      className="press-sm hover:bg-surface-2 -mx-2 flex min-h-16 items-center gap-3 rounded-lg px-2 py-2.5 transition-colors"
    >
      {vendor?.image_url ? (
        <Image
          src={vendor.image_url}
          alt=""
          width={44}
          height={44}
          className="rounded-input size-11 shrink-0 object-cover"
        />
      ) : (
        <ImagePlaceholder
          name={vendor?.name ?? ''}
          ratio="aspect-square"
          className="w-11 shrink-0"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{item.name}</span>
        <span className="text-muted block truncate text-sm">{vendor?.name}</span>
      </span>
      {isVariablePrice(item) ? (
        <span className="shrink-0 text-sm font-semibold tabular-nums">{priceSummary(item)}</span>
      ) : (
        <Money pesewas={item.price_pesewas} className="shrink-0 text-sm font-semibold" />
      )}
      <ChevronRightIcon className="text-faint size-4 shrink-0" />
    </Link>
  );
}

function GroupTitle({ children }) {
  return <h2 className="text-muted mb-3 text-sm font-semibold">{children}</h2>;
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`press-sm shrink-0 rounded-full border px-3.5 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? 'bg-brand-700 border-brand-700 text-white'
          : 'bg-surface border-line text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}
