'use client';

import { useMemo, useState } from 'react';
import { SearchIcon, VendorCard, EmptyState } from '../ui';

/**
 * The vendor grid, with a category filter and a name filter over it.
 *
 * BOTH ARE CLIENT-SIDE ON PURPOSE. With a campus-sized catalogue — tens of
 * stores, not thousands — filtering the list already in the page is the right
 * tool: it is instant, it works once loaded, and it ships no query. The
 * storefront RPC accepts the same filters for a caller that wants them; this
 * screen simply does not need to make the round trip.
 *
 * The whole list is rendered by the server first, so someone with JavaScript
 * disabled still sees every vendor; the controls only narrow what is there.
 *
 * Open stores come first and closed ones are kept, dimmed, in their own group.
 * Knowing a place exists but is shut right now is useful — hiding it just makes
 * people wonder where it went.
 */
export default function VendorSearch({ vendors, categories }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');

  const term = query.trim().toLowerCase();

  const matching = useMemo(
    () =>
      vendors.filter(
        (v) =>
          (!category || v.category_id === category) &&
          (!term ||
            v.name.toLowerCase().includes(term) ||
            (v.description ?? '').toLowerCase().includes(term))
      ),
    [vendors, term, category]
  );

  const shownOpen = matching.filter((v) => v.is_accepting_orders);
  const shownClosed = matching.filter((v) => !v.is_accepting_orders);
  const nothing = matching.length === 0 && vendors.length > 0;

  // Only categories that actually contain a store. An empty filter chip is a
  // promise the catalogue cannot keep.
  const present = useMemo(() => {
    const ids = new Set(vendors.map((v) => v.category_id));
    return categories.filter((c) => ids.has(c.id));
  }, [vendors, categories]);

  return (
    <div className="mt-8">
      {vendors.length > 4 ? (
        <div className="relative mb-5">
          <SearchIcon className="text-muted pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search vendors"
            aria-label="Search vendors by name"
            className="bg-surface-2 rounded-input text-ink placeholder:text-faint focus:bg-surface focus:border-brand-600 h-12 w-full border border-transparent pr-4 pl-12 text-[15px] transition-colors outline-none"
          />
        </div>
      ) : null}

      {present.length > 1 ? (
        <div className="-mx-4 mb-7 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
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
        <EmptyState
          icon={<SearchIcon className="size-6" />}
          title={term ? `No vendor matches “${query.trim()}”` : 'Nothing in this category yet'}
          description="Try a shorter search, or clear the filters to see everything that is open."
        />
      ) : null}

      {shownOpen.length ? (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-7 lg:grid-cols-4">
          {shownOpen.map((vendor) => (
            <li key={vendor.vendor_id}>
              <VendorCard
                vendor={vendor}
                href={`/order/${vendor.vendor_id}`}
                imageUrl={vendor.image_url}
                meta={vendor.category_name}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {shownClosed.length ? (
        <section className="mt-12">
          <h2 className="text-muted mb-4 text-xs font-semibold tracking-[0.14em] uppercase">
            Closed right now
          </h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-7 lg:grid-cols-4">
            {shownClosed.map((vendor) => (
              <li key={vendor.vendor_id}>
                <VendorCard
                  vendor={vendor}
                  href={`/order/${vendor.vendor_id}`}
                  imageUrl={vendor.image_url}
                  meta={vendor.category_name}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
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
