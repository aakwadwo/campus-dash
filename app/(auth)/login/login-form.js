'use client';

import { useActionState } from 'react';
import { requestOtp, verifyOtp } from './actions';

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
    <div className="mt-8">
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
              className="focus:border-brand-600 focus:ring-brand-600/50 mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base outline-none focus:ring-2"
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
              className="focus:border-brand-600 focus:ring-brand-600/50 mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-center text-2xl tracking-[0.4em] tabular-nums outline-none focus:ring-2"
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
    <button
      type="submit"
      disabled={pending}
      className="bg-brand-500 text-ink w-full rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function Message({ state }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return <p className="text-muted text-sm">{state.notice}</p>;
  }
  return null;
}
