'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  payOrderAction,
  refreshOrderAction,
  keepWaitingAction,
  collectInsteadAction,
  saveEmailAction,
} from '@/app/order/actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * The live part of the order screen: the countdown while the vendor decides,
 * the pay button once they accept, and the wait while a charge settles.
 *
 * The customer can start a payment. They cannot mark one paid — that only ever
 * happens when a verified provider event reaches the server.
 */
export default function OrderStatus({ order, email = null, pollMs = 6000 }) {
  const router = useRouter();
  const [payState, pay, paying] = useActionState(payOrderAction, {});
  const [emailState, saveEmail, savingEmail] = useActionState(saveEmailAction, {});

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
      <div className="rounded-lg bg-amber-50 px-4 py-4">
        <Countdown seconds={order.seconds_to_deadline} />
      </div>
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
              className="focus:border-brand-600 focus:ring-brand-600/50 mt-1 w-full rounded-lg border border-black/15 bg-white px-3 py-2.5 text-base outline-none focus:ring-2"
            />
          </label>
          <p className="text-muted text-xs">
            The payment page needs it, and your receipt goes there. We do not send anything else to
            it.
          </p>
          <button
            type="submit"
            disabled={savingEmail}
            className="bg-brand-500 text-ink w-full rounded-lg py-3.5 text-base font-semibold disabled:opacity-60"
          >
            {savingEmail ? 'Saving…' : 'Save and continue'}
          </button>
          {emailState.message && !emailState.ok ? (
            <p role="alert" className="text-sm text-red-700">
              {emailState.message}
            </p>
          ) : null}
        </form>
      );
    }

    return (
      <form action={pay}>
        <input type="hidden" name="order_id" value={order.order_id} />
        <button
          type="submit"
          disabled={paying || leaving}
          className="bg-brand-500 text-ink w-full rounded-lg py-4 text-base font-semibold disabled:opacity-60"
        >
          {paying || leaving ? 'Starting…' : `Pay ${formatPesewas(order.total_pesewas)}`}
        </button>
        {payState.message && !payState.ok ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {payState.message}
          </p>
        ) : null}
        <p className="text-muted mt-2 text-center text-xs">
          You will be taken to the payment page to finish.
        </p>
      </form>
    );
  }

  if (processing) {
    return (
      <div className="rounded-lg bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">Confirming your payment…</p>
        <p className="mt-1">
          This usually takes a couple of seconds. Do not pay again — if it fails you will be told,
          and nothing will have been taken.
        </p>
      </div>
    );
  }

  // The delivery code is what proves the food reached the right person, so it
  // is shown as soon as a Partner is assigned and nowhere else.
  if (order.delivery_code) {
    return (
      <div className="bg-brand-500 text-ink rounded-lg px-4 py-4">
        <p className="text-xs font-semibold tracking-wide uppercase opacity-90">
          Give this to the Partner
        </p>
        <p className="mt-1 font-mono text-4xl font-bold tracking-[0.2em] tabular-nums">
          {order.delivery_code}
        </p>
        {order.partner_name ? (
          <p className="mt-2 text-sm opacity-90">
            {order.partner_name} is bringing your order.{' '}
            {order.partner_phone ? (
              <a href={`tel:${order.partner_phone}`} className="underline underline-offset-4">
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
          <button
            type="submit"
            disabled={waitingAgain}
            className="bg-brand-500 text-ink w-full rounded-lg py-3.5 text-base font-semibold disabled:opacity-60"
          >
            {waitingAgain ? 'Looking…' : 'Keep looking for a Partner'}
          </button>
        </form>
        <form action={collectInstead}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <button
            type="submit"
            disabled={collecting}
            className="w-full rounded-lg bg-white py-3.5 text-base font-semibold ring-1 ring-black/15 disabled:opacity-60"
          >
            {collecting ? 'Updating…' : 'I will collect it myself'}
          </button>
        </form>
        <p className="text-muted text-center text-xs">
          Collecting it yourself does not automatically refund the delivery fee — contact support
          and we will sort it out.
        </p>
        {[waitState, collectState]
          .filter((s) => s.message && !s.ok)
          .map((s, i) => (
            <p key={i} role="alert" className="text-sm text-red-700">
              {s.message}
            </p>
          ))}
      </div>
    );
  }

  return null;
}

/** The vendor's answer window, counting down from the server's number. */
function Countdown({ seconds }) {
  const [left, setLeft] = useState(seconds ?? 0);

  useEffect(() => {
    const timer = setInterval(() => setLeft((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <p className="text-sm text-amber-900">
      {left > 0 ? (
        <>
          <span className="font-semibold tabular-nums">{left}s</span> left for the vendor to answer.
        </>
      ) : (
        <span className="font-semibold">Time is up — checking with the vendor…</span>
      )}
    </p>
  );
}
