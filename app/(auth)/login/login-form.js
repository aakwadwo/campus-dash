'use client';

import { useActionState, useEffect, useState } from 'react';
import { requestEmailCode, verifyEmailCode, resendEmailCode } from './actions';
import { RESEND_COOLDOWN_SECONDS } from '@/lib/auth/customer-signup';
import { Button, ErrorNote, Field, Input } from '@/app/ui';

/**
 * The address form starts on its own step; the other actions start EMPTY.
 *
 * That distinction is load-bearing. Seeding them all with `{ step: 'email' }`
 * makes "this action has not run" indistinguishable from "the server sent you
 * back to the address", and the form then never advances to the code box
 * however many codes it has sent.
 */
const START = { step: 'email' };
const NOT_RUN = {};

/**
 * Customer sign-in: a code to a school address.
 *
 * Two steps in one component — request a code, then enter it. The address is
 * the identity, so it is carried into the second step rather than retyped, and
 * a new code can be asked for without going back.
 *
 * NO LINK, ANYWHERE. A magic link opens in whichever browser the mail app
 * picks, which on a phone is routinely not the one holding this form. A code
 * can be typed into the tab that is already open.
 */
export default function LoginForm({ next }) {
  const [emailState, submitEmail, sendingCode] = useActionState(requestEmailCode, START);
  const [codeState, submitCode, verifying] = useActionState(verifyEmailCode, NOT_RUN);
  const [resendState, resend, resending] = useActionState(resendEmailCode, NOT_RUN);

  // The last action that ACTUALLY RAN decides. A verification or a resend can
  // send somebody back to the address step — an address that was never signed
  // up — and that has to beat the earlier action which got them to the code.
  const decisive = [codeState, resendState].map((s) => s?.step).find(Boolean);
  const onCodeStep = decisive === 'code' || (decisive === undefined && emailState.step === 'code');

  const email = resendState.email ?? codeState.email ?? emailState.email ?? '';
  const state =
    [codeState, resendState, emailState].find((s) => s.error) ??
    [resendState, emailState, codeState].find((s) => s.notice) ??
    emailState;
  const sentAt = resendState.sentAt ?? emailState.sentAt ?? null;

  if (!onCodeStep) {
    return (
      <form action={submitEmail} className="space-y-4">
        <Field label="School email" hint="Your Academic City address, ending @acity.edu.gh.">
          <Input
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            defaultValue={email}
            placeholder="kwame.mensah@acity.edu.gh"
          />
        </Field>
        <Button type="submit" size="lg" block disabled={sendingCode}>
          {sendingCode ? 'Sending…' : 'Send code'}
        </Button>
        <Message state={state} />
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <form action={submitCode} className="space-y-4">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="next" value={next} />

        <p className="text-muted text-sm leading-relaxed">
          Enter the 6-digit code we sent to{' '}
          <span className="text-ink font-medium break-all">{email}</span>.
        </p>

        <Field label="Verification code">
          <input
            name="token"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={8}
            required
            autoFocus
            placeholder="123456"
            className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint h-14 w-full border px-4 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums transition-colors outline-none"
          />
        </Field>

        <Button type="submit" size="lg" block disabled={verifying || resending}>
          {verifying ? 'Checking…' : 'Verify'}
        </Button>
      </form>

      {/* A SEPARATE FORM. Two submits in one would race for the same pending
          state, and the browser would post the half-typed code with the
          resend. */}
      <form action={resend}>
        <input type="hidden" name="email" value={email} />
        <ResendButton pending={resending} blocked={verifying} sentAt={sentAt} />
      </form>

      <Message state={state} />

      <p className="text-faint text-center text-xs leading-relaxed">
        Check your spam folder if it has not arrived. A new code replaces the old one.
      </p>
    </div>
  );
}

function ResendButton({ pending, blocked, sentAt }) {
  const remaining = useCooldown(sentAt);
  return (
    <div className="text-center">
      <button
        type="submit"
        disabled={pending || blocked || remaining > 0}
        className="text-brand-700 press-sm disabled:text-faint text-sm font-semibold underline-offset-4 hover:underline disabled:no-underline"
      >
        {pending
          ? 'Sending…'
          : remaining > 0
            ? `Send a new code in ${remaining}s`
            : 'Send a new code'}
      </button>
    </div>
  );
}

/**
 * Seconds left before another code may be asked for.
 *
 * A courtesy, and honest about it: a new code kills the one being typed, so the
 * timer stops somebody doing that to themselves. Supabase enforces the real
 * limit and answers 429, which the action surfaces.
 */
function useCooldown(sentAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sentAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  if (!sentAt) return 0;
  return Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((now - sentAt) / 1000));
}

function Message({ state }) {
  if (state?.error) return <ErrorNote>{state.error}</ErrorNote>;
  if (state?.notice) {
    return (
      <p className="text-muted text-sm leading-relaxed" role="status">
        {state.notice}
      </p>
    );
  }
  return null;
}
