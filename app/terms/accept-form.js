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
        className="press bg-brand-500 text-ink w-full rounded-full py-3 text-sm font-semibold transition-colors disabled:opacity-55"
      >
        {state.ok ? 'Accepted' : accepting ? 'Recording…' : 'I accept these terms'}
      </button>
      {state.message && !state.ok ? (
        <p role="alert" className="text-bad mt-2 text-sm">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
