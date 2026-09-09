'use client';

import { useActionState } from 'react';
import { requestOtp, verifyOtp } from '../actions';
import { Button, ErrorNote, Field, Input } from '@/app/ui';

const INITIAL = { step: 'phone' };

/**
 * Vendor sign-in: a code by SMS.
 *
 * A vendor's phone number IS the credential — no email is ever asked for, at
 * sign-up or here. That is not a lesser kind of account; it is the one a store
 * owner can actually use.
 */
export default function VendorLoginForm({ next }) {
  const [phoneState, submitPhone, sendingCode] = useActionState(requestOtp, INITIAL);
  const [codeState, submitCode, verifying] = useActionState(verifyOtp, INITIAL);

  const state = codeState.step === 'code' && codeState.error ? codeState : phoneState;
  const onCodeStep = phoneState.step === 'code';
  const phone = codeState.phone ?? phoneState.phone ?? '';

  return (
    <div>
      {!onCodeStep ? (
        <form action={submitPhone} className="space-y-4">
          <Field label="Phone number">
            <Input
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="tel"
              required
              defaultValue={phone}
              placeholder="020 123 4567"
            />
          </Field>
          <SubmitButton pending={sendingCode} label="Send code" pendingLabel="Sending…" />
          <Message state={state} />
        </form>
      ) : (
        <form action={submitCode} className="space-y-4">
          <input type="hidden" name="phone" value={phone} />
          <input type="hidden" name="next" value={next} />
          <Field label="Verification code">
            <input
              name="token"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              placeholder="123456"
              className="rounded-input border-line-strong bg-surface focus:border-brand-600 placeholder:text-faint h-14 w-full border px-4 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums transition-colors outline-none"
            />
          </Field>
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
  if (state.error) return <ErrorNote>{state.error}</ErrorNote>;
  if (state.notice) {
    return (
      <p className="text-muted text-sm leading-relaxed" role="status">
        {state.notice}
      </p>
    );
  }
  return null;
}
