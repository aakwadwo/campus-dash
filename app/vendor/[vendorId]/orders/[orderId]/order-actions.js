'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { markReadyAction, redeemScanAction, refuseScanAction } from '@/app/vendor/actions';
import { Button, CodeDisplay, ErrorNote, SuccessNote, Callout, Completion, Card } from '@/app/ui';
import { useStatusWatch } from '@/app/use-status-watch';

/**
 * How often a waiting order screen asks whether the handoff has happened.
 *
 * Short on purpose, and only ever while somebody is standing at the counter:
 * the check is four fields from one indexed row, and a customer who has typed
 * the code in should not watch the store's screen still showing it.
 */
const HANDOFF_WATCH_MS = 2500;

/** How long "Collected" stays on screen before the board comes back. */
const COLLECTED_RETURN_MS = 2200;

/** What the screen was drawn from, in the shape the status endpoint answers. */
function statusSignature(status) {
  return [
    status.order_status,
    status.delivery_status,
    status.payment_status,
    Boolean(status.handoff_code_available),
    Boolean(status.vendor_completed_at),
  ].join('|');
}

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
 *
 * WHILE THE ORDER IS AT THE COUNTER this screen watches it. The code is read out
 * and then the store waits for somebody else to act on their own phone; without
 * a watch the code stayed up after the customer had collected, until somebody
 * navigated away. Collection is shown only once the SERVER reports it — never
 * optimistically — and the board comes back on its own.
 */
export default function OrderActions({ order, vendorId, handoffCode, scanUrl = null }) {
  const router = useRouter();
  const [ready, readyAction, marking] = useActionState(markReadyAction, {});
  // Set from the status endpoint, i.e. from the database: the handoff happened.
  const [collected, setCollected] = useState(false);

  const isScan = order.order_type === 'SCAN';
  // A scan nobody has looked at yet. Ready is refused until this is settled —
  // vendor_mark_ready() enforces it, so the button below is a signpost rather
  // than the guard.
  const scanUnchecked = isScan && ['UPLOADED', 'RELEASED'].includes(order.scan_status);
  const scanRefused = isScan && order.scan_status === 'REFUSED';

  // THE STORE'S OWN COMPLETION, which is not the order's. Handing a bag to a
  // Partner ends the store's part; the customer is still waiting, and their
  // screen still says so.
  const handedOver = Boolean(order.vendor_completed_at);
  const waitingToBeCollected =
    order.order_status === 'READY' && !order.handoff_code_available && !handedOver;
  const completed = collected || handedOver;

  // Waiting on the other side of the counter: a code to be typed in, or a
  // Partner who has not arrived yet (whose arrival is what makes the code show).
  const atCounter = order.order_status === 'READY' && !handedOver;

  useStatusWatch({
    url: `/api/vendor/orders/${order.order_id}/status`,
    enabled: atCounter && !collected,
    initial: statusSignature(order),
    signatureOf: statusSignature,
    intervalMs: HANDOFF_WATCH_MS,
    onChange: (status) => {
      if (status.vendor_completed_at || status.order_status === 'COMPLETED') setCollected(true);
      // Anything that moved — collected, a Partner arriving, a cancellation —
      // is drawn from the server, once.
      router.refresh();
    },
  });

  // Back to the board once the handoff is confirmed. Only when THIS screen saw
  // it happen: opening an order that finished yesterday stays where it is.
  useEffect(() => {
    if (!collected) return undefined;
    const timer = setTimeout(() => router.replace(`/vendor/${vendorId}`), COLLECTED_RETURN_MS);
    return () => clearTimeout(timer);
  }, [collected, router, vendorId]);

  const handoffLabel = 'Handed over';

  return (
    <div className="space-y-3">
      {/* THE SCAN COMES FIRST. Nothing should be cooked, boxed or handed over
          against an entitlement nobody has looked at, so this sits above the
          Ready button and the Ready button will not move until it is settled. */}
      {scanUnchecked && !completed ? (
        <ScanCheck order={order} vendorId={vendorId} scanUrl={scanUrl} />
      ) : null}

      {scanRefused ? (
        <Callout tone="bad">
          You marked this meal scan as one you could not honour. Campus Dash will follow it up with
          the customer — there is nothing more for you to do.
        </Callout>
      ) : null}

      {order.bucket === 'NEW' && !completed && !scanUnchecked && !scanRefused ? (
        <form action={readyAction}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <Button type="submit" size="lg" block pending={marking} className="h-14 text-lg">
            {marking ? 'Marking ready…' : 'Ready for pickup'}
          </Button>
          {/* WHO IS COLLECTING IS NOT NAMED. The store does the same thing
              either way, and the code appears when somebody is actually there. */}
          <p className="text-muted mt-2.5 text-center text-sm">
            The code shows here when whoever is collecting arrives.
          </p>
        </form>
      ) : null}

      {/* THE HANDOFF. The store HOLDS the code and READS IT OUT; whoever is
          taking the food types it into their own app. Whoever holds the secret
          must not also be the one confirming, or the code proves nothing — so
          this is a display, never a form. */}
      {order.order_status === 'READY' && order.handoff_code_available && !completed ? (
        handoffCode ? (
          <CodeDisplay
            label="Someone is collecting this order"
            hint="Read this out. Hand over once they have entered it."
            code={handoffCode}
          />
        ) : (
          <Callout tone="warn">
            The code could not be loaded. Pull down or reload this page to try again.
          </Callout>
        )
      ) : null}

      {waitingToBeCollected && !completed ? (
        <Callout tone="neutral">
          Waiting to be collected. The code shows here when somebody arrives.
        </Callout>
      ) : null}

      {completed ? (
        <div className="bg-good-bg rounded-card py-6">
          <Completion title={handoffLabel}>
            {collected ? 'Taking you back to your orders.' : 'This order is complete.'}
          </Completion>
        </div>
      ) : null}

      {/* The code or the waiting line already says what happens next; the note
          is for a refusal, or a success with nothing else on screen to show it. */}
      {ready.message && !completed ? (
        ready.ok ? (
          atCounter ? null : (
            <SuccessNote>{ready.message}</SuccessNote>
          )
        ) : (
          <ErrorNote>{ready.message}</ErrorNote>
        )
      ) : null}
    </div>
  );
}

/**
 * Checking the meal scan.
 *
 * The image is shown at full width because the whole point is reading it, and
 * the two answers are deliberately asymmetric: verifying is one tap, refusing
 * asks for a reason. A refusal stops the order and goes to Campus Dash, so it
 * should cost a sentence — and the sentence is the only record of what went
 * wrong at the counter.
 */
function ScanCheck({ order, vendorId, scanUrl }) {
  const [redeemed, redeem, redeeming] = useActionState(redeemScanAction, {});
  const [refused, refuse, refusing] = useActionState(refuseScanAction, {});
  const [refusalOpen, setRefusalOpen] = useState(false);

  return (
    <Card className="border-brand-600 ring-brand-600/25 p-5 ring-1">
      <h2 className="font-semibold">Check the meal scan</h2>
      <p className="text-muted mt-1 text-sm leading-relaxed">
        The customer has already paid for this food through the campus meal system. Check the scan
        is good before you hand anything over.
      </p>

      {scanUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={scanUrl}
          alt="The customer's meal scan"
          className="border-line rounded-card mt-4 w-full border"
        />
      ) : (
        <Callout tone="warn" className="mt-4">
          The scan image could not be loaded. Reload this page to try again.
        </Callout>
      )}

      <div className="mt-4 space-y-3">
        <form action={redeem}>
          <input type="hidden" name="order_id" value={order.order_id} />
          <input type="hidden" name="vendor_id" value={vendorId} />
          <Button type="submit" size="lg" block pending={redeeming}>
            {redeeming ? 'Recording…' : 'Scan is good'}
          </Button>
        </form>

        {refusalOpen ? (
          <form action={refuse} className="space-y-2.5">
            <input type="hidden" name="order_id" value={order.order_id} />
            <input type="hidden" name="vendor_id" value={vendorId} />
            <label className="block">
              <span className="text-sm font-medium">What is wrong with it?</span>
              <input
                name="reason"
                required
                maxLength={200}
                placeholder="Already used today"
                className="rounded-input bg-surface border-line-strong focus:border-brand-600 placeholder:text-faint mt-1.5 h-12 w-full border px-3 text-base outline-none"
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" pending={refusing}>
                {refusing ? 'Recording…' : 'Refuse this scan'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRefusalOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setRefusalOpen(true)}
            className="text-muted hover:text-bad press-sm min-h-11 text-sm font-medium transition-colors"
          >
            I cannot honour this scan
          </button>
        )}
      </div>

      {redeemed.message && !redeemed.ok ? <ErrorNote>{redeemed.message}</ErrorNote> : null}
      {refused.message && !refused.ok ? <ErrorNote>{refused.message}</ErrorNote> : null}
    </Card>
  );
}
