'use client';

import { useActionState, useEffect, useState } from 'react';
import { requestAdminPasswordReset } from '../recovery-actions';

/** Long enough that a slow mailbox is not mistaken for a lost email. */
const RESEND_AFTER_SECONDS = 30;

export default function ForgotPasswordForm({ defaultEmail = '' }) {
  const [state, submit, pending] = useActionState(requestAdminPasswordReset, {});
  const [waitLeft, setWaitLeft] = useState(0);

  // A COOLDOWN, NOT A DEAD END. The form used to disappear once a link had been
  // asked for, which left anybody whose link failed — the common case before the
  // recovery page learned to read every shape of link — with no way to ask for
  // another except reloading the page. Asking again is allowed; asking twice in
  // five seconds is what invalidates the first link, so only that is stopped.
  useEffect(() => {
    if (!state.sent || !state.sentAt) return undefined;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - state.sentAt) / 1000);
      setWaitLeft(Math.max(0, RESEND_AFTER_SECONDS - elapsed));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [state.sent, state.sentAt]);

  return (
    <form action={submit} className="mt-8 space-y-4">
      {state.sent ? (
        <div
          role="status"
          className="rounded-card border-good/30 bg-good/10 border p-3.5 text-sm leading-relaxed"
        >
          <p>{state.notice}</p>
          <p className="text-muted mt-2">
            Open it on any device — the link does not have to be used on this one. Check spam before
            asking again, because a new link stops the previous one working.
          </p>
        </div>
      ) : null}

      <label className="block">
        <span className="text-sm font-medium">Email address</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus={!state.sent}
          defaultValue={state.email ?? defaultEmail}
          className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={pending || waitLeft > 0}
        className="press bg-brand-700 hover:bg-brand-800 h-12 w-full rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-55"
      >
        {pending
          ? 'Sending…'
          : waitLeft > 0
            ? `Send another link in ${waitLeft}s`
            : state.sent
              ? 'Send another link'
              : 'Email me a reset link'}
      </button>

      {state.error && (
        <p role="alert" className="text-bad text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
