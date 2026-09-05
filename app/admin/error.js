'use client';

import { useEffect } from 'react';

/**
 * The admin console's route-level error boundary.
 *
 * WHAT IT SHOWS AND WHAT IT DOES NOT. Nothing from the error object reaches the
 * screen except `error.digest` — the opaque id Next.js writes into the server
 * log next to the real stack. Message, stack, SQL text and constraint names all
 * stay server-side, which is the same rule `lib/errors.js` applies to every
 * server action: the detail goes to the log, a sentence goes to the person.
 * That matters more here than anywhere else in the app, because the errors an
 * admin page throws are database errors and they quote table and column names.
 *
 * WHAT IT DOES NOT REPLACE. Every page still handles its own failed fetch and
 * renders <Unavailable>, which is the better outcome: one dead panel on an
 * otherwise working screen. This catches what that cannot — a render-time
 * throw, a bad parameter, a boundary case nobody predicted — so the admin gets
 * a usable page instead of the framework's default error screen.
 *
 * THE SESSION IS NOT THE PROBLEM. Sign-out and the nav live in the layout,
 * which is above this boundary and still rendered, so an operator is never
 * stranded on a page with no way out.
 */
export default function AdminError({ error, reset }) {
  useEffect(() => {
    // Server-side errors are already logged with their digest; this covers the
    // ones that happen in the browser.
    console.error('[admin] route error', error?.digest ?? '(no digest)');
  }, [error]);

  return (
    <div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">This screen did not load</h1>
      <p className="text-muted mb-6 text-sm">
        Something failed while building this page. Nothing was changed by the attempt.
      </p>

      <div className="rounded-card bg-warn-bg text-warn ring-warn/30 px-5 py-4 text-sm ring-1">
        <p className="font-medium">Do not read this as an empty result.</p>
        <p className="mt-1">
          The console could not ask the database, which is not the same as the answer being zero. Do
          not act on this screen as though there were no orders, no money owed and nothing waiting
          on you.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="bg-brand-500 text-ink rounded px-4 py-2 text-sm font-semibold"
        >
          Try again
        </button>
        <a
          href="/admin"
          className="bg-surface ring-line-strong rounded px-4 py-2 text-sm font-semibold ring-1"
        >
          Back to the dashboard
        </a>
      </div>

      {/* The digest is the only detail shown, and it is not sensitive: it is an
          opaque hash Next.js also writes to the server log, so an operator can
          quote it and somebody can find the real error. */}
      {error?.digest ? (
        <p className="text-muted mt-6 text-xs">
          Reference <span className="font-mono">{error.digest}</span>. Quote this if you report it.
        </p>
      ) : null}
    </div>
  );
}
