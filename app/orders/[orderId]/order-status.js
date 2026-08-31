'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { payOrderAction, refreshOrderAction } from '@/app/order/actions';
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

  const waiting = order.stage === 'AWAITING_VENDOR';
  const processing = order.stage === 'PAYMENT_PROCESSING';
  const cooking = ['PAID_AWAITING_KITCHEN', 'PREPARING'].includes(order.stage);

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
