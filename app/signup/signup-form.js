'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  startSignUpAction,
  finishSignUpAction,
  resendSignUpCodeAction,
  completeSignUpAction,
} from './actions';
import { graduationYears, RESEND_COOLDOWN_SECONDS } from '@/lib/auth/customer-signup';
import { Button, CodeSentTo, ErrorNote, Field, Input, Select, TextLink } from '@/app/ui';
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

/**
 * Later states win, so a correction survives a failed round trip.
 *
 * THE KEYS ARE THE ONES THE ACTIONS ACTUALLY CARRY. This listed `level`, which
 * no step has returned since a graduation year replaced it, and omitted the
 * three fields that replaced it — so a failure on the last step handed somebody
 * back a form with their affiliation, year and gender blank. Gender is now a
 * required answer, which turns that from untidy into a second question.
 */
function mergeValues(states) {
  return states.reduce((acc, s) => {
    for (const key of [
      'firstName',
      'lastName',
      'email',
      'affiliation',
      'graduationYear',
      'gender',
      'phoneRaw',
    ]) {
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
      <input type="hidden" name="affiliation" value={values.affiliation ?? ''} />
      <input type="hidden" name="graduation_year" value={values.graduationYear ?? ''} />
      <input type="hidden" name="gender" value={values.gender ?? ''} />
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

      <WhoYouAre values={values} />

      <PhoneField defaultValue={values.phoneRaw ?? ''} />

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
          Already have one?{' '}
          <TextLink href={`/login?next=${encodeURIComponent(next)}`}>
            Sign in to customer account
          </TextLink>
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

        <CodeSentTo>{values.email}</CodeSentTo>

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

      <WhoYouAre values={values} />

      <PhoneField defaultValue={values.phoneRaw ?? ''} />

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

/**
 * Student or staff, and what each of them is asked next.
 *
 * TWO DIFFERENT PEOPLE, NOT ONE WITH AN EXTRA BOX. Staff eat lunch and staff
 * can be Partners; asking them for a year group was asking them to claim
 * something untrue in order to buy a sandwich. The graduation-year field
 * appears only for a student, and the value is dropped server-side for staff
 * anyway — a CHECK constraint says staff have no graduation year.
 *
 * A GRADUATION YEAR RATHER THAN A LEVEL, because a level is wrong for three of
 * the four years it describes: nobody comes back in September to move
 * themselves up. The year somebody expects to finish stays true for as long as
 * they are here, which is the whole point of asking it instead.
 */
function WhoYouAre({ values }) {
  // NEITHER IS PRESELECTED. The two lead to different questions, and a default
  // would answer the first one for somebody.
  const [affiliation, setAffiliation] = useState(values.affiliation || '');
  const years = graduationYears();

  return (
    <>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Are you a student or staff?</legend>
        <div className="grid grid-cols-2 gap-2.5">
          {[
            ['STUDENT', 'Student'],
            ['STAFF', 'Staff'],
          ].map(([value, label]) => (
            <label
              key={value}
              className={`rounded-card press flex min-h-12 cursor-pointer items-center justify-center border text-sm font-semibold transition-colors ${
                affiliation === value
                  ? 'border-brand-600 bg-brand-50 ring-brand-600/25 ring-1'
                  : 'border-line-strong hover:bg-surface-2'
              }`}
            >
              <input
                type="radio"
                name="affiliation"
                value={value}
                checked={affiliation === value}
                onChange={() => setAffiliation(value)}
                className="sr-only"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      {affiliation === 'STUDENT' ? (
        <Field
          label="When do you expect to graduate?"
          hint="So we do not have to ask you again every year."
        >
          <Select name="graduation_year" required defaultValue={values.graduationYear ?? ''}>
            <option value="" disabled>
              Choose a year
            </option>
            {years.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        // Staff do not graduate (and nobody may have chosen yet): an empty value
        // is what makes the server store null rather than whatever a previous
        // render left behind. The server discards a year sent for staff anyway.
        <input type="hidden" name="graduation_year" value="" />
      )}

      {/* MALE OR FEMALE, AND ONE OF THEM IS CHOSEN. The third option used to be
          "prefer not to say", which stored a null — and a column that cannot be
          counted is a column with no reason to be asked for. The placeholder is
          `disabled`, so it is a prompt rather than a fourth answer. */}
      <Field label="Gender">
        <Select name="gender" required defaultValue={values.gender ?? ''}>
          <option value="" disabled>
            Choose
          </option>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
        </Select>
      </Field>
    </>
  );
}

/**
 * A Ghanaian phone number, asked for the way Ghanaians write one.
 *
 * TYPE 0XXXXXXXXX. The +233 is shown as a fixed prefix rather than asked for,
 * because nobody writes their own number that way and every person who tried
 * produced +2330244… — a leading zero after the country code, which is not a
 * number. normaliseGhanaPhone() accepts all the forms anyway; this is about not
 * making somebody guess which one is wanted.
 *
 * The prefix is decoration, not a value: the field still submits exactly what
 * was typed, and the server normalises it.
 */
function PhoneField({ defaultValue }) {
  return (
    <Field label="Phone number" hint="So a Partner can call you when they arrive.">
      <div className="relative">
        <span
          className="text-muted pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4 text-[15px] font-medium"
          aria-hidden
        >
          +233
        </span>
        <Input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="numeric"
          placeholder="020 123 4567"
          defaultValue={defaultValue}
          className="pl-[3.75rem]"
          aria-describedby="phone-format"
        />
      </div>
      <p id="phone-format" className="text-faint mt-1.5 text-xs">
        Start with 0, the way you would write it to a friend.
      </p>
    </Field>
  );
}
