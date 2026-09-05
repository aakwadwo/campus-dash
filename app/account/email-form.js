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
          className="focus:border-brand-600 focus:ring-brand-600/50 rounded-input border-line-strong bg-surface w-full border px-3 py-2.5 text-base transition-colors outline-none focus:ring-2"
        />
      </label>
      <button
        type="submit"
        disabled={saving}
        className="press border-line-strong bg-surface rounded-full border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-55"
      >
        {saving ? 'Saving…' : email ? 'Update email' : 'Add email'}
      </button>
      {state.message ? (
        <p
          role={state.ok ? undefined : 'alert'}
          className={state.ok ? 'text-muted text-sm' : 'text-bad text-sm'}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
