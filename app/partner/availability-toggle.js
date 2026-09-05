'use client';

import { useTransition } from 'react';
import { setAvailabilityAction } from './actions';

/**
 * Going online is what makes a Partner visible to dispatch. The database
 * re-checks it on every offer and every acceptance, so this switch is a
 * convenience rather than the control.
 */
export default function AvailabilityToggle({ available, hasActive }) {
  const [pending, start] = useTransition();

  return (
    <form
      action={(formData) => start(() => setAvailabilityAction(formData))}
      className="rounded-card bg-surface ring-line mt-4 flex items-center gap-3 px-4 py-3 ring-1"
    >
      <input type="hidden" name="available" value={available ? 'false' : 'true'} />
      <span
        className={`size-2.5 rounded-full ${available ? 'bg-brand-700' : 'bg-black/20'}`}
        aria-hidden
      />
      <span className="text-sm font-medium">{available ? 'Online' : 'Offline'}</span>
      <button
        type="submit"
        disabled={pending || hasActive}
        className="ring-line-strong ml-auto rounded px-3 py-1.5 text-sm font-semibold ring-1 disabled:opacity-50"
      >
        {available ? 'Go offline' : 'Go online'}
      </button>
      {hasActive ? (
        <span className="text-muted w-full text-xs">Finish your current delivery first.</span>
      ) : null}
    </form>
  );
}
