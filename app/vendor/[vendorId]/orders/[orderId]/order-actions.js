'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { markReadyAction } from '@/app/vendor/actions';
import { Button, CodeDisplay, ErrorNote, SuccessNote, Callout, Completion } from '@/app/ui';
import { useStatusWatch } from '@/app/use-status-watch';

/**
 * How often a waiting order screen asks whether the handoff has happened.
 *
 * Short on purpose, and only ever while somebody is standing at the counter:
 * the check is four fields from one indexed row, and a customer who has typed
 * the code in should not watch the store's screen still showing it.
 */
const HANDOFF_WATCH_MS = 2500;

/** How long "Collected" stays on screen before the board comes back. */
const COLLECTED_RETURN_MS = 2200;

/** What the screen was drawn from, in the shape the status endpoint answers. */
function statusSignature(status) {
  return [
    status.order_status,
    status.delivery_status,
    status.payment_status,
    Boolean(status.handoff_code_available),
  ].join('|');
}

/**
 * The store's buttons — and there is now only one.
 *
 * Orders arrive paid for, so there is nothing to accept, nothing to reject and
 * no separate "start preparing". Make it, press Ready, read the code out.
 *
 * Which control appears is decided from the order's current state, but that is
 * presentation, not permission: the database re-checks every transition and
 * refuses one that is no longer valid. If the same order was marked ready a
 * second earlier on another phone, the button is still there and pressing it
 * simply says so.
 *
 * WHILE THE ORDER IS AT THE COUNTER this screen watches it. The code is read out
 * and then the store waits for somebody else to act on their own phone; without
 * a watch the code stayed up after the customer had collected, until somebody
 * navigated away. Collection is shown only once the SERVER reports it — never
 * optimistically — and the board comes back on its own.
 */
export default function OrderActions({ order, vendorId, handoffCode }) {
  const router = useRouter();
  const [ready, readyAction, marking] = useActionState(markReadyAction, {});
  // Set from the status endpoint, i.e. from the database: the handoff happened.
  const [collected, setCollected] = useState(false);

  const collector =
    order.fulfilment_type === 'PICKUP'
      ? (order.customer_first_name ?? 'The customer')
      : (order.partner_name ?? 'The Partner');

  const handedToPartner = order.order_status === 'READY' && order.delivery_status === 'PICKED_UP';
  const waitingForPartner =
    order.order_status === 'READY' && !order.handoff_code_available && !handedToPartner;
  const completed = collected || order.order_status === 'COMPLETED';

  // Waiting on the other side of the counter: a code to be typed in, or a
  // Partner who has not arrived yet (whose arrival is what makes the code show).
  const atCounter = order.order_status === 'READY' && !handedToPartner;

  useStatusWatch({
    url: `/api/vendor/orders/${order.order_id}/status`,
    enabled: atCounter && !collected,
    initial: statusSignature(order),
    signatureOf: statusSignature,
    intervalMs: HANDOFF_WATCH_MS,
    onChange: (status) => {
      if (status.order_status === 'COMPLETED') setCollected(true);
      // Anything that moved — collected, a Partner arriving, a cancellation —
      // is drawn from the server, once.
      router.refresh();
    },
  });

  // Back to the board once the handoff is confirmed. Only when THIS screen saw
  // it happen: opening an order that finished yesterday stays where it is.
  useEffect(() => {
    if (!collected) return undefined;
    const timer = setTimeout(() => router.replace(`/vendor/${vendorId}`), COLLECTED_RETURN_MS);
    return () => clearTimeout(timer);
  }, [collected, router, vendorId]);

  const handoffLabel = order.fulfilment_type === 'PICKUP' ? 'Collected' : 'Delivered';

  return (
    <div className="space-y-3">
      {order.bucket === 'NEW' && !completed ? (
        <form action={readyAction}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <Button type="submit" size="lg" block pending={marking} className="h-14 text-lg">
            {marking ? 'Marking ready…' : 'Ready for pickup'}
          </Button>
          <p className="text-muted mt-2.5 text-center text-sm">
            {order.fulfilment_type === 'DELIVERY'
              ? 'The Partner is told. The code shows here when they arrive.'
              : 'The customer is told. The code shows here when they arrive.'}
          </p>
        </form>
      ) : null}

      {/* THE HANDOFF. The store HOLDS the code and READS IT OUT; whoever is
          taking the food types it into their own app. Whoever holds the secret
          must not also be the one confirming, or the code proves nothing — so
          this is a display, never a form. */}
      {order.order_status === 'READY' && order.handoff_code_available && !completed ? (
        handoffCode ? (
          <CodeDisplay
            label={`${collector} is collecting`}
            hint="Read this out. Hand over once they have entered it."
            code={handoffCode}
          />
        ) : (
          <Callout tone="warn">
            The code could not be loaded. Pull down or reload this page to try again.
          </Callout>
        )
      ) : null}

      {waitingForPartner && !completed ? (
        <Callout tone="neutral">
          Waiting for a Partner. The code shows here when they arrive.
        </Callout>
      ) : null}

      {handedToPartner ? (
        <Callout tone="good">Handed to the Partner. Nothing more to do.</Callout>
      ) : null}

      {completed ? (
        <div className="bg-good-bg rounded-card py-6">
          <Completion title={handoffLabel}>
            {collected ? 'Taking you back to your orders.' : 'This order is complete.'}
          </Completion>
        </div>
      ) : null}

      {/* The code or the waiting line already says what happens next; the note
          is for a refusal, or a success with nothing else on screen to show it. */}
      {ready.message && !completed ? (
        ready.ok ? (
          atCounter ? null : (
            <SuccessNote>{ready.message}</SuccessNote>
          )
        ) : (
          <ErrorNote>{ready.message}</ErrorNote>
        )
      ) : null}
    </div>
  );
}
