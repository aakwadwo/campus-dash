/**
 * Shown while an admin page's server render is in flight.
 *
 * Every screen in this console is `force-dynamic` and most of them make several
 * round trips to the database before they can render a single row, so a slow
 * query means a navigation that appears to do nothing at all. An operator who
 * cannot tell "loading" from "the link is broken" clicks again, and on a page
 * that runs a settlement that is not a harmless habit to teach.
 *
 * DELIBERATELY NOT A SPINNER. The shape below is the shape of an admin page —
 * heading, stat row, panel — so the layout does not jump when the real content
 * arrives, and it is unmistakably a placeholder rather than an empty result.
 * `aria-busy` and the live region say the same thing to a screen reader.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <p className="text-muted mb-6 text-sm">Loading…</p>

      <div className="bg-surface-2 mb-6 h-8 w-56 animate-pulse rounded" />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-card bg-surface ring-line p-4 ring-1">
            <div className="bg-surface-2 h-3 w-20 animate-pulse rounded" />
            <div className="mt-3 h-6 w-16 animate-pulse rounded bg-black/10" />
          </div>
        ))}
      </div>

      <section className="rounded-card bg-surface ring-line ring-1">
        <header className="border-line border-b px-5 py-3">
          <div className="h-4 w-32 animate-pulse rounded bg-black/10" />
        </header>
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-surface-2 h-4 animate-pulse rounded" />
          ))}
        </div>
      </section>
    </div>
  );
}
