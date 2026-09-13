'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  cancelDeliveryAction,
  completeDeliveryAction,
  confirmPickupAction,
  reportAbsentAction,
  confirmAbsentAction,
} from '../actions';
import { Button, CodeInput, ErrorNote, SuccessNote, Callout, Field, Input } from '@/app/ui';

/**
 * What a Partner can do with the job in their hands.
 *
 * Before handoff they may cancel freely — no penalty in V1, the order simply
 * goes back to the pool with a fresh pickup code. After handoff they are
 * carrying food, so the only ways out are delivering it or the absence process.
 *
 * THE CODE BOX ONLY APPEARS ONCE THE FOOD IS MADE. Offers open at payment, so a
 * Partner routinely holds a job that is still cooking; a code box on screen then
 * would be an invitation to walk to a counter early and an attempt counter to
 * burn on nothing.
 */
export default function DeliveryActions({ delivery, isScan = false }) {
  const router = useRouter();
  const [cancelState, cancel, cancelling] = useActionState(cancelDeliveryAction, {});
  const [completeState, complete, completing] = useActionState(completeDeliveryAction, {});
  const [pickupState, confirmPickup, confirmingPickup] = useActionState(confirmPickupAction, {});
  const [reportState, report, reporting] = useActionState(reportAbsentAction, {});
  const [confirmState, confirmAbsent, confirming] = useActionState(confirmAbsentAction, {});
  const [showCancel, setShowCancel] = useState(false);

  const hidden = <input type="hidden" name="order_id" value={delivery.order_id} />;
  const carrying = delivery.delivery_status === 'PICKED_UP';
  const waitingForKitchen = !carrying && !isScan && !delivery.food_is_ready;

  // Nothing on this screen can change except the kitchen, so it is polled only
  // while that is what is being waited on.
  useEffect(() => {
    if (!waitingForKitchen) return;
    const timer = setInterval(() => router.refresh(), 10000);
    return () => clearInterval(timer);
  }, [waitingForKitchen, router]);

  const result = [completeState, pickupState, reportState, confirmState, cancelState].find(
    (s) => s.message
  );

  return (
    <div className="space-y-3">
      {/* THE PICKUP CODE, entered by the Partner. The vendor reads it out; the
          Partner types it in. A scan errand has no handover to prove, so it
          uses the redemption report instead — see ScanCollection. */}
      {waitingForKitchen ? (
        <Callout tone="warn">
          <p role="status" className="font-medium">
            Waiting for {delivery.vendor_name} to mark this ready. The code box appears here the
            moment they do.
          </p>
        </Callout>
      ) : null}

      {!carrying && !isScan && delivery.food_is_ready ? (
        <form action={confirmPickup} className="rounded-card bg-surface border-line border p-4">
          {hidden}
          <label className="mb-2 block font-semibold" htmlFor="pickup_code">
            Code from the store
          </label>
          <CodeInput name="pickup_code" label="Code from the store" disabled={confirmingPickup} />
          <Button type="submit" size="lg" block pending={confirmingPickup} className="mt-3">
            {confirmingPickup ? 'Checking…' : 'Confirm pickup'}
          </Button>
        </form>
      ) : null}

      {carrying ? (
        <>
          <form action={complete} className="rounded-card bg-surface border-line border p-4">
            {hidden}
            <label className="mb-2 block font-semibold" htmlFor="delivery_code">
              Delivery code from {delivery.customer_first_name ?? 'the customer'}
            </label>
            <CodeInput
              name="delivery_code"
              label="Delivery code from the customer"
              disabled={completing}
            />
            <Button type="submit" size="lg" block pending={completing} className="mt-3">
              {completing ? 'Confirming…' : 'Complete delivery'}
            </Button>
          </form>

          <AbsenceFlow
            delivery={delivery}
            hidden={hidden}
            report={report}
            reporting={reporting}
            confirmAbsent={confirmAbsent}
            confirming={confirming}
          />
        </>
      ) : showCancel ? (
        <form action={cancel} className="rounded-card bg-surface border-line border p-4">
          {hidden}
          <Field label="Why can you not do this one?">
            <Input name="reason" required minLength={3} placeholder="Something came up" />
          </Field>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            No penalty. The order goes back to other Partners, and the store does not have to do
            anything.
          </p>
          <div className="mt-4 flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setShowCancel(false)}>
              Keep it
            </Button>
            <Button type="submit" variant="danger" pending={cancelling} className="flex-1">
              {cancelling ? 'Giving it back…' : 'Give this order back'}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          variant="ghost"
          block
          onClick={() => setShowCancel(true)}
          className="text-muted"
        >
          I cannot do this delivery
        </Button>
      )}

      {result ? (
        result.ok ? (
          <SuccessNote>{result.message}</SuccessNote>
        ) : (
          <ErrorNote>{result.message}</ErrorNote>
        )
      ) : null}
    </div>
  );
}

/**
 * Two steps, and the wait between them is enforced by the server.
 *
 * A Partner cannot arrive, tap "absent" and leave with the food and the fee.
 * The first tap starts a clock; only after it runs down does the second appear.
 */
function AbsenceFlow({ delivery, hidden, report, reporting, confirmAbsent, confirming }) {
  const reported = Boolean(delivery.customer_absent_reported_at);
  const waitLeft = delivery.seconds_until_absent_allowed ?? 0;

  if (!reported) {
    return (
      <form action={report}>
        {hidden}
        <Button type="submit" variant="secondary" block pending={reporting}>
          {reporting ? 'Recording…' : 'Customer is not responding'}
        </Button>
      </form>
    );
  }

  if (waitLeft > 0) {
    return (
      <div role="status" className="rounded-card bg-warn-bg text-warn px-4 py-3 text-sm">
        <p className="font-semibold">Waiting recorded.</p>
        <p className="mt-1">
          Keep trying to reach them. You can close this in{' '}
          <span className="tabular-nums">{Math.ceil(waitLeft / 60)}</span> more minute
          {Math.ceil(waitLeft / 60) === 1 ? '' : 's'}.
        </p>
      </div>
    );
  }

  return (
    <form action={confirmAbsent} className="rounded-card bg-warn-bg p-4">
      {hidden}
      <p className="text-warn text-sm">
        You have waited long enough. Closing this records your earning and hands the food question
        to Campus Dash support.
      </p>
      <Button type="submit" variant="danger" block pending={confirming} className="mt-3">
        {confirming ? 'Closing…' : 'Close as customer absent'}
      </Button>
    </form>
  );
}
