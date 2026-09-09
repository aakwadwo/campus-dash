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
} from '@/app/order/actions';
import { formatPesewas } from '@/lib/util/money';
import { Callout, CodeDisplay, ErrorNote, Button, Field, Input, Select } from '@/app/ui';

/**
 * The live part of the order screen: the countdown while the vendor decides,
 * the pay button once they accept, and the wait while a charge settles.
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

  const [waitState, keepWaiting, waitingAgain] = useActionState(keepWaitingAction, {});
  const [collectState, collectInstead, collecting] = useActionState(collectInsteadAction, {});

  const waiting = order.stage === 'AWAITING_VENDOR';
  const processing = order.stage === 'PAYMENT_PROCESSING';
  const cooking = [
    'PAID_AWAITING_KITCHEN',
    'PREPARING',
    'SEARCHING_PARTNER',
    'PARTNER_ASSIGNED',
    'ON_THE_WAY',
  ].includes(order.stage);

  // Poll only while something is actually expected to change.
  useEffect(() => {
    if (!waiting && !processing && !cooking) return;

    const timer = setInterval(
      async () => {
        if (processing) await refreshOrderAction(order.order_id);
        router.refresh();
      },
      processing ? 2000 : 6000
    );

    return () => clearInterval(timer);
  }, [waiting, processing, cooking, order.order_id, router]);

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

  if (waiting) {
    return (
      <Callout tone="warn">
        <Countdown seconds={order.seconds_to_deadline} />
      </Callout>
    );
  }

  // THE CHOICE, between acceptance and payment. Both totals come from the
  // server, computed from this order's own price snapshot — the screen shows
  // what each option costs, it does not work it out.
  if (order.stage === 'CHOOSE_FULFILMENT') {
    return (
      <FulfilmentChoice
        order={order}
        options={fulfilmentOptions ?? []}
        locations={locations}
        action={choose}
        pending={choosing}
        state={chooseState}
      />
    );
  }

  if (order.stage === 'PAYMENT_REQUIRED' || order.stage === 'PAYMENT_FAILED') {
    // The provider needs an address and we have none. Ask for it here rather
    // than sending someone to a checkout that would turn them away.
    if (!haveEmail) {
      return (
        <form action={saveEmail} className="space-y-3">
          <input type="hidden" name="order_id" value={order.order_id} />
          <label className="block">
            <span className="text-sm font-medium">Email address</span>
            <input
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              defaultValue={email ?? ''}
              placeholder="you@example.com"
              className="rounded-input bg-surface border-line-strong focus:border-brand-600 mt-1 h-12 w-full border px-4 text-base outline-none"
            />
          </label>
          <p className="text-muted text-xs">
            The payment page needs it, and your receipt goes there. We do not send anything else to
            it.
          </p>
          <Button type="submit" size="lg" block disabled={savingEmail}>
            {savingEmail ? 'Saving…' : 'Save and continue'}
          </Button>
          {emailState.message && !emailState.ok ? (
            <ErrorNote>{emailState.message}</ErrorNote>
          ) : null}
        </form>
      );
    }

    return (
      <form action={pay}>
        <input type="hidden" name="order_id" value={order.order_id} />
        <Button type="submit" size="lg" block disabled={paying || leaving}>
          {paying || leaving ? 'Starting…' : `Pay ${formatPesewas(order.total_pesewas)}`}
        </Button>
        {payState.message && !payState.ok ? (
          <ErrorNote className="mt-3">{payState.message}</ErrorNote>
        ) : null}
        <p className="text-muted mt-2 text-center text-xs">
          You will be taken to the payment page to finish.
        </p>
      </form>
    );
  }

  if (processing) {
    return (
      <Callout tone="warn">
        <p className="font-semibold">Confirming your payment…</p>
        <p className="mt-1">
          This usually takes a couple of seconds. Do not pay again. If it fails you will be told,
          and nothing will have been taken.
        </p>
      </Callout>
    );
  }

  // The COLLECTION code, for an order the customer is picking up themselves.
  // A different code from the delivery one, held by a different person and
  // typed in by a different person — the vendor reads it off the customer's
  // screen. Shown once the order is paid and in the kitchen.
  if (order.pickup_code) {
    return (
      <div>
        <CodeDisplay
          label="Collection code"
          hint="Show this at the counter"
          code={order.pickup_code}
        />
        <p className="text-muted mt-3 text-sm leading-relaxed">
          {order.vendor_name} will ask for this before handing your order over. Do not share it with
          anybody else.
        </p>
      </div>
    );
  }

  // The delivery code is what proves the food reached the right person, so it
  // is shown as soon as a Partner is assigned and nowhere else.
  if (order.delivery_code) {
    return (
      <div>
        <CodeDisplay
          label="Delivery code"
          hint="Give this to the Partner"
          code={order.delivery_code}
        />
        {order.partner_name ? (
          <p className="text-muted mt-3 text-sm leading-relaxed">
            {order.partner_name} is bringing your order.{' '}
            {order.partner_phone ? (
              <a
                href={`tel:${order.partner_phone}`}
                className="text-brand-700 font-semibold underline-offset-4 hover:underline"
              >
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
          <Button type="submit" size="lg" block disabled={waitingAgain}>
            {waitingAgain ? 'Looking…' : 'Keep looking for a Partner'}
          </Button>
        </form>
        <form action={collectInstead}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <Button type="submit" variant="secondary" size="lg" block disabled={collecting}>
            {collecting ? 'Updating…' : 'I will collect it myself'}
          </Button>
        </form>
        <p className="text-muted text-center text-xs">
          Collecting it yourself does not automatically refund the delivery fee. Contact support and
          we will sort it out.
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
 * Pickup or delivery, asked at the moment it can actually be answered.
 *
 * Both prices are the SERVER'S. `fulfilment_options` returns a row per choice
 * with the total that choice would produce, computed from this order's own
 * snapshot — so what is shown here is exactly what the next screen charges.
 */
function FulfilmentChoice({ order, options, locations, action, pending, state }) {
  const [choice, setChoice] = useState('DELIVERY');

  const priceFor = (type) => options.find((o) => o.fulfilment_type === type) ?? null;
  const delivery = priceFor('DELIVERY');
  const pickup = priceFor('PICKUP');

  return (
    <form action={action} className="space-y-4 text-left">
      <input type="hidden" name="order_id" value={order.order_id} />
      <input type="hidden" name="fulfilment_type" value={choice} />

      <div role="radiogroup" aria-label="How do you want it?" className="space-y-2.5">
        <Option
          checked={choice === 'DELIVERY'}
          onChange={() => setChoice('DELIVERY')}
          title="Have a Partner bring it"
          detail={
            delivery
              ? `${formatPesewas(delivery.delivery_fee_pesewas)} delivery fee`
              : 'A student Partner collects it and brings it to you'
          }
          total={delivery ? formatPesewas(delivery.total_pesewas) : null}
        />
        <Option
          checked={choice === 'PICKUP'}
          onChange={() => setChoice('PICKUP')}
          title="Collect it myself"
          detail={`No delivery fee. Walk to ${order.vendor_name}.`}
          total={pickup ? formatPesewas(pickup.total_pesewas) : null}
        />
      </div>

      {choice === 'DELIVERY' ? (
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

      <Button type="submit" size="lg" block disabled={pending}>
        {pending ? 'Saving…' : 'Confirm and continue to payment'}
      </Button>
      {state?.message && !state.ok ? <ErrorNote>{state.message}</ErrorNote> : null}
    </form>
  );
}

function Option({ checked, onChange, title, detail, total }) {
  return (
    <label
      className={`press rounded-card flex cursor-pointer items-start gap-3 border p-4 transition-colors ${
        checked ? 'border-brand-600 bg-brand-50' : 'border-line-strong bg-surface'
      }`}
    >
      <input
        type="radio"
        name="fulfilment_choice"
        checked={checked}
        onChange={onChange}
        className="accent-brand-500 mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="text-muted mt-0.5 block text-sm leading-relaxed">{detail}</span>
      </span>
      {total ? <span className="shrink-0 font-semibold tabular-nums">{total}</span> : null}
    </label>
  );
}

/** The vendor's answer window, counting down from the server's number. */
function Countdown({ seconds }) {
  const [left, setLeft] = useState(seconds ?? 0);

  useEffect(() => {
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p className="text-sm">
      {left > 0 ? (
        <>
          <span className="font-semibold tabular-nums">{left}s</span> left for the vendor to answer.
        </>
      ) : (
        <span className="font-semibold">Time is up. Checking with the vendor…</span>
      )}
    </p>
  );
}
