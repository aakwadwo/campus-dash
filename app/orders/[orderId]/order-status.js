'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  payOrderAction,
  refreshOrderAction,
  keepWaitingAction,
  collectInsteadAction,
  saveEmailAction,
  chooseFulfilmentAction,
  completePickupAction,
  abandonPaymentAction,
  abandonUnpaidOrderAction,
} from '@/app/order/actions';
import { formatPesewas } from '@/lib/util/money';
import {
  Callout,
  CodeDisplay,
  CodeInput,
  ErrorNote,
  SuccessNote,
  Button,
  Field,
  Input,
  Select,
  TEXT_LINK_CLASS,
} from '@/app/ui';

/**
 * The live part of the order screen: the pay button while it is unpaid, the
 * wait while a charge settles, and the code box at the counter.
 *
 * The customer can start a payment. They cannot mark one paid — that only ever
 * happens when a verified provider event reaches the server.
 */
export default function OrderStatus({
  order,
  email = null,
  pollMs = 6000,
  fulfilmentOptions = null,
  locations = [],
}) {
  const router = useRouter();
  const [payState, pay, paying] = useActionState(payOrderAction, {});
  const [emailState, saveEmail, savingEmail] = useActionState(saveEmailAction, {});
  const [chooseState, choose, choosing] = useActionState(chooseFulfilmentAction, {});
  const [pickupState, completePickup, completing] = useActionState(completePickupAction, {});

  const [waitState, keepWaiting, waitingAgain] = useActionState(keepWaitingAction, {});
  const [collectState, collectInstead, collecting] = useActionState(collectInsteadAction, {});
  const [abandonState, abandonPayment, abandoning] = useActionState(abandonPaymentAction, {});
  const [leaveState, leaveOrder, leavingOrder] = useActionState(abandonUnpaidOrderAction, {});

  const [changing, setChanging] = useState(false);

  const unpaid = order.stage === 'PAYMENT_REQUIRED' || order.stage === 'PAYMENT_FAILED';
  const processing = order.stage === 'PAYMENT_PROCESSING';
  // EVERY STAGE WHERE SOMEBODY ELSE IS ABOUT TO MOVE THIS ORDER. If a stage is
  // missing here the screen freezes on it: the timers in PartnerSearch keep
  // drawing a countdown, so it goes on LOOKING live while the server has moved
  // on. PREPARING_SEARCHING was missing, which is the longest stretch of a
  // Partner order — the whole wait while the food cooks and a Partner is found
  // — so a customer watched "Finding a Campus Dash Partner" count down for
  // minutes after somebody had already taken it.
  //
  // NO_PARTNER and CUSTOMER_ABSENT are absent deliberately: nothing moves in
  // either until a person acts, and in NO_PARTNER that person is the customer
  // reading this screen.
  const live = [
    'PAID_AWAITING_KITCHEN',
    'PREPARING',
    'PREPARING_SEARCHING',
    'PREPARING_PARTNER_ASSIGNED',
    'SEARCHING_PARTNER',
    'PARTNER_ASSIGNED',
    'ON_THE_WAY',
    'READY',
  ].includes(order.stage);

  // Poll only while something is actually expected to change.
  useEffect(() => {
    if (!processing && !live) return;

    const timer = setInterval(
      async () => {
        if (processing) await refreshOrderAction(order.order_id);
        router.refresh();
      },
      processing ? 2000 : pollMs
    );

    return () => clearInterval(timer);
  }, [processing, live, pollMs, order.order_id, router]);

  /**
   * The provider's checkout is on another origin, so getting there is a full
   * browser navigation rather than a client-side route change. Done in an
   * effect so React has committed the pending state first — the button stays
   * disabled while the page is on its way out.
   */
  useEffect(() => {
    if (payState.ok && payState.redirectUrl) {
      window.location.href = payState.redirectUrl;
    }
  }, [payState]);

  const leaving = Boolean(payState.ok && payState.redirectUrl);
  // A save this render has not yet been reflected in the server-rendered prop.
  const haveEmail = Boolean(email) || Boolean(emailState.ok);

  if (unpaid) {
    // The provider needs an address and we have none. Ask for it here rather
    // than sending someone to a checkout that would turn them away.
    if (!haveEmail) {
      return (
        <form action={saveEmail} className="space-y-3">
          <input type="hidden" name="order_id" value={order.order_id} />
          <Field
            label="Email address"
            hint="The payment page needs it, and your receipt goes there. We do not send anything else to it."
          >
            <Input
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              defaultValue={email ?? ''}
              placeholder="you@example.com"
            />
          </Field>
          <Button type="submit" size="lg" block pending={savingEmail}>
            {savingEmail ? 'Saving…' : 'Save and continue'}
          </Button>
          {emailState.message && !emailState.ok ? (
            <ErrorNote>{emailState.message}</ErrorNote>
          ) : null}
        </form>
      );
    }

    // CHANGING THE CHOICE, before any money moves. Tucked behind a link rather
    // than laid out as a form, because the customer already answered this at
    // the checkout and re-asking implies it did not take.
    if (changing) {
      return (
        <FulfilmentChoice
          order={order}
          options={fulfilmentOptions ?? []}
          locations={locations}
          action={choose}
          pending={choosing}
          state={chooseState}
          onCancel={() => setChanging(false)}
        />
      );
    }

    return (
      <div>
        <form action={pay}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <Button type="submit" size="lg" block pending={paying || leaving}>
            {paying || leaving ? 'Opening payment…' : `Pay ${formatPesewas(order.total_pesewas)}`}
          </Button>
          {payState.message && !payState.ok ? (
            <ErrorNote className="mt-3">{payState.message}</ErrorNote>
          ) : null}
        </form>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-xs">
          <span className="text-muted">
            {order.fulfilment_type === 'PICKUP'
              ? 'You are collecting this yourself.'
              : 'A Partner will bring this to you.'}
          </span>
          {order.order_type !== 'SCAN' ? (
            <button
              type="button"
              onClick={() => setChanging(true)}
              className={`${TEXT_LINK_CLASS} inline-flex min-h-11 items-center px-1`}
            >
              Change
            </button>
          ) : null}
        </div>
        {chooseState.message && chooseState.ok ? (
          <p className="text-good mt-2 text-center text-xs">{chooseState.message}</p>
        ) : null}

        <AbandonUnpaid
          orderId={order.order_id}
          action={leaveOrder}
          pending={leavingOrder}
          state={leaveState}
          disabled={paying || leaving}
        />
      </div>
    );
  }

  if (processing) {
    return (
      <div className="space-y-3">
        <Callout tone="warn">
          <p className="font-semibold">Confirming your payment…</p>
          <p className="mt-1">
            This usually takes a couple of seconds. Do not pay again. If it fails you will be told,
            and nothing will have been taken.
          </p>
        </Callout>

        {/* THE WAY OUT OF A CHARGE THAT NEVER CAME BACK. Without it this
            screen was a dead end: it polls for ever, tells the customer not to
            pay again, and offers nothing to press — the pg_cron sweep would
            free the order eventually, minutes later, with nobody told.
            WHETHER IT IS ACTUALLY STUCK IS THE SERVER'S CALL: the button is
            always here, and customer_abandon_stuck_payment() refuses while the
            payment is younger than the timeout, in a sentence written for the
            person reading it. */}
        <form action={abandonPayment}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <Button type="submit" variant="ghost" block pending={abandoning} className="text-muted">
            {abandoning ? 'Checking…' : 'This is taking too long'}
          </Button>
        </form>
        {abandonState.message ? (
          abandonState.ok ? (
            <SuccessNote>{abandonState.message}</SuccessNote>
          ) : (
            <ErrorNote>{abandonState.message}</ErrorNote>
          )
        ) : null}
      </div>
    );
  }

  // THE COLLECTION. The vendor reads four digits out; the customer types them
  // in here. The direction is deliberate and it is the same rule as the Partner
  // handoff: whoever holds the secret must not be the one who confirms, or the
  // code proves nothing. So there is no screen anywhere that shows a customer
  // their own collection code.
  //
  // Keyed on "nobody is bringing it" rather than on the fulfilment chosen at
  // the checkout, so a delivery the customer took over after nobody accepted it
  // ends the same way.
  if (order.stage === 'READY' && order.delivery_status === 'NONE') {
    return (
      <form action={completePickup} className="space-y-3">
        <input type="hidden" name="order_id" value={order.order_id} />
        <label htmlFor="pickup_code" className="block leading-relaxed">
          Your order is ready at <span className="font-semibold">{order.vendor_name}</span>. Ask
          them for the 4-digit code and enter it here to collect.
        </label>
        <CodeInput name="pickup_code" label="Code from the store" disabled={completing} />
        <Button type="submit" size="lg" block pending={completing}>
          {completing ? 'Checking…' : 'Confirm collection'}
        </Button>
        {pickupState.message ? (
          pickupState.ok ? (
            <SuccessNote>{pickupState.message}</SuccessNote>
          ) : (
            <ErrorNote>{pickupState.message}</ErrorNote>
          )
        ) : null}
      </form>
    );
  }

  // The delivery code is what proves the food reached the right person, so it
  // is shown as soon as a Partner is assigned and nowhere else.
  if (order.delivery_code) {
    return (
      <div>
        <CodeDisplay
          label="Your code"
          hint="Read this out to your Partner on arrival"
          code={order.delivery_code}
        />
        {order.partner_name ? (
          <p className="text-muted mt-3 text-sm leading-relaxed">
            {order.partner_name} is bringing your order.{' '}
            {order.partner_phone ? (
              <a href={`tel:${order.partner_phone}`} className={TEXT_LINK_CLASS}>
                Call them
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    );
  }

  // Nobody took the job. The food is made and paid for, so this is the
  // customer's decision — not something the system does to them.
  if (order.stage === 'NO_PARTNER') {
    return (
      <div className="space-y-2">
        <form action={keepWaiting}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <Button type="submit" size="lg" block pending={waitingAgain} disabled={collecting}>
            {waitingAgain ? 'Looking…' : 'Keep looking for a Partner'}
          </Button>
        </form>
        <form action={collectInstead}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <Button
            type="submit"
            variant="secondary"
            size="lg"
            block
            pending={collecting}
            disabled={waitingAgain}
          >
            {collecting ? 'Updating…' : 'I will collect it myself'}
          </Button>
        </form>
        <p className="text-muted text-center text-xs">
          Collecting it yourself does not automatically refund the GH₵5 fee. Contact support and we
          will sort it out.
        </p>
        {[waitState, collectState]
          .filter((s) => s.message && !s.ok)
          .map((s, i) => (
            <ErrorNote key={i}>{s.message}</ErrorNote>
          ))}
      </div>
    );
  }

  return null;
}

/**
 * Changing pickup or delivery, before any money moves.
 *
 * Both prices are the SERVER'S. `fulfilment_options` returns a row per choice
 * with the total that choice would produce, computed from this order's own
 * snapshot — so what is shown here is exactly what the pay button charges.
 */
function FulfilmentChoice({ order, options, locations, action, pending, state, onCancel }) {
  const [choice, setChoice] = useState(order.fulfilment_type ?? 'PICKUP');

  const priceFor = (type) => options.find((o) => o.fulfilment_type === type) ?? null;
  const delivery = priceFor('DELIVERY');
  const pickup = priceFor('PICKUP');
  const deliveryAvailable = delivery ? delivery.is_available !== false : true;

  return (
    <form action={action} className="space-y-4 text-left">
      <input type="hidden" name="order_id" value={order.order_id} />
      <input type="hidden" name="fulfilment_type" value={choice} />

      <div role="radiogroup" aria-label="How do you want it?" className="space-y-2.5">
        <Option
          checked={choice === 'PICKUP'}
          onChange={() => setChoice('PICKUP')}
          title="Collect it myself"
          detail={`Walk to ${order.vendor_name}. No extra fee.`}
          total={pickup ? formatPesewas(pickup.total_pesewas) : null}
        />
        <Option
          checked={choice === 'DELIVERY'}
          onChange={() => setChoice('DELIVERY')}
          disabled={!deliveryAvailable}
          title="Campus Dash Partner"
          detail={
            !deliveryAvailable
              ? 'No Partners are available right now.'
              : delivery
                ? `${formatPesewas(delivery.delivery_fee_pesewas)} — another student brings it to you`
                : 'Another student collects it and brings it to you'
          }
          total={deliveryAvailable && delivery ? formatPesewas(delivery.total_pesewas) : null}
        />
      </div>

      {choice === 'DELIVERY' && deliveryAvailable ? (
        <div className="space-y-3">
          <Field label="Where on campus?">
            <Select name="destination_location_id" required defaultValue="">
              <option value="" disabled>
                Choose a destination
              </option>
              {locations.map((location) => (
                <option key={location.location_id} value={location.location_id}>
                  {location.path}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Anything else?" hint="Optional.">
            <Input name="destination_note" placeholder="Call when you reach the gate" />
          </Field>
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" size="lg" className="flex-1" pending={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {state?.message && !state.ok ? <ErrorNote>{state.message}</ErrorNote> : null}
    </form>
  );
}

function Option({ checked, onChange, title, detail, total, disabled = false }) {
  return (
    <label
      className={`rounded-card flex items-start gap-3 border p-4 transition-colors ${
        disabled
          ? 'border-line bg-surface-2/60 cursor-not-allowed'
          : `press cursor-pointer ${
              checked ? 'border-brand-600 bg-brand-50' : 'border-line-strong bg-surface'
            }`
      }`}
    >
      <input
        type="radio"
        name="fulfilment_choice"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="accent-brand-500 mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold ${disabled ? 'text-muted' : ''}`}>{title}</span>
        <span className="text-muted mt-0.5 block text-sm leading-relaxed">{detail}</span>
      </span>
      {total ? <span className="shrink-0 font-semibold tabular-nums">{total}</span> : null}
    </label>
  );
}

/**
 * Leaving an order before paying for it.
 *
 * WORDED FOR WHAT IT IS: an UNPAID order, abandoned. It never appears once a
 * payment has succeeded, and the server refuses it then anyway
 * (customer_abandon_unpaid_order is guarded on the payment state). Two taps, the
 * second one saying what happens, because a tap that silently cancels
 * somebody's lunch is a tap they did not mean.
 */
function AbandonUnpaid({ orderId, action, pending, state, disabled }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="mt-6 text-center">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          className="text-muted hover:text-ink press-sm min-h-11 text-sm font-medium transition-colors disabled:opacity-55"
        >
          Cancel unpaid order
        </button>
      </div>
    );
  }

  return (
    <form action={action} className="border-line mt-6 border-t pt-5">
      <input type="hidden" name="order_id" value={orderId} />
      <p className="text-center text-sm">
        Cancel this order? Nothing has been charged, and the store has not seen it.
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          variant="secondary"
          className="flex-1"
          onClick={() => setConfirming(false)}
          disabled={pending}
        >
          Keep it
        </Button>
        <Button type="submit" variant="danger" className="flex-1" pending={pending}>
          {pending ? 'Cancelling…' : 'Cancel order'}
        </Button>
      </div>
      {state.message && !state.ok ? <ErrorNote className="mt-3">{state.message}</ErrorNote> : null}
    </form>
  );
}
