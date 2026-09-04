'use client';

import { useActionState } from 'react';
import { reportScanRedeemedAction, reportScanRefusedAction } from '../actions';

/**
 * Collecting a SCAN order.
 *
 * Where a food collection shows a pickup code to read to the vendor, this shows
 * the customer's scan and asks what the counter did with it. Those are the only
 * two answers, and neither is assumed: a Partner who has accepted the errand has
 * redeemed nothing until they say so here.
 *
 * The image URL is minted per request and expires on its own, so this component
 * never holds a durable link to somebody's meal entitlement.
 */
export default function ScanCollection({ orderId, scanUrl, restaurantName }) {
  const [redeemState, redeem, redeeming] = useActionState(reportScanRedeemedAction, {});
  const [refuseState, refuse, refusing] = useActionState(reportScanRefusedAction, {});
  const busy = redeeming || refusing;

  return (
    <>
      <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="text-xs font-semibold tracking-wide uppercase">The customer’s scan</h2>
        <p className="text-muted mt-1 text-sm leading-relaxed">
          Show this at {restaurantName} to collect the order. The food is already paid for — do not
          pay for it yourself.
        </p>

        {scanUrl ? (
          scanUrl.includes('.pdf') ? (
            <a
              href={scanUrl}
              target="_blank"
              rel="noreferrer"
              className="text-brand-700 mt-3 inline-block text-sm font-semibold underline underline-offset-4"
            >
              Open the scan (PDF) →
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={scanUrl}
              alt="The customer’s meal scan"
              className="mt-3 w-full rounded ring-1 ring-black/10"
            />
          )
        ) : (
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The scan could not be loaded. Reload the page; if it still will not show, do not pay for
            the food and contact Campus Dash.
          </p>
        )}
      </section>

      <section className="mt-3 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="text-sm font-semibold">What happened at the counter?</h2>

        <form action={redeem} className="mt-3">
          <input type="hidden" name="order_id" value={orderId} />
          <button
            type="submit"
            disabled={busy}
            className="bg-brand-500 text-ink w-full rounded-lg py-3.5 text-base font-semibold disabled:opacity-60"
          >
            {redeeming ? 'Recording…' : 'They accepted it — I have the food'}
          </button>
        </form>
        <p className="text-muted mt-2 text-xs">
          Press this only once the food is actually in your hands. It is what releases the
          customer’s room number.
        </p>

        <form action={refuse} className="mt-5 border-t border-black/10 pt-4">
          <input type="hidden" name="order_id" value={orderId} />
          <label className="block text-sm font-medium">They would not accept it</label>
          <input
            name="reason"
            required
            placeholder="e.g. the counter said it was already used"
            className="mt-2 w-full rounded-lg border border-black/15 px-3 py-2.5 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-2 w-full rounded-lg border border-black/15 py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {refusing ? 'Recording…' : 'Report that the scan was refused'}
          </button>
        </form>

        <Result state={redeemState} />
        <Result state={refuseState} />
      </section>
    </>
  );
}

function Result({ state }) {
  if (!state?.message) return null;
  return (
    <p
      className={`mt-3 rounded-lg px-3 py-2 text-sm ${
        state.ok ? 'bg-brand-50 text-ink' : 'bg-red-50 text-red-800'
      }`}
    >
      {state.message}
    </p>
  );
}
