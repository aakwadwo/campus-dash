'use client';

import { useActionState } from 'react';
import { saveMyName } from './actions';

/**
 * First name and last name, as two fields.
 *
 * TWO FIELDS BECAUSE THE PRODUCT NEEDS THE FIRST ONE ON ITS OWN. "Kwame has
 * accepted your order" is what a customer should read, and no amount of
 * splitting a single "full name" string afterwards gets that right for
 * everybody. Asking is cheaper and correct.
 */
export default function NameForm({ firstName, lastName }) {
  const [state, save, saving] = useActionState(saveMyName, {});

  return (
    <form action={save} className="mt-3 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="text-muted mb-1 block text-xs font-medium">First name</span>
          <input
            name="first_name"
            autoComplete="given-name"
            required
            defaultValue={firstName ?? ''}
            className="rounded-input border-line-strong bg-surface h-11 w-full border px-3 text-base"
          />
        </label>
        <label className="block">
          <span className="text-muted mb-1 block text-xs font-medium">Last name</span>
          <input
            name="last_name"
            autoComplete="family-name"
            defaultValue={lastName ?? ''}
            className="rounded-input border-line-strong bg-surface h-11 w-full border px-3 text-base"
          />
        </label>
      </div>
      <button
        type="submit"
        disabled={saving}
        className="press border-line-strong bg-surface rounded-full border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-55"
      >
        {saving ? 'Saving…' : 'Save name'}
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
