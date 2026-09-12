'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { acceptDeliveryAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';

/**
 * Offers, with everything needed to say yes.
 *
 * Store, zone, walking estimate and earnings are all shown BEFORE accepting —
 * hiding them would make the decision a gamble. What is not shown is who the
 * customer is or which room, because that is not needed to judge the job. Both
 * arrive the instant the order is yours.
 *
 * EVERY OFFER HERE IS PAID FOR, but not every one is cooked: the pool opens the
 * moment a customer pays, so a Partner can claim a job while the kitchen works.
 * `food_is_ready` is therefore the most important line on the card — it is the
 * difference between "go now" and "it is yours, wait to be called".
 */
export default function OfferList({ offers, pollMs = 10000 }) {
  const router = useRouter();
  const [state, accept, accepting] = useActionState(acceptDeliveryAction, {});

  // Offers go stale fast: somebody else is looking at this list too.
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), pollMs);
    return () => clearInterval(timer);
  }, [router, pollMs]);

  if (offers.length === 0) {
    return (
      <p className="text-muted rounded-input border-line-strong mt-4 border border-dashed px-4 py-8 text-center text-sm transition-colors">
        Nothing waiting right now. This updates on its own.
      </p>
    );
  }

  return (
    <>
      {state.message && !state.ok ? (
        <p role="alert" className="rounded-card bg-bad-bg text-bad mt-4 px-4 py-3 text-sm">
          {state.message}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {offers.map((offer) => (
          <li key={offer.order_id} className="rounded-card bg-surface border-line border p-4">
            {/* A scan errand is a different job and must not be mistaken for a
                collection: you carry the customer's prepaid scan, redeem it at
                the counter yourself, and the food is not waiting for you. */}
            {offer.order_type === 'SCAN' ? (
              <p className="text-brand-800 mb-1 text-xs font-semibold tracking-[0.12em] uppercase">
                Scan delivery
              </p>
            ) : null}

            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="font-semibold">{offer.vendor_name}</span>
                {offer.order_type === 'SCAN' ? null : (
                  <span className="text-muted ml-2 text-sm tabular-nums">#{orderLabel(offer)}</span>
                )}
              </span>
              <span className="text-brand-800 font-semibold tabular-nums">
                {formatPesewas(offer.earnings_pesewas)}
              </span>
            </div>

            <p
              className={`mt-1.5 inline-flex items-center gap-1.5 text-sm font-semibold ${
                offer.food_is_ready ? 'text-good' : 'text-warn'
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${offer.food_is_ready ? 'bg-good' : 'bg-warn'}`}
                aria-hidden
              />
              {offer.order_type === 'SCAN'
                ? 'Ready to run'
                : offer.food_is_ready
                  ? 'Cooked and waiting'
                  : 'Still being prepared'}
            </p>

            <dl className="text-muted mt-2 space-y-0.5 text-sm">
              <Row label="Deliver to" value={offer.destination_zone} />
              <Row
                label="Walk"
                value={
                  offer.walk_minutes == null ? 'not measured' : `about ${offer.walk_minutes} min`
                }
              />
              {offer.order_type === 'SCAN' ? (
                <Row label="You do" value="redeem the scan, then take it over" />
              ) : (
                <>
                  <Row label="Items" value={`${offer.item_count}`} />
                </>
              )}
            </dl>

            <form action={accept} className="mt-3">
              <input type="hidden" name="order_id" value={offer.order_id} />
              <button
                type="submit"
                disabled={accepting}
                className="press bg-brand-700 hover:bg-brand-800 w-full rounded-full py-3.5 text-base font-semibold text-white transition-colors disabled:opacity-55"
              >
                {accepting ? 'Accepting…' : 'Accept this order'}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}
