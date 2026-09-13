'use client';

import { useActionState } from 'react';
import { markReadyAction } from '@/app/vendor/actions';
import { Button, CodeDisplay, ErrorNote, SuccessNote, Callout } from '@/app/ui';

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
 */
export default function OrderActions({ order, vendorId, handoffCode }) {
  const [ready, readyAction, marking] = useActionState(markReadyAction, {});

  const collector =
    order.fulfilment_type === 'PICKUP'
      ? (order.customer_first_name ?? 'The customer')
      : (order.partner_name ?? 'The Partner');

  const handedToPartner = order.order_status === 'READY' && order.delivery_status === 'PICKED_UP';
  const waitingForPartner =
    order.order_status === 'READY' && !order.handoff_code_available && !handedToPartner;

  return (
    <div className="space-y-3">
      {order.bucket === 'NEW' ? (
        <form action={readyAction}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <Button type="submit" size="lg" block disabled={marking} className="h-14 text-lg">
            {marking ? 'Marking ready…' : 'Ready for pickup'}
          </Button>
          <p className="text-muted mt-2.5 text-center text-sm leading-relaxed">
            {order.fulfilment_type === 'DELIVERY'
              ? 'The Partner is told straight away. A code appears here to read out when they arrive.'
              : 'The customer is told straight away. A code appears here to read out when they arrive.'}
          </p>
        </form>
      ) : null}

      {/* THE HANDOFF. The store HOLDS the code and READS IT OUT; whoever is
          taking the food types it into their own app. Whoever holds the secret
          must not also be the one confirming, or the code proves nothing — so
          this is a display, never a form. */}
      {order.order_status === 'READY' && order.handoff_code_available ? (
        handoffCode ? (
          <CodeDisplay
            label={`${collector} is collecting`}
            hint="Read this out. Hand the food over once they have entered it."
            code={handoffCode}
          />
        ) : (
          <Callout tone="warn">
            The code could not be loaded. Pull down or reload this page to try again.
          </Callout>
        )
      ) : null}

      {waitingForPartner ? (
        <Callout tone="neutral">
          Ready and waiting for a Partner. Nothing for you to do until they arrive. The code shows
          here when they do.
        </Callout>
      ) : null}

      {handedToPartner ? (
        <Callout tone="good">
          Handed to the Partner. Nothing more for you to do on this order.
        </Callout>
      ) : null}

      {order.order_status === 'COMPLETED' ? (
        <Callout tone="good">
          {order.fulfilment_type === 'PICKUP' ? 'Collected' : 'Delivered'}. This order is complete.
        </Callout>
      ) : null}

      {ready.message ? (
        ready.ok ? (
          <SuccessNote>{ready.message}</SuccessNote>
        ) : (
          <ErrorNote>{ready.message}</ErrorNote>
        )
      ) : null}
    </div>
  );
}
