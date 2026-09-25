'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  startVendorSignUpAction,
  finishVendorSignUpAction,
  resendVendorCodeAction,
} from './actions';
import { Button, ErrorNote, Field, Input, Select, Textarea, TextLink } from '@/app/ui';
import OtpInput from '@/app/otp-input';
import VendorLocationFields from '@/app/vendor-location-fields';

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
export default function VendorSignUpForm({
  account = null,
  categories,
  resubmitting,
  rejectionReason,
}) {
  const [detailsState, submitDetails, sending] = useActionState(startVendorSignUpAction, {
    step: 'details',
  });
  // SEEDED EMPTY, and that is the fix. The verification action's initial state
  // used to be `{ step: 'details' }` as well, which made `codeState.step !==
  // 'details'` false before this form had ever been submitted — a condition
  // that could only become true after a step that could never be reached.
  const [codeState, submitCode, verifying] = useActionState(finishVendorSignUpAction, {});
  const [resendState, resend, resending] = useActionState(resendVendorCodeAction, {});

  // Asked to go back and change a number. Cleared the moment a new code is
  // requested, in the action itself, so the two cannot disagree.
  const [editing, setEditing] = useState(false);

  // DERIVED DURING RENDER from every action that can move the step, which now
  // includes resend. Leaving resend out of this was how the code screen could
  // vanish under somebody: a resend returning `step: 'code'` was invisible here,
  // so the screen was decided by two states while three could change it.
  //
  // Only a DECISIVE 'details' sends somebody back — an action that actually ran
  // and said so. An untouched initial state says nothing and must not outvote a
  // code that has been sent.
  const decisive = [resendState.step, codeState.step].find(Boolean);
  const step =
    !editing && detailsState.step === 'code' && decisive !== 'details' ? 'code' : 'details';

  // The values that survive the step change. Later round trips win.
  const v = {
    ...detailsState,
    ...(codeState.storeName ? codeState : {}),
    ...(resendState.storeName ? resendState : {}),
  };

  // The number the newest code actually went to, and when it was sent — the
  // resend is the more recent fact whenever it has one.
  const phone = resendState.phone ?? codeState.phone ?? detailsState.phone ?? null;
  const sentAt = resendState.sentAt ?? detailsState.sentAt ?? null;

  // ONE MESSAGE, AND IT IS THE NEWEST ONE — decided by when each action
  // actually returned, not by a fixed order between them. A fixed order buries
  // a fresh verification error under a stale "a new code is on its way", which
  // is precisely the case that leaves somebody staring at a code screen that
  // has silently refused them.
  const newest = [resendState, codeState, detailsState]
    .filter((state) => state?.at && (state.error || state.notice))
    .sort((a, b) => b.at - a.at)[0];
  const message = newest?.error ?? newest?.notice ?? null;
  const messageIsError = Boolean(newest?.error);

  if (step === 'code') {
    return (
      <CodeStep
        values={v}
        phone={phone}
        message={message}
        messageIsError={messageIsError}
        submit={submitCode}
        verifying={verifying}
        resend={resend}
        resending={resending}
        sentAt={sentAt}
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

      {/* ASKED ONCE. A signed-in account already has a name; the server reads
          it from the profile, so there is nothing to type here. */}
      {account?.name ? (
        <input type="hidden" name="applicant_name" value={account.name} />
      ) : (
        <Field label="Your name">
          <Input
            name="applicant_name"
            required
            autoComplete="name"
            defaultValue={v.applicantName ?? ''}
          />
        </Field>
      )}

      <Field label="Store name" hint="The name students will see.">
        <Input name="store_name" required defaultValue={v.storeName ?? ''} />
      </Field>

      {/* ALREADY KNOWN for a customer: their profile says student or staff. */}
      {account?.isStudent ? (
        <input type="hidden" name="is_student" value={account.isStudent} />
      ) : (
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
      )}

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

      <VendorLocationFields area={v.locationArea} details={v.locationDetails} />

      {/* THE NUMBER THE ACCOUNT ALREADY HAS, and it can be changed. It becomes
          how the store signs in, so it is ALWAYS confirmed with a code —
          including when it is left exactly as it was. A customer's profile
          number was typed at sign-up and never proven, and a credential that
          rests on an unverified field is not a credential. A changed number
          replaces the one on the account, after its own code. */}
      <Field
        label="Phone number"
        hint={
          account?.phone
            ? 'Your account’s number. Change it if the store uses another — either way we text it a code, because it becomes how your store signs in.'
            : 'This is how you sign in, and how we reach you about orders.'
        }
      >
        <Input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          inputMode="tel"
          placeholder="020 123 4567"
          defaultValue={v.phoneRaw ?? account?.phone ?? ''}
        />
      </Field>

      <PayoutFields values={v} />

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
 * How long before "Send a new code" comes back.
 *
 * SIXTY, NOT FORTY-FIVE. The email flow uses 45 because that is comfortably
 * over the project's minimum interval between EMAILS. Supabase's default
 * minimum interval between SMS messages is sixty seconds, and a button that
 * re-enables at 45 only to be refused by the provider is worse than one that
 * waits — the vendor reads the refusal as the flow being broken again. The
 * action still surfaces a 429 if a project is configured stricter than this.
 */
const RESEND_COOLDOWN_SECONDS = 60;

/** Seconds left before another code may be requested. */
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

/**
 * The code screen.
 *
 * Separated out so it can announce itself — focus on the input and a
 * `role="status"` line naming the number — because the whole failure this form
 * is recovering from was a step change nobody could see.
 *
 * The number being verified rides in a hidden field as E.164, so the code is
 * checked against the number it was SENT to rather than against a fresh reading
 * of whatever is in the details form.
 */
function CodeStep({
  values,
  phone,
  message,
  messageIsError,
  submit,
  verifying,
  resend,
  resending,
  sentAt,
  resubmitting,
  onBack,
}) {
  const input = useRef(null);
  const remaining = useCooldown(sentAt);
  const busy = verifying || resending;

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <div className="space-y-4">
      <form action={submit} className="space-y-4">
        <Carried values={values} phone={phone} />

        <div className="rounded-card bg-brand-50 p-3.5" role="status">
          <p className="text-sm leading-relaxed">
            We sent a 6-digit code to {phone ?? values.phoneRaw}.
          </p>
        </div>

        <Field label="Verification code">
          <OtpInput ref={input} disabled={busy} />
        </Field>

        <Button type="submit" size="lg" block disabled={busy}>
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
      </form>

      {/* A SEPARATE FORM, not a second button in the one above. Two submits in
          one form race each other for the same pending state, and the browser
          would post the half-typed code along with the resend. */}
      <form action={resend}>
        <Carried values={values} phone={phone} />
        <div className="text-center">
          <button
            type="submit"
            disabled={busy || remaining > 0}
            className="text-brand-700 press-sm disabled:text-faint text-sm font-semibold underline-offset-4 hover:underline disabled:no-underline"
          >
            {resending
              ? 'Sending…'
              : remaining > 0
                ? `Resend code in ${remaining}s`
                : 'Resend code'}
          </button>
        </div>
      </form>

      {message ? (
        messageIsError ? (
          <ErrorNote>{message}</ErrorNote>
        ) : (
          <p role="status" className="text-muted text-center text-sm leading-relaxed">
            {message}
          </p>
        )
      ) : null}

      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className="text-muted hover:text-ink block w-full text-center text-sm font-medium underline underline-offset-4 disabled:opacity-55"
      >
        Change my details or number
      </button>
    </div>
  );
}

/** Everything both forms on the code screen have to post back. */
function Carried({ values, phone }) {
  return (
    <>
      <input type="hidden" name="applicant_name" value={values.applicantName ?? ''} />
      <input type="hidden" name="store_name" value={values.storeName ?? ''} />
      <input type="hidden" name="is_student" value={values.isStudent ?? ''} />
      <input type="hidden" name="description" value={values.description ?? ''} />
      <input type="hidden" name="category_id" value={values.categoryId ?? ''} />
      <input type="hidden" name="location_area" value={values.locationArea ?? ''} />
      <input type="hidden" name="location_details" value={values.locationDetails ?? ''} />
      <input type="hidden" name="phone" value={values.phoneRaw ?? ''} />
      {/* E.164, and the one the code was sent to. */}
      <input type="hidden" name="verified_phone" value={phone ?? ''} />
      {/* WHICH REQUEST SENT IT. A phone change and a sign-in code are checked
          by different Supabase calls, and the answer has to match the ask. */}
      <input type="hidden" name="otp_type" value={values.otpType ?? 'sms'} />
      {/* WHERE THE STORE IS PAID, saved once the number is proven. */}
      <input type="hidden" name="momo_network" value={values.momoNetwork ?? ''} />
      <input type="hidden" name="momo_account_name" value={values.momoAccountName ?? ''} />
      <input
        type="hidden"
        name="momo_use_signin_phone"
        value={values.momoUseSignInPhone ? 'on' : ''}
      />
      <input type="hidden" name="momo_number" value={values.momoNumber ?? ''} />
    </>
  );
}

/**
 * Where the store is paid. Required.
 *
 * THE SAME NUMBER, IF IT IS THE SAME NUMBER. Most stores are paid on the phone
 * they sign in with, so one tick uses it — the number the SMS code is about to
 * prove, not a second copy typed here. Unticked, a separate MoMo number is
 * required. The name on the account is required either way: it is what the
 * network checks a payment against.
 */
function PayoutFields({ values }) {
  const [sameNumber, setSameNumber] = useState(Boolean(values.momoUseSignInPhone));

  return (
    <fieldset className="border-line space-y-4 border-t pt-4">
      <legend className="float-left mb-1 w-full font-semibold">Getting paid</legend>
      <p className="text-muted clear-both text-sm leading-relaxed">
        The mobile money account your share of each order is paid into.
      </p>

      <Field label="Mobile money network">
        <Select name="momo_network" required defaultValue={values.momoNetwork ?? ''}>
          <option value="" disabled>
            Choose a network
          </option>
          <option value="MTN">MTN Mobile Money</option>
          <option value="VODAFONE">Telecel Cash</option>
          <option value="AIRTELTIGO">AirtelTigo Money</option>
        </Select>
      </Field>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="momo_use_signin_phone"
          checked={sameNumber}
          onChange={(event) => setSameNumber(event.target.checked)}
          className="accent-brand-500 mt-0.5 size-4 shrink-0"
        />
        <span className="text-sm leading-relaxed">
          Use my Campus Dash/SMS phone number for MoMo payouts
        </span>
      </label>

      {sameNumber ? null : (
        <Field label="Mobile money number">
          <Input
            name="momo_number"
            type="tel"
            required
            inputMode="tel"
            autoComplete="off"
            placeholder="055 123 4567"
            defaultValue={values.momoNumber ?? ''}
          />
        </Field>
      )}

      <Field label="Name on the mobile money account" hint="Exactly as the network has it.">
        <Input name="momo_account_name" required defaultValue={values.momoAccountName ?? ''} />
      </Field>
    </fieldset>
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
