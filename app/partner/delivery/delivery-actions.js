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
          <form action={complete} className="rounded-card bg-surface ring-line p-4 ring-1">
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
                className="border-line-strong mt-1 w-full rounded border px-3 py-3 text-center text-2xl tracking-[0.4em] tabular-nums"
              />
            </label>
            <button
              type="submit"
              disabled={completing}
              className="press bg-brand-500 text-ink mt-3 w-full rounded-full py-4 text-base font-semibold transition-colors disabled:opacity-55"
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
        <form action={cancel} className="rounded-card bg-surface ring-line p-4 ring-1">
          {hidden}
          <label className="block text-sm font-medium">
            Why can you not do this one?
            <input
              name="reason"
              required
              minLength={3}
              placeholder="Something came up"
              className="border-line-strong mt-1 w-full rounded border px-3 py-2.5 text-base"
            />
          </label>
          <p className="text-muted mt-2 text-xs">
            No penalty. The order stays exactly as it is and goes back to other Partners, and the
            vendor does not have to do anything.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="submit"
              disabled={cancelling}
              className="press bg-surface text-bad ring-bad/30 flex-1 rounded-full py-3 text-sm font-semibold ring-1 transition-colors"
            >
              {cancelling ? 'Cancelling…' : 'Confirm cancel'}
            </button>
            <button
              type="button"
              onClick={() => setShowCancel(false)}
              className="press rounded-full px-4 py-3 text-sm font-semibold transition-colors"
            >
              Keep it
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setShowCancel(true)}
          className="press bg-surface text-bad ring-bad/30 w-full rounded-full py-3 text-sm font-semibold ring-1 transition-colors"
        >
          I cannot do this delivery
        </button>
      )}

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
          className="press bg-surface ring-line-strong w-full rounded-full py-3 text-sm font-semibold ring-1 transition-colors disabled:opacity-55"
        >
          {reporting ? 'Recording…' : 'Customer is not responding'}
        </button>
      </form>
    );
  }

  if (waitLeft > 0) {
    return (
      <div className="rounded-card bg-warn-bg text-warn px-4 py-3 text-sm">
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
      <button
        type="submit"
        disabled={confirming}
        className="press mt-3 w-full rounded-full bg-amber-800 py-3 text-sm font-semibold text-white transition-colors disabled:opacity-55"
      >
        {confirming ? 'Closing…' : 'Close as customer absent'}
      </button>
    </form>
  );
}
