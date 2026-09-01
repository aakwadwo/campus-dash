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
          className="focus:border-brand-600 focus:ring-brand-600/50 mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base outline-none focus:ring-2"
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="focus:border-brand-600 focus:ring-brand-600/50 mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base outline-none focus:ring-2"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="bg-brand-500 text-ink w-full rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {state.error && (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      )}
    </form>
  );
}
