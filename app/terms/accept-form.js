'use client';

import { useActionState } from 'react';
import { acceptTermsAction } from './actions';

export default function AcceptForm({ termsId }) {
  const [state, accept, accepting] = useActionState(acceptTermsAction, {});

  return (
    <form action={accept} className="mt-3">
      <input type="hidden" name="terms_id" value={termsId} />
      <button
        type="submit"
        disabled={accepting || state.ok}
        className="bg-brand-500 text-ink w-full rounded-lg py-3 text-sm font-semibold disabled:opacity-60"
      >
        {state.ok ? 'Accepted' : accepting ? 'Recording…' : 'I accept these terms'}
      </button>
      {state.message && !state.ok ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
