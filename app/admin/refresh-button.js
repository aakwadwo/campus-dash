'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-renders the current page on the server, which re-reads whatever that page
 * reads — for a settlement panel, Paystack itself. It writes nothing and moves
 * nothing, and its label says exactly that.
 */
export default function RefreshButton({ children = 'Refresh' }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="text-brand-700 press-sm text-xs font-semibold underline underline-offset-4 disabled:opacity-55"
    >
      {pending ? 'Reading…' : children}
    </button>
  );
}
