'use client';

import { useActionState, useState } from 'react';
import {
  acceptOrderAction,
  rejectOrderAction,
  markPreparingAction,
  markReadyAction,
  completePickupAction,
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
  const [showReject, setShowReject] = useState(false);

  const hidden = (
    <>
      <input type="hidden" name="order_id" value={order.order_id} />
      <input type="hidden" name="vendor_id" value={vendorId} />
    </>
  );

  const result = [accept, reject, prepare, ready, pickup].find((state) => state.message);

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
            <form action={rejectAction} className="rounded-lg bg-white p-4 ring-1 ring-black/5">
              {hidden}
              <label className="block text-sm font-medium">
                Why are you rejecting it?
                <input
                  name="reason"
                  required
                  minLength={3}
                  placeholder="Out of jollof"
                  className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-base"
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
                  className="rounded-lg px-4 py-3 text-sm font-semibold"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setShowReject(true)}
              className="w-full rounded-lg bg-white py-3 text-base font-semibold text-red-700 ring-1 ring-red-200"
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
          <p className="rounded-lg bg-white px-4 py-4 text-sm ring-1 ring-black/5">
            Waiting for the customer to pay. <strong>Do not start cooking yet</strong> — you will be
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
        <p className="rounded-lg bg-white px-4 py-4 text-sm ring-1 ring-black/5">
          {order.partner_assigned
            ? 'A Partner is on the way to collect this. They will read you a 4-digit pickup code — check it before handing the food over.'
            : 'Looking for a Partner. Nothing for you to do.'}
        </p>
      ) : null}

      {result ? (
        <p
          role="status"
          className={`rounded-lg px-4 py-3 text-sm font-medium ${
            result.ok ? 'bg-brand-50 text-brand-700' : 'bg-red-50 text-red-700'
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
    accept: 'bg-brand-600 text-white',
    ready: 'bg-blue-700 text-white',
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
