'use client';

import { useActionState } from 'react';
import { requestOtp, verifyOtp } from './actions';
import { Button, ErrorNote } from '@/app/ui';

const INITIAL = { step: 'phone' };

/**
 * Two steps in one component: request a code, then enter it. Deliberately
 * plain — this exists so phone OTP can be exercised end to end, not to be the
 * finished customer experience.
 */
export default function LoginForm({ next }) {
  const [phoneState, submitPhone, sendingCode] = useActionState(requestOtp, INITIAL);
  const [codeState, submitCode, verifying] = useActionState(verifyOtp, INITIAL);

  // Once a code has been requested, the verify form owns the screen.
  const state = codeState.step === 'code' && codeState.error ? codeState : phoneState;
  const onCodeStep = phoneState.step === 'code';
  const phone = codeState.phone ?? phoneState.phone ?? '';

  return (
    <div>
      {!onCodeStep ? (
        <form action={submitPhone} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium">Phone number</span>
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              required
              defaultValue={phone}
              placeholder="020 123 4567"
              className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-4 text-base transition-colors outline-none"
            />
          </label>
          <SubmitButton pending={sendingCode} label="Send code" pendingLabel="Sending…" />
          <Message state={state} />
        </form>
      ) : (
        <form action={submitCode} className="space-y-4">
          <input type="hidden" name="phone" value={phone} />
          <input type="hidden" name="next" value={next} />
          <label className="block">
            <span className="text-sm font-medium">Verification code</span>
            <input
              name="token"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              placeholder="123456"
              className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint mt-1.5 h-14 w-full border px-4 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums transition-colors outline-none"
            />
          </label>
          <SubmitButton pending={verifying} label="Verify" pendingLabel="Checking…" />
          <Message state={state} />
        </form>
      )}
    </div>
  );
}

function SubmitButton({ pending, label, pendingLabel }) {
  return (
    <Button type="submit" size="lg" block disabled={pending}>
      {pending ? pendingLabel : label}
    </Button>
  );
}

function Message({ state }) {
  if (state.error) {
    return <ErrorNote>{state.error}</ErrorNote>;
  }
  if (state.notice) {
    return (
      <p className="text-muted text-sm leading-relaxed" role="status">
        {state.notice}
      </p>
    );
  }
  return null;
}
