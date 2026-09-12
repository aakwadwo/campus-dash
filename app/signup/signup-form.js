'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  startSignUpAction,
  finishSignUpAction,
  resendSignUpCodeAction,
  completeSignUpAction,
} from './actions';
import { LEVELS, RESEND_COOLDOWN_SECONDS } from '@/lib/auth/customer-signup';
import { Button, ErrorNote, Field, Input, Select, TextLink } from '@/app/ui';
import OtpInput from '@/app/otp-input';

/**
 * The details form starts on its own step; every other action starts EMPTY.
 *
 * That distinction is load-bearing. Seeding them all with `{ step: 'details' }`
 * makes "this action has not run yet" indistinguishable from "the server sent
 * you back to the details", and the form then refuses to advance past step one
 * however many codes it has sent.
 */
const START = { step: 'details' };
const NOT_RUN = {};

/**
 * Details first, code second, and a third step that only exists when it has to.
 *
 * The order is the point. Asking for an address and a code before saying what
 * the form is asks somebody to prove who they are before they have decided to
 * be here — so everything is collected up front and the code is the last thing
 * between them and an account.
 *
 * THE THIRD STEP. Verification can succeed and the account still not be
 * created: a student ID already registered is the case that matters. By then
 * the code is spent and the session is real, so showing the code box again
 * would ask for a code that cannot exist. `complete` keeps the session and asks
 * only for the field that was refused.
 *
 * The collected details ride each step in hidden fields, so a mistyped code
 * costs one field and not the whole form.
 */
export default function SignUpForm({ next, hasAccount }) {
  const [detailsState, submitDetails, sending] = useActionState(startSignUpAction, START);
  const [codeState, submitCode, verifying] = useActionState(finishSignUpAction, NOT_RUN);
  const [resendState, resend, resending] = useActionState(resendSignUpCodeAction, NOT_RUN);
  const [completeState, submitComplete, completing] = useActionState(completeSignUpAction, NOT_RUN);

  // The form is driven by the server's own account of where the person is —
  // each action returns a `step` — rather than by client state trying to keep
  // up with it.
  const step = pickStep({ detailsState, codeState, resendState, completeState });
  const values = mergeValues([detailsState, codeState, resendState, completeState]);
  const state = latestMessage([completeState, codeState, resendState, detailsState]);

  if (step === 'complete') {
    return (
      <CompleteStep
        values={values}
        next={next}
        action={submitComplete}
        pending={completing}
        state={state}
      />
    );
  }

  if (step === 'code') {
    return (
      <CodeStep
        values={values}
        next={next}
        submitCode={submitCode}
        verifying={verifying}
        resend={resend}
        resending={resending}
        state={state}
        sentAt={resendState.sentAt ?? detailsState.sentAt ?? null}
      />
    );
  }

  return (
    <DetailsStep
      values={values}
      next={next}
      action={submitDetails}
      pending={sending}
      state={state}
      hasAccount={hasAccount}
    />
  );
}

/**
 * Which step to show.
 *
 * Decided by the LAST action that actually ran, which is why every state but
 * the first starts empty — an action that has not run has no opinion, and
 * giving it one is how the form gets stuck on step one.
 *
 * `complete` beats everything: it means the address is verified and an account
 * is half-made, so the only useful thing on screen is the field that finishes
 * it.
 */
function pickStep({ detailsState, codeState, resendState, completeState }) {
  const steps = [completeState, codeState, resendState, detailsState]
    .map((s) => s?.step)
    .filter(Boolean);

  if (steps.includes('complete')) return 'complete';

  // A later action sending somebody back to the details wins over the earlier
  // one that got them to the code — an expired session, a cleared address.
  const decisive = [completeState, resendState, codeState].map((s) => s?.step).find(Boolean);
  if (decisive === 'details') return 'details';

  return steps.includes('code') ? 'code' : 'details';
}

/** Later states win, so a correction survives a failed round trip. */
function mergeValues(states) {
  return states.reduce((acc, s) => {
    for (const key of ['firstName', 'lastName', 'email', 'level', 'phoneRaw']) {
      if (s?.[key] !== undefined && s[key] !== '') acc[key] = s[key];
    }
    return acc;
  }, {});
}

function latestMessage(states) {
  return states.find((s) => s?.error) ?? states.find((s) => s?.notice) ?? null;
}

/** Every step carries the same hidden fields, so nothing is retyped. */
function Carried({ values, next }) {
  return (
    <>
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="first_name" value={values.firstName ?? ''} />
      <input type="hidden" name="last_name" value={values.lastName ?? ''} />
      <input type="hidden" name="email" value={values.email ?? ''} />
      <input type="hidden" name="level" value={values.level ?? ''} />
      <input type="hidden" name="phone" value={values.phoneRaw ?? ''} />
    </>
  );
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

// --- Step 1 -------------------------------------------------------------------

function DetailsStep({ values, next, action, pending, state, hasAccount }) {
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">
          <Input
            name="first_name"
            required
            autoComplete="given-name"
            defaultValue={values.firstName ?? ''}
          />
        </Field>
        <Field label="Last name">
          <Input
            name="last_name"
            required
            autoComplete="family-name"
            defaultValue={values.lastName ?? ''}
          />
        </Field>
      </div>

      <Field label="School email" hint="Your Academic City address, ending @acity.edu.gh.">
        <Input
          name="email"
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="kwame.mensah@acity.edu.gh"
          defaultValue={values.email ?? ''}
        />
      </Field>

      <Field label="Level">
        <Select name="level" required defaultValue={values.level ?? ''}>
          <option value="" disabled>
            Choose your level
          </option>
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              Level {level}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Phone number" hint="So a Partner can call you when they arrive.">
        <Input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="tel"
          placeholder="020 123 4567"
          defaultValue={values.phoneRaw ?? ''}
        />
      </Field>

      <label className="border-line bg-surface-2 rounded-card flex items-start gap-3 border p-3.5">
        <input
          type="checkbox"
          name="accept_terms"
          className="accent-brand-500 mt-0.5 size-4 shrink-0"
        />
        <span className="text-muted text-sm leading-relaxed">
          I accept the{' '}
          <TextLink href="/terms?audience=CUSTOMER" className="font-medium">
            Campus Dash customer terms
          </TextLink>
          .
        </span>
      </label>

      <Button type="submit" size="lg" block disabled={pending}>
        {pending ? 'Sending code…' : 'Send verification code'}
      </Button>
      <Message state={state} />

      {hasAccount ? null : (
        <p className="text-muted text-center text-sm">
          Already have an account? <TextLink href="/login">Sign in</TextLink>
        </p>
      )}
    </form>
  );
}

// --- Step 2 -------------------------------------------------------------------

function CodeStep({ values, next, submitCode, verifying, resend, resending, state, sentAt }) {
  const remaining = useCooldown(sentAt);

  return (
    <div className="space-y-4">
      <form action={submitCode} className="space-y-4">
        <Carried values={values} next={next} />

        <p className="text-muted text-sm leading-relaxed">
          Enter the 6-digit code we sent to{' '}
          <span className="text-ink font-medium break-all">{values.email}</span>.
        </p>

        <Field label="Verification code">
          <OtpInput autoFocus disabled={verifying} />
        </Field>

        <Button type="submit" size="lg" block disabled={verifying || resending}>
          {verifying ? 'Checking…' : 'Create my account'}
        </Button>
      </form>

      {/* A SEPARATE FORM, not a second button in the one above. Two submits in
          one form race each other for the same pending state, and the browser
          would post the half-typed code along with the resend. */}
      <form action={resend}>
        <Carried values={values} next={next} />
        <div className="text-center">
          <button
            type="submit"
            disabled={resending || verifying || remaining > 0}
            className="text-brand-700 press-sm disabled:text-faint text-sm font-semibold underline-offset-4 hover:underline disabled:no-underline"
          >
            {resending
              ? 'Sending…'
              : remaining > 0
                ? `Send a new code in ${remaining}s`
                : 'Send a new code'}
          </button>
        </div>
      </form>

      <Message state={state} />

      <p className="text-faint text-center text-xs leading-relaxed">
        Check your spam folder if it has not arrived. A new code replaces the old one.
      </p>
    </div>
  );
}

/**
 * Seconds left before another code may be asked for.
 *
 * Client-side and honest about what it is: a courtesy that stops somebody
 * killing the code they are halfway through typing. Supabase enforces the real
 * limit and answers 429, which the action surfaces plainly — so a person who
 * reloads past this timer is refused by the server, not by this number.
 */
function useCooldown(sentAt) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sentAt) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [sentAt]);

  if (!sentAt) return 0;
  const elapsed = Math.floor((now - sentAt) / 1000);
  return Math.max(0, RESEND_COOLDOWN_SECONDS - elapsed);
}

// --- Step 3 -------------------------------------------------------------------

/**
 * The address is verified and the session is real; only the details were
 * refused. Everything is editable, because which field was wrong is the
 * server's answer to give and not this component's to guess.
 */
function CompleteStep({ values, next, action, pending, state }) {
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="email" value={values.email ?? ''} />

      <div className="bg-good-bg text-good rounded-card px-4 py-3 text-sm leading-relaxed">
        <span className="font-semibold">{values.email}</span> is verified. One thing left.
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name">
          <Input
            name="first_name"
            required
            autoComplete="given-name"
            defaultValue={values.firstName ?? ''}
          />
        </Field>
        <Field label="Last name">
          <Input
            name="last_name"
            required
            autoComplete="family-name"
            defaultValue={values.lastName ?? ''}
          />
        </Field>
      </div>

      <Field label="Level">
        <Select name="level" required defaultValue={values.level ?? ''}>
          <option value="" disabled>
            Choose your level
          </option>
          {LEVELS.map((level) => (
            <option key={level} value={level}>
              Level {level}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Phone number" hint="So a Partner can call you when they arrive.">
        <Input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="tel"
          defaultValue={values.phoneRaw ?? ''}
        />
      </Field>

      {/* Already agreed to on the first step, and carried so the database sees
          the same acceptance it would have seen then. */}
      <input type="hidden" name="accept_terms" value="on" />

      <Button type="submit" size="lg" block disabled={pending}>
        {pending ? 'Finishing…' : 'Finish creating my account'}
      </Button>
      <Message state={state} />
    </form>
  );
}
