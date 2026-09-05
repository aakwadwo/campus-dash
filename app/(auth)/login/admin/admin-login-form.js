'use client';

import { useActionState } from 'react';
import { adminSignIn } from '../actions';

export default function AdminLoginForm() {
  const [state, submit, pending] = useActionState(adminSignIn, {});

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

      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="press bg-brand-500 text-ink hover:bg-brand-600 h-12 w-full rounded-full text-sm font-semibold transition-colors disabled:opacity-55"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {state.error && (
        <p role="alert" className="text-bad text-sm">
          {state.error}
        </p>
      )}
    </form>
  );
}
