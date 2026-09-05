'use client';

import { useMemo, useState } from 'react';
import { SearchIcon, VendorCard, EmptyState } from '../ui';

/**
 * The vendor grid, with a filter over it.
 *
 * THE FILTER IS CLIENT-SIDE ON PURPOSE. There is no vendor search RPC, and
 * adding one to make this screen feel richer would be building backend for a
 * screenshot. With a campus-sized catalogue — tens of stalls, not thousands —
 * filtering the list already in the page is also simply the right tool: it is
 * instant, it works offline once loaded, and it ships no query.
 *
 * The whole list is rendered by the server first, so someone with JavaScript
 * disabled still sees every vendor; the input only narrows what is already
 * there.
 *
 * Open stalls come first and closed ones are kept, dimmed, in their own group.
 * Knowing a place exists but is shut right now is useful — hiding it just makes
 * people wonder where it went.
 */
export default function VendorSearch({ open, closed }) {
  const [query, setQuery] = useState('');

  const term = query.trim().toLowerCase();

  // The predicate is built inside each memo rather than in the component body,
  // so the dependency list is the whole truth: a new `term` is the only thing
  // that can change the result.
  const shownOpen = useMemo(
    () => open.filter((v) => !term || v.name.toLowerCase().includes(term)),
    [open, term]
  );
  const shownClosed = useMemo(
    () => closed.filter((v) => !term || v.name.toLowerCase().includes(term)),
    [closed, term]
  );
  const nothing = term && shownOpen.length === 0 && shownClosed.length === 0;

  const total = open.length + closed.length;

  return (
    <div className="mt-8">
      {total > 4 ? (
        <div className="relative mb-7">
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

      {nothing ? (
        <EmptyState
          icon={<SearchIcon className="size-6" />}
          title={`No vendor matches “${query.trim()}”`}
          description="Try a shorter search, or clear it to see everything that is open."
        />
      ) : null}

      {shownOpen.length ? (
        <ul className="stagger grid grid-cols-2 gap-x-4 gap-y-7 lg:grid-cols-4">
          {shownOpen.map((vendor) => (
            <li key={vendor.id}>
              <VendorCard vendor={vendor} href={`/order/${vendor.id}`} />
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
              <li key={vendor.id}>
                <VendorCard vendor={vendor} href={`/order/${vendor.id}`} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
