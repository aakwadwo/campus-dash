'use client';

import { useActionState } from 'react';
import { startVendorSignUpAction, finishVendorSignUpAction } from './actions';
import { Button, ErrorNote, Field, Input, Select, Textarea, TextLink } from '@/app/ui';

const INITIAL = { step: 'details' };

/**
 * The store form first, the code second.
 *
 * Everything the applicant typed rides the verification step in hidden fields,
 * so a mistyped code costs one field and not a page of retyping.
 */
export default function VendorSignUpForm({ categories, resubmitting, rejectionReason }) {
  const [detailsState, submitDetails, sending] = useActionState(startVendorSignUpAction, INITIAL);
  const [codeState, submitCode, verifying] = useActionState(finishVendorSignUpAction, INITIAL);

  const onCodeStep = detailsState.step === 'code' && codeState.step !== 'details';
  const state = codeState.error ? codeState : detailsState;
  const v = { ...detailsState, ...(codeState.storeName ? codeState : {}) };

  if (onCodeStep) {
    return (
      <form action={submitCode} className="space-y-4">
        <input type="hidden" name="applicant_name" value={v.applicantName ?? ''} />
        <input type="hidden" name="store_name" value={v.storeName ?? ''} />
        <input type="hidden" name="is_student" value={v.isStudent ?? ''} />
        <input type="hidden" name="description" value={v.description ?? ''} />
        <input type="hidden" name="category_id" value={v.categoryId ?? ''} />
        <input type="hidden" name="phone" value={v.phoneRaw ?? ''} />

        <p className="text-muted text-sm leading-relaxed" role="status">
          {detailsState.notice ?? `We sent a 6-digit code to ${v.phoneRaw}.`}
        </p>

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

        <Button type="submit" size="lg" block disabled={verifying}>
          {verifying ? 'Checking…' : resubmitting ? 'Resubmit application' : 'Register my store'}
        </Button>
        {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
      </form>
    );
  }

  return (
    <form action={submitDetails} className="space-y-4">
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

      <Field label="What do you sell?">
        <Textarea
          name="description"
          required
          rows={3}
          defaultValue={v.description ?? ''}
          placeholder="Hot jollof, waakye and fried rice, cooked to order."
        />
      </Field>

      <Field label="Business category">
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
        {sending ? 'Sending code…' : 'Send verification code'}
      </Button>
      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}
    </form>
  );
}
