'use client';

import { useActionState } from 'react';
import { saveMyEmail } from './actions';

/**
 * The account's email address.
 *
 * Kept deliberately quiet: it is one field on a screen that already exists, not
 * a verification step. The address is used to open the payment provider's
 * checkout and to send the receipt, and it is never generated for anyone who
 * has not typed one.
 */
export default function EmailForm({ email }) {
  const [state, save, saving] = useActionState(saveMyEmail, {});

  return (
    <form action={save} className="mt-3 space-y-2">
      <label className="block">
        <span className="sr-only">Email address</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={email ?? ''}
          placeholder="you@example.com"
          className="focus:border-brand-600 focus:ring-brand-600/50 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base outline-none focus:ring-2"
        />
      </label>
      <button
        type="submit"
        disabled={saving}
        className="rounded-lg border border-black/15 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-60"
      >
        {saving ? 'Saving…' : email ? 'Update email' : 'Add email'}
      </button>
      {state.message ? (
        <p
          role={state.ok ? undefined : 'alert'}
          className={state.ok ? 'text-muted text-sm' : 'text-sm text-red-700'}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
