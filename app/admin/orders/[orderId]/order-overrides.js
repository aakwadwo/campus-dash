'use client';

import { useActionState } from 'react';
import {
  cancelOrderAction,
  completeOrderAction,
  reassignDeliveryAction,
  markRefundedAction,
  resolveDisputeAction,
} from '../../actions';
import { Field, ReasonField, Button, ActionResult } from '../../ui';

/**
 * Administrative overrides.
 *
 * Only the ones legal for this order's current state are offered, but that is
 * presentation: each function re-checks state in the database, and the audit
 * table refuses a change with no stated reason.
 */
export default function OrderOverrides({ order }) {
  const [cancel, cancelAction, cancelling] = useActionState(cancelOrderAction, {});
  const [complete, completeAction, completing] = useActionState(completeOrderAction, {});
  const [reassign, reassignAction, reassigning] = useActionState(reassignDeliveryAction, {});
  const [refund, refundAction, refunding] = useActionState(markRefundedAction, {});
  const [dispute, disputeAction, resolving] = useActionState(resolveDisputeAction, {});

  const hidden = <input type="hidden" name="order_id" value={order.id} />;
  const terminal = [
    'COMPLETED',
    'CANCELLED',
    'CANCELLED_BY_VENDOR',
    'REJECTED',
    'EXPIRED',
  ].includes(order.order_status);
  const result = [cancel, complete, reassign, refund, dispute].find((s) => s.message);

  return (
    <div className="space-y-6">
      {order.disputed_at && !order.dispute_resolved_at ? (
        <form action={disputeAction} className="grid gap-3 sm:grid-cols-3">
          <p className="text-muted text-sm sm:col-span-3">
            Customer reported: “{order.dispute_reason}”
          </p>
          {hidden}
          <ReasonField placeholder="Spoke to both parties; food was delivered" />
          <Field label="Notes (optional)" name="notes" />
          <div className="sm:col-span-3">
            <Button disabled={resolving}>{resolving ? 'Closing…' : 'Close dispute'}</Button>
          </div>
        </form>
      ) : null}

      {order.fulfilment_type === 'DELIVERY' &&
      ['ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER', 'FAILED_CUSTOMER_ABSENT'].includes(
        order.delivery_status
      ) ? (
        <form action={reassignAction} className="grid gap-3 sm:grid-cols-2">
          {hidden}
          <ReasonField placeholder="Partner unreachable for 20 minutes" />
          <div className="flex items-end">
            <Button variant="secondary" disabled={reassigning}>
              {reassigning ? 'Reassigning…' : 'Take the Partner off this delivery'}
            </Button>
          </div>
          <p className="text-muted text-xs sm:col-span-2">
            Rotates the pickup code and returns the order to the pool. The vendor does nothing.
          </p>
        </form>
      ) : null}

      {!terminal ? (
        <>
          <form action={completeAction} className="grid gap-3 sm:grid-cols-2">
            {hidden}
            <ReasonField placeholder="Customer confirmed delivery by phone" />
            <div className="flex items-end">
              <Button variant="secondary" disabled={completing}>
                {completing ? 'Completing…' : 'Force complete'}
              </Button>
            </div>
          </form>

          <form action={cancelAction} className="grid gap-3 sm:grid-cols-2">
            {hidden}
            <ReasonField placeholder="Vendor closed unexpectedly" />
            <div className="flex items-end">
              <Button variant="danger" disabled={cancelling}>
                {cancelling ? 'Cancelling…' : 'Cancel order'}
              </Button>
            </div>
          </form>
        </>
      ) : null}

      {order.payment_status === 'REFUND_PENDING' ? (
        <form action={refundAction} className="grid gap-3 sm:grid-cols-2">
          {hidden}
          <ReasonField placeholder="Refund confirmed with the provider" />
          <div className="flex items-end">
            <Button variant="secondary" disabled={refunding}>
              {refunding ? 'Marking…' : 'Mark refunded'}
            </Button>
          </div>
          <p className="text-muted text-xs sm:col-span-2">
            Records that the refund happened. It does not move money: the provider does that, and
            which provider is still an open question.
          </p>
        </form>
      ) : null}

      <ActionResult state={result ?? {}} />
    </div>
  );
}
