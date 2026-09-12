'use client';

import { useActionState } from 'react';
import { markReadyAction } from '@/app/vendor/actions';

/**
 * The store's buttons — and there is now only one.
 *
 * Orders arrive paid for, so there is nothing to accept, nothing to reject and
 * no separate "start preparing". Make it, press Ready, read the code out.
 *
 * Which control appears is decided from the order's current state, but that is
 * presentation, not permission: the database re-checks every transition and
 * refuses one that is no longer valid. If a colleague marked the same order
 * ready a second earlier, the button is still there and pressing it simply
 * says so.
 */
export default function OrderActions({ order, vendorId, handoffCode }) {
  const [ready, readyAction, marking] = useActionState(markReadyAction, {});

  const collectingParty =
    order.fulfilment_type === 'PICKUP'
      ? order.customer_first_name
        ? `${order.customer_first_name} is`
        : 'The customer is'
      : order.partner_name
        ? `${order.partner_name} is`
        : 'A Partner is';

  return (
    <div className="space-y-3">
      {order.bucket === 'NEW' ? (
        <form action={readyAction}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <BigButton disabled={marking}>{marking ? 'Marking…' : 'Ready for pickup'}</BigButton>
          <p className="text-muted mt-2 text-xs leading-relaxed">
            {order.fulfilment_type === 'DELIVERY'
              ? 'The Partner carrying this is told the moment you press it, and a code appears here for you to read out.'
              : 'The customer is told the moment you press it, and a code appears here for you to read out.'}
          </p>
        </form>
      ) : null}

      {/* THE HANDOFF. The store HOLDS the code and READS IT OUT; whoever is
          taking the food types it into their own app. Whoever holds the secret
          must not also be the one confirming, or the code proves nothing — so
          this is a display, never a form. */}
      {order.order_status === 'READY' && order.handoff_code_available ? (
        <div className="rounded-card bg-surface ring-line p-4 ring-1">
          <p className="text-sm font-medium">{collectingParty} collecting this order.</p>
          <p className="text-muted mt-1 text-xs leading-relaxed">
            Read this code out to them. They type it into their own app, and only then do you hand
            the food over.
          </p>
          {handoffCode ? (
            <p className="text-ink bg-surface-2 rounded-card mt-3 py-5 text-center text-4xl font-semibold tracking-[0.4em] tabular-nums">
              {handoffCode}
            </p>
          ) : (
            <p className="text-muted mt-3 text-sm">Refresh to load the code.</p>
          )}
        </div>
      ) : null}

      {order.order_status === 'READY' && !order.handoff_code_available ? (
        <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
          Ready and waiting for a Partner. Nothing for you to do: the order stays exactly as it is.
        </p>
      ) : null}

      {order.order_status === 'READY' && order.delivery_status === 'PICKED_UP' ? (
        <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
          Handed to the Partner. Nothing more for you to do on this order.
        </p>
      ) : null}

      {order.order_status === 'COMPLETED' ? (
        <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
          Collected and complete.
        </p>
      ) : null}

      {ready.message ? (
        <p
          role="status"
          className={`rounded-lg px-4 py-3 text-sm font-medium ${
            ready.ok ? 'bg-brand-50 text-brand-700' : 'bg-bad-bg text-bad'
          }`}
        >
          {ready.message}
        </p>
      ) : null}
    </div>
  );
}

/** Sized for a thumb on a phone propped next to a hot plate. */
function BigButton({ children, disabled }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="press bg-brand-700 hover:bg-brand-800 w-full rounded-lg py-4 text-base font-semibold text-white transition-colors disabled:opacity-60"
    >
      {children}
    </button>
  );
}
