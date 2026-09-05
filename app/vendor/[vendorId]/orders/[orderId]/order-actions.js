'use client';

import { useActionState, useState } from 'react';
import {
  acceptOrderAction,
  rejectOrderAction,
  markPreparingAction,
  markReadyAction,
  completePickupAction,
  confirmPartnerPickupAction,
} from '@/app/vendor/actions';

/**
 * The only buttons a vendor needs, and only the ones that are legal right now.
 *
 * Which button appears is decided from the order's current state, but that is
 * presentation, not permission: the database re-checks every transition and
 * refuses one that is no longer valid. If a colleague accepted the same order a
 * second earlier, the button is still there and pressing it simply says so.
 */
export default function OrderActions({ order, vendorId }) {
  const [accept, acceptAction, accepting] = useActionState(acceptOrderAction, {});
  const [reject, rejectAction, rejecting] = useActionState(rejectOrderAction, {});
  const [prepare, prepareAction, preparing] = useActionState(markPreparingAction, {});
  const [ready, readyAction, marking] = useActionState(markReadyAction, {});
  const [pickup, pickupAction, completing] = useActionState(completePickupAction, {});
  const [handoff, handoffAction, handingOver] = useActionState(confirmPartnerPickupAction, {});
  const [showReject, setShowReject] = useState(false);

  const hidden = (
    <>
      <input type="hidden" name="order_id" value={order.order_id} />
      <input type="hidden" name="vendor_id" value={vendorId} />
    </>
  );

  const result = [accept, reject, prepare, ready, pickup, handoff].find((state) => state.message);

  return (
    <div className="space-y-3">
      {order.order_status === 'SUBMITTED' ? (
        <>
          <form action={acceptAction}>
            {hidden}
            <BigButton disabled={accepting} tone="accept">
              {accepting ? 'Accepting…' : 'Accept order'}
            </BigButton>
          </form>

          {showReject ? (
            <form action={rejectAction} className="rounded-card bg-surface ring-line p-4 ring-1">
              {hidden}
              <label className="block text-sm font-medium">
                Why are you rejecting it?
                <input
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Out of jollof"
                  className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
                />
              </label>
              <p className="text-muted mt-2 text-xs">
                The customer is told straight away, and is not charged.
              </p>
              <div className="mt-3 flex gap-2">
                <BigButton disabled={rejecting} tone="reject">
                  {rejecting ? 'Rejecting…' : 'Confirm reject'}
                </BigButton>
                <button
                  type="button"
                  onClick={() => setShowReject(false)}
                  className="press rounded-full px-4 py-3 text-sm font-semibold transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setShowReject(true)}
              className="press bg-surface text-bad ring-bad/30 w-full rounded-full py-3 text-base font-semibold ring-1 transition-colors"
            >
              Reject order
            </button>
          )}
        </>
      ) : null}

      {order.order_status === 'ACCEPTED' ? (
        order.payment_status === 'PAID' ? (
          <form action={prepareAction}>
            {hidden}
            <BigButton disabled={preparing} tone="accept">
              {preparing ? 'Starting…' : 'Start preparing'}
            </BigButton>
          </form>
        ) : (
          <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
            Waiting for the customer to pay. <strong>Do not start cooking yet.</strong> You will be
            able to start as soon as the payment lands.
          </p>
        )
      ) : null}

      {order.order_status === 'PREPARING' ? (
        <form action={readyAction}>
          {hidden}
          <BigButton disabled={marking} tone="ready">
            {marking ? 'Marking…' : 'Food is ready'}
          </BigButton>
          <p className="text-muted mt-2 text-xs">
            {order.fulfilment_type === 'DELIVERY'
              ? 'A Partner is only sent once you mark this ready, so nobody waits at your counter.'
              : 'The customer will be told to come and collect.'}
          </p>
        </form>
      ) : null}

      {order.order_status === 'READY' && order.fulfilment_type === 'PICKUP' ? (
        <form action={pickupAction}>
          {hidden}
          <BigButton disabled={completing} tone="ready">
            {completing ? 'Completing…' : 'Customer collected it'}
          </BigButton>
        </form>
      ) : null}

      {order.order_status === 'READY' && order.fulfilment_type === 'DELIVERY' ? (
        order.delivery_status === 'ASSIGNED' ? (
          <form action={handoffAction} className="rounded-card bg-surface ring-line p-4 ring-1">
            {hidden}
            <p className="text-sm font-medium">A Partner is here to collect this order.</p>
            <p className="text-muted mt-1 text-xs">
              Ask them for their 4-digit pickup code and type it in. Do not hand over the food until
              the code is accepted.
            </p>
            <input
              name="pickup_code"
              inputMode="numeric"
              required
              pattern="\d{4}"
              maxLength={4}
              placeholder="1234"
              className="border-line-strong mt-3 w-full rounded border px-3 py-3 text-center text-2xl tracking-[0.4em] tabular-nums"
            />
            <BigButton disabled={handingOver} tone="ready">
              {handingOver ? 'Checking…' : 'Confirm pickup'}
            </BigButton>
          </form>
        ) : order.delivery_status === 'PICKED_UP' ? (
          <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
            Handed to the Partner. Nothing more for you to do on this order.
          </p>
        ) : (
          <p className="rounded-card bg-surface ring-line px-4 py-4 text-sm ring-1">
            Looking for a Partner. Nothing for you to do: the order stays exactly as it is.
          </p>
        )
      ) : null}

      {result ? (
        <p
          role="status"
          className={`rounded-lg px-4 py-3 text-sm font-medium ${
            result.ok ? 'bg-brand-50 text-brand-700' : 'bg-bad-bg text-bad'
          }`}
        >
          {result.message}
        </p>
      ) : null}
    </div>
  );
}

/** Sized for a thumb on a phone propped next to a hot plate. */
function BigButton({ children, disabled, tone }) {
  const tones = {
    accept: 'bg-brand-500 text-ink',
    ready: 'bg-brand-500 text-ink',
    reject: 'bg-red-700 text-white',
  };
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`w-full rounded-lg py-4 text-base font-semibold disabled:opacity-60 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}
