'use client';

import { useEffect } from 'react';
import Link from 'next/link';

/**
 * The application-wide error boundary.
 *
 * NOTHING FROM THE ERROR REACHES THE SCREEN except `error.digest` — the opaque
 * id Next.js also writes to the server log. Message and stack stay server-side,
 * which is the same rule lib/errors.js applies to every server action: the
 * detail goes to the log, a sentence goes to the person. It matters here
 * because the errors these pages throw are database errors, and those quote
 * table and column names.
 */
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error('[campus-dash] route error', error?.digest ?? '(no digest)');
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">Something went wrong</h1>
      <p className="text-muted mt-3 leading-relaxed">
        This screen did not load. Nothing you were doing was changed by the attempt, so you can try
        again safely.
      </p>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="press bg-brand-500 text-ink hover:bg-brand-600 rounded-full px-6 py-3 text-sm font-semibold transition-colors"
        >
          Try again
        </button>
        <Link
          href="/order"
          className="press border-line-strong hover:bg-surface-2 rounded-full border px-6 py-3 text-sm font-semibold transition-colors"
        >
          Back to browsing
        </Link>
      </div>

      {error?.digest ? (
        <p className="text-faint mt-8 text-xs">
          Reference <span className="font-mono">{error.digest}</span>. Quote this if you report it.
        </p>
      ) : null}
    </main>
  );
}
