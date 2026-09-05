'use client';

import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { acceptDeliveryAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';

/**
 * Offers, with everything needed to say yes.
 *
 * Vendor, zone, walking estimate and earnings are all shown BEFORE accepting —
 * hiding them would make the decision a gamble. What is not shown is who the
 * customer is or which room, because that is not needed to judge the job.
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
          <li key={offer.order_id} className="rounded-card bg-surface ring-line p-4 ring-1">
            {/* A scan errand is a different job and must not be mistaken for a
                collection: you carry the customer's prepaid scan, redeem it at
                the counter yourself, and the food is not waiting for you. */}
            {offer.order_type === 'SCAN' ? (
              <p className="text-brand-700 mb-1 text-xs font-semibold tracking-wide uppercase">
                Scan delivery
              </p>
            ) : null}

            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold">{offer.vendor_name}</span>
              <span className="text-brand-700 font-semibold tabular-nums">
                {formatPesewas(offer.earnings_pesewas)}
              </span>
            </div>

            <dl className="text-muted mt-2 space-y-0.5 text-sm">
              <Row label="Deliver to" value={offer.destination_zone} />
              <Row
                label="Walk"
                value={
                  offer.walk_minutes == null ? 'not measured' : `about ${offer.walk_minutes} min`
                }
              />
              {offer.order_type === 'SCAN' ? (
                <Row label="You do" value="redeem the customer’s scan, then deliver" />
              ) : (
                <>
                  <Row label="Items" value={`${offer.item_count}`} />
                  <Row label="Food" value="cooked and waiting" />
                </>
              )}
            </dl>

            <form action={accept} className="mt-3">
              <input type="hidden" name="order_id" value={offer.order_id} />
              <button
                type="submit"
                disabled={accepting}
                className="press bg-brand-500 text-ink w-full rounded-full py-3.5 text-base font-semibold transition-colors disabled:opacity-55"
              >
                {accepting ? 'Accepting…' : 'Accept this delivery'}
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
