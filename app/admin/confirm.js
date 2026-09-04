'use client';

import { useState } from 'react';

/**
 * A submit button that will not submit until it has been asked twice.
 *
 * WHY NOT window.confirm: a native dialog is a modal the page cannot style,
 * cannot test and cannot explain in. What an operator needs before deleting a
 * menu item is not a generic "Are you sure?" — it is a sentence naming the
 * thing and what happens to it, in the console's own voice, next to the reason
 * they are about to have recorded against their name.
 *
 * The mechanism is the important part: while unarmed the control is
 * `type="button"`, so it is not a submit control at all and pressing it — or
 * pressing Enter in the form — cannot post. Arming swaps in a real submit
 * button. There is no state in which one click performs the action.
 *
 * THIS IS NOT AUTHORISATION AND NOT VALIDATION. The database still re-checks
 * is_admin(), still demands a reason of its own, and still refuses the write on
 * its own terms. This only makes a destructive act deliberate.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'Yes, do it',
  question,
  variant = 'danger',
  disabled = false,
  pendingLabel,
  pending = false,
}) {
  const [armed, setArmed] = useState(false);

  const styles = {
    primary: 'bg-brand-500 text-ink',
    secondary: 'bg-white text-ink ring-1 ring-black/15',
    danger: 'bg-white text-red-700 ring-1 ring-red-200',
  };
  const base = 'rounded px-3 py-1.5 text-sm font-semibold';

  if (!armed) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setArmed(true)}
        className={`${base} ${styles[variant]}`}
      >
        {children}
      </button>
    );
  }

  return (
    <div className="rounded border border-red-200 bg-red-50 p-3">
      <p className="mb-2 text-sm text-red-900">{question}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={disabled || pending}
          className={`${base} bg-red-700 text-white`}
        >
          {pending ? (pendingLabel ?? 'Working…') : confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className={`${base} text-ink bg-white ring-1 ring-black/15`}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
