'use client';

import { useActionState } from 'react';
import { reportScanRedeemedAction, reportScanRefusedAction } from '../actions';
import { Button, ErrorNote, SuccessNote, TEXT_LINK_CLASS } from '@/app/ui';

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
      <section className="rounded-card bg-surface ring-line p-4 ring-1">
        <h2 className="text-xs font-semibold tracking-wide uppercase">The customer’s scan</h2>
        <p className="text-muted mt-1 text-sm leading-relaxed">
          Show this at {restaurantName} to collect the order. The food is already paid for, so do
          not pay for it yourself.
        </p>

        {scanUrl ? (
          scanUrl.includes('.pdf') ? (
            <a
              href={scanUrl}
              target="_blank"
              rel="noreferrer"
              className={`${TEXT_LINK_CLASS} mt-3 inline-flex min-h-11 items-center text-sm`}
            >
              Open the scan (PDF)
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={scanUrl}
              alt="The customer’s meal scan"
              className="ring-line mt-3 w-full rounded ring-1"
            />
          )
        ) : (
          <p className="bg-warn-bg text-warn mt-3 rounded px-3 py-2 text-sm">
            The scan could not be loaded. Reload the page; if it still will not show, do not pay for
            the food and contact Campus Dash.
          </p>
        )}
      </section>

      <section className="rounded-card bg-surface ring-line mt-3 p-4 ring-1">
        <h2 className="text-sm font-semibold">What happened at the counter?</h2>

        <form action={redeem} className="mt-3">
          <input type="hidden" name="order_id" value={orderId} />
          <Button type="submit" size="lg" block pending={busy}>
            {redeeming ? 'Recording…' : 'They accepted it, I have the food'}
          </Button>
        </form>
        <p className="text-muted mt-2 text-xs">
          Press this only once the food is actually in your hands. It is what releases the
          customer’s room number.
        </p>

        <form action={refuse} className="border-line mt-5 border-t pt-4">
          <input type="hidden" name="order_id" value={orderId} />
          <label className="block text-sm font-medium">They would not accept it</label>
          <input
            name="reason"
            required
            placeholder="e.g. the counter said it was already used"
            className="rounded-input border-line-strong bg-surface focus:border-brand-600 mt-2 h-12 w-full border px-4 text-[15px] transition-colors outline-none"
          />
          <Button type="submit" variant="danger" block disabled={busy} className="mt-2">
            {refusing ? 'Recording…' : 'Report that the scan was refused'}
          </Button>
        </form>

        <Result state={redeemState} />
        <Result state={refuseState} />
      </section>
    </>
  );
}

function Result({ state }) {
  if (!state?.message) return null;
  return state.ok ? (
    <SuccessNote className="mt-3">{state.message}</SuccessNote>
  ) : (
    <ErrorNote className="mt-3">{state.message}</ErrorNote>
  );
}
