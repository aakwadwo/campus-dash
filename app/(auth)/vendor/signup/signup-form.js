'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { startVendorSignUpAction, finishVendorSignUpAction } from './actions';
import { Button, ErrorNote, Field, Input, Select, Textarea, TextLink } from '@/app/ui';
import OtpInput from '@/app/otp-input';

/**
 * The store form first, the code second.
 *
 * THE STEP DID NOT ADVANCE, AND THIS IS WHY.
 *
 * The step came from both action states at once:
 *
 *     onCodeStep = detailsState.step === 'code' && codeState.step !== 'details'
 *
 * and BOTH were seeded with `{ step: 'details' }`. So the second half was false
 * before the verification form had ever been submitted — which it could not be,
 * because it was never rendered. The code was sent, the SMS arrived, and the
 * screen sat on the details form as though nothing had happened. A vendor's only
 * reasonable conclusion was to press the button again, which spent another code.
 *
 * The verification state is now seeded EMPTY, so `!== 'details'` means what it
 * says: "the verification step has not sent anybody back". The step is derived
 * during render from three facts rather than synchronised in an effect, and the
 * only other input is the applicant asking to go back and change their number.
 *
 * Each action keeps its own pending flag, because "sending a code" and
 * "checking a code" are different waits and the buttons say so.
 *
 * Everything the applicant typed rides the verification step in hidden fields,
 * so a mistyped code costs one field and not a page of retyping.
 */
export default function VendorSignUpForm({ categories, resubmitting, rejectionReason }) {
  const [detailsState, submitDetails, sending] = useActionState(startVendorSignUpAction, {
    step: 'details',
  });
  // SEEDED EMPTY, and that is the fix. The verification action's initial state
  // used to be `{ step: 'details' }` as well, which made `codeState.step !==
  // 'details'` false before this form had ever been submitted — a condition
  // that could only become true after a step that could never be reached.
  const [codeState, submitCode, verifying] = useActionState(finishVendorSignUpAction, {});

  // Asked to go back and change a number. Cleared the moment a new code is
  // requested, in the action itself, so the two cannot disagree.
  const [editing, setEditing] = useState(false);

  // DERIVED DURING RENDER, not synchronised in an effect. There is one question
  // — has a code been sent that we are still waiting on — and three facts that
  // answer it.
  const step =
    detailsState.step === 'code' && codeState.step !== 'details' && !editing ? 'code' : 'details';

  // The values that survive the step change. The code step's copy wins once it
  // has one, because it is the more recent round trip.
  const v = { ...detailsState, ...(codeState.storeName ? codeState : {}) };

  if (step === 'code') {
    return (
      <CodeStep
        values={v}
        notice={detailsState.notice}
        error={codeState.error}
        submit={submitCode}
        verifying={verifying}
        resubmitting={resubmitting}
        onBack={() => setEditing(true)}
      />
    );
  }

  return (
    <form
      action={(formData) => {
        setEditing(false);
        submitDetails(formData);
      }}
      className="space-y-4"
    >
      {rejectionReason ? (
        <div className="rounded-card border-bad/25 bg-bad/8 text-bad border p-3.5 text-sm leading-relaxed">
          <p className="font-medium">Your last application was not approved</p>
          <p className="mt-1">{rejectionReason}</p>
        </div>
      ) : null}

      <Field label="Your name">
        <Input
          name="applicant_name"
          required
          autoComplete="name"
          defaultValue={v.applicantName ?? ''}
        />
      </Field>

      <Field label="Store name" hint="The name students will see.">
        <Input name="store_name" required defaultValue={v.storeName ?? ''} />
      </Field>

      <Field
        label="Are you a student?"
        hint="For our records only. It changes nothing about how your store works."
      >
        <Select name="is_student" required defaultValue={v.isStudent ?? ''}>
          <option value="" disabled>
            Choose one
          </option>
          <option value="yes">Student</option>
          <option value="no">Not a student</option>
        </Select>
      </Field>

      {/* TWO DIFFERENT QUESTIONS, and the labels have to say so. "What do you
          sell?" and a category dropdown underneath read as one question asked
          twice; a description and a category are different facts and a vendor
          who conflates them fills one of them in wrongly. */}
      <Field
        label="Business description"
        hint="A sentence about your store, shown to students browsing."
      >
        <Textarea
          name="description"
          required
          rows={3}
          defaultValue={v.description ?? ''}
          placeholder="Hot jollof, waakye and fried rice, cooked to order."
        />
      </Field>

      <Field label="Business category" hint="Which section of Campus Dash you appear under.">
        <Select name="category_id" required defaultValue={v.categoryId ?? ''}>
          <option value="" disabled>
            Choose a category
          </option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Phone number"
        hint="This is how you sign in, and how we reach you about orders."
      >
        <Input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="tel"
          placeholder="020 123 4567"
          defaultValue={v.phoneRaw ?? ''}
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
          <TextLink href="/terms?audience=VENDOR" className="font-medium">
            Campus Dash vendor terms
          </TextLink>
          .
        </span>
      </label>

      <Button type="submit" size="lg" block disabled={sending}>
        {sending ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Sending code…
          </span>
        ) : (
          'Send verification code'
        )}
      </Button>
      {detailsState.error ? <ErrorNote>{detailsState.error}</ErrorNote> : null}
    </form>
  );
}

/**
 * The code screen.
 *
 * Separated out so it can announce itself — `autoFocus` on the input and a
 * `role="status"` line naming the number — because the whole failure this form
 * is recovering from was a step change nobody could see.
 */
function CodeStep({ values, notice, error, submit, verifying, resubmitting, onBack }) {
  const input = useRef(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <form action={submit} className="space-y-4">
      <input type="hidden" name="applicant_name" value={values.applicantName ?? ''} />
      <input type="hidden" name="store_name" value={values.storeName ?? ''} />
      <input type="hidden" name="is_student" value={values.isStudent ?? ''} />
      <input type="hidden" name="description" value={values.description ?? ''} />
      <input type="hidden" name="category_id" value={values.categoryId ?? ''} />
      <input type="hidden" name="phone" value={values.phoneRaw ?? ''} />

      <div className="rounded-card bg-brand-50 p-3.5" role="status">
        <p className="text-sm leading-relaxed">
          {notice ?? `We sent a 6-digit code to ${values.phoneRaw}.`}
        </p>
      </div>

      <Field label="Verification code">
        <OtpInput ref={input} disabled={verifying} />
      </Field>

      <Button type="submit" size="lg" block disabled={verifying}>
        {verifying ? (
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Checking…
          </span>
        ) : resubmitting ? (
          'Resubmit application'
        ) : (
          'Register my store'
        )}
      </Button>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <button
        type="button"
        onClick={onBack}
        disabled={verifying}
        className="text-muted hover:text-ink block w-full text-center text-sm font-medium underline underline-offset-4 disabled:opacity-55"
      >
        Change my details or number
      </button>
    </form>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 animate-spin rounded-full border-2 border-white/35 border-t-white"
    />
  );
}
