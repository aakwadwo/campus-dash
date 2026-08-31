'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  payOrderAction,
  refreshOrderAction,
  keepWaitingAction,
  collectInsteadAction,
} from '@/app/order/actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * The live part of the order screen: the countdown while the vendor decides,
 * the pay button once they accept, and the wait while a charge settles.
 *
 * The customer can start a payment. They cannot mark one paid — that only ever
 * happens when a verified provider event reaches the server.
 */
export default function OrderStatus({ order }) {
  const router = useRouter();
  const [payState, pay, paying] = useActionState(payOrderAction, {});

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

  if (waiting) {
    return (
      <div className="rounded-lg bg-amber-50 px-4 py-4">
        <Countdown seconds={order.seconds_to_deadline} />
      </div>
    );
  }

  if (order.stage === 'PAYMENT_REQUIRED' || order.stage === 'PAYMENT_FAILED') {
    return (
      <form action={pay}>
        <input type="hidden" name="order_id" value={order.order_id} />
        <button
          type="submit"
          disabled={paying}
          className="bg-brand-600 w-full rounded-lg py-4 text-base font-semibold text-white disabled:opacity-60"
        >
          {paying ? 'Starting…' : `Pay ${formatPesewas(order.total_pesewas)}`}
        </button>
        {payState.message && !payState.ok ? (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {payState.message}
          </p>
        ) : null}
        <p className="text-muted mt-2 text-center text-xs">
          Paying with the development provider. No real money moves.
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
      <div className="bg-brand-600 rounded-lg px-4 py-4 text-white">
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
            className="bg-brand-600 w-full rounded-lg py-3.5 text-base font-semibold text-white disabled:opacity-60"
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
