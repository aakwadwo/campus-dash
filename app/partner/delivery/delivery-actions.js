'use client';

import { useActionState, useState } from 'react';
import {
  cancelDeliveryAction,
  completeDeliveryAction,
  reportAbsentAction,
  confirmAbsentAction,
} from '../actions';

/**
 * What a Partner can do with the job in their hands.
 *
 * Before handoff they may cancel freely — no penalty in V1, the order simply
 * goes back to the pool with a fresh pickup code. After handoff they are
 * carrying food, so the only ways out are delivering it or the absence process.
 */
export default function DeliveryActions({ delivery }) {
  const [cancelState, cancel, cancelling] = useActionState(cancelDeliveryAction, {});
  const [completeState, complete, completing] = useActionState(completeDeliveryAction, {});
  const [reportState, report, reporting] = useActionState(reportAbsentAction, {});
  const [confirmState, confirmAbsent, confirming] = useActionState(confirmAbsentAction, {});
  const [showCancel, setShowCancel] = useState(false);

  const hidden = <input type="hidden" name="order_id" value={delivery.order_id} />;
  const carrying = delivery.delivery_status === 'PICKED_UP';
  const result = [completeState, reportState, confirmState, cancelState].find((s) => s.message);

  return (
    <div className="space-y-3">
      {carrying ? (
        <>
          <form action={complete} className="rounded-lg bg-white p-4 ring-1 ring-black/5">
            {hidden}
            <label className="block text-sm font-medium">
              Delivery code from the customer
              <input
                name="delivery_code"
                inputMode="numeric"
                required
                pattern="\d{4}"
                maxLength={4}
                placeholder="1234"
                className="mt-1 w-full rounded border border-black/15 px-3 py-3 text-center text-2xl tracking-[0.4em] tabular-nums"
              />
            </label>
            <button
              type="submit"
              disabled={completing}
              className="bg-brand-600 mt-3 w-full rounded-lg py-4 text-base font-semibold text-white disabled:opacity-60"
            >
              {completing ? 'Confirming…' : 'Complete delivery'}
            </button>
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
        <form action={cancel} className="rounded-lg bg-white p-4 ring-1 ring-black/5">
          {hidden}
          <label className="block text-sm font-medium">
            Why can you not do this one?
            <input
              name="reason"
              required
              minLength={3}
              placeholder="Something came up"
              className="mt-1 w-full rounded border border-black/15 px-3 py-2.5 text-base"
            />
          </label>
          <p className="text-muted mt-2 text-xs">
            No penalty. The order stays exactly as it is and goes back to other Partners — the
            vendor does not have to do anything.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={cancelling}
              className="flex-1 rounded-lg bg-white py-3 text-sm font-semibold text-red-700 ring-1 ring-red-200"
            >
              {cancelling ? 'Cancelling…' : 'Confirm cancel'}
            </button>
            <button
              type="button"
              onClick={() => setShowCancel(false)}
              className="rounded-lg px-4 py-3 text-sm font-semibold"
            >
              Keep it
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowCancel(true)}
          className="w-full rounded-lg bg-white py-3 text-sm font-semibold text-red-700 ring-1 ring-red-200"
        >
          I cannot do this delivery
        </button>
      )}

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
        <button
          type="submit"
          disabled={reporting}
          className="w-full rounded-lg bg-white py-3 text-sm font-semibold ring-1 ring-black/15 disabled:opacity-60"
        >
          {reporting ? 'Recording…' : 'Customer is not responding'}
        </button>
      </form>
    );
  }

  if (waitLeft > 0) {
    return (
      <div className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
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
    <form action={confirmAbsent} className="rounded-lg bg-amber-50 p-4">
      {hidden}
      <p className="text-sm text-amber-900">
        You have waited long enough. Closing this records your earning and hands the food question
        to Campus Dash support.
      </p>
      <button
        type="submit"
        disabled={confirming}
        className="mt-3 w-full rounded-lg bg-amber-800 py-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        {confirming ? 'Closing…' : 'Close as customer absent'}
      </button>
    </form>
  );
}
