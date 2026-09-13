'use client';

import { useActionState } from 'react';
import { setAvailabilityAction } from './actions';
import { Button, ErrorNote } from '@/app/ui';

/**
 * Going online is what makes a Partner visible to dispatch. The database
 * re-checks it on every offer and every acceptance, so this switch is a
 * convenience rather than the control.
 *
 * THE BUTTON'S WEIGHT FOLLOWS WHAT IS NEXT. Offline, going online is the only
 * thing on this screen worth doing, so it is the primary button. Online, going
 * offline is a quiet one: it is the button nobody should press by accident in
 * the middle of a shift.
 */
export default function AvailabilityToggle({ available, hasActive }) {
  const [state, submit, pending] = useActionState(
    async (_previous, formData) => (await setAvailabilityAction(formData)) ?? {},
    {}
  );

  return (
    <section
      className={`rounded-card mt-5 border px-4 py-4 sm:px-5 ${
        available ? 'border-good/30 bg-good-bg' : 'border-line bg-surface'
      }`}
    >
      <form action={submit} className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <input type="hidden" name="available" value={available ? 'false' : 'true'} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-semibold">
            <span
              className={`size-2.5 rounded-full ${available ? 'bg-good' : 'bg-line-strong'}`}
              aria-hidden
            />
            <span className={available ? 'text-good' : ''}>
              {available ? 'You are online' : 'You are offline'}
            </span>
          </p>
          <p className="text-muted mt-0.5 text-sm">
            {hasActive
              ? 'Finish what you are carrying before going offline.'
              : available
                ? 'New orders can be offered to you.'
                : 'Go online to see orders you can deliver.'}
          </p>
        </div>
        <Button
          type="submit"
          variant={available ? 'secondary' : 'primary'}
          size={available ? 'md' : 'lg'}
          pending={pending}
          disabled={hasActive}
          className={available ? '' : 'w-full sm:w-auto'}
        >
          {pending
            ? available
              ? 'Going offline…'
              : 'Going online…'
            : available
              ? 'Go offline'
              : 'Go online'}
        </Button>
      </form>
      {state?.message && !state.ok ? <ErrorNote className="mt-3">{state.message}</ErrorNote> : null}
    </section>
  );
}
