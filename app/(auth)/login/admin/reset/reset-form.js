'use client';

import { useActionState } from 'react';
import { setAdminPassword } from '../recovery-actions';

export default function ResetPasswordForm({ email }) {
  const [state, submit, pending] = useActionState(setAdminPassword, {});

  return (
    <form action={submit} className="mt-8 space-y-4">
      {/* Not submitted — the account comes from the session, never from the
          page. It is here so somebody with two admin addresses can see which
          one they are about to change. */}
      {email ? (
        <p className="text-muted rounded-card border-line bg-surface-2 border p-3.5 text-sm">
          Setting the password for <span className="text-ink font-medium">{email}</span>
        </p>
      ) : null}

      <label className="block">
        <span className="text-sm font-medium">New password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          autoFocus
          className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Confirm new password</span>
        <input
          name="confirm_password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="press bg-brand-700 hover:bg-brand-800 h-12 w-full rounded-full text-sm font-semibold text-white transition-colors disabled:opacity-55"
      >
        {pending ? 'Saving…' : 'Set my new password'}
      </button>

      {state.error && (
        <p role="alert" className="text-bad text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
