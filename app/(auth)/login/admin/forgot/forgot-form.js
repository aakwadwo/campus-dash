'use client';

import { useActionState } from 'react';
import { requestAdminPasswordReset } from '../recovery-actions';

export default function ForgotPasswordForm() {
  const [state, submit, pending] = useActionState(requestAdminPasswordReset, {});

  // Once a link has been asked for, the form is done. Leaving the button there
  // invites a second request that invalidates the first link — the exact
  // failure the vendor sign-up form was built to avoid.
  if (state.sent) {
    return (
      <div className="mt-8">
        <p
          role="status"
          className="rounded-card border-line bg-surface-2 border p-3.5 text-sm leading-relaxed"
        >
          {state.notice}
        </p>
        <p className="text-muted mt-4 text-sm leading-relaxed">
          The link is good for one use. Check your spam folder before asking for another, because a
          second link makes the first one stop working.
        </p>
      </div>
    );
  }

  return (
    <form action={submit} className="mt-8 space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Email address</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="press bg-brand-700 hover:bg-brand-800 h-12 w-full rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-55"
      >
        {pending ? 'Sending…' : 'Email me a reset link'}
      </button>

      {state.error && (
        <p role="alert" className="text-bad text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
