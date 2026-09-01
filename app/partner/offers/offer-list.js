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
      <p className="text-muted mt-4 rounded-lg border border-dashed border-black/15 px-4 py-8 text-center text-sm">
        Nothing waiting right now. This updates on its own.
      </p>
    );
  }

  return (
    <>
      {state.message && !state.ok ? (
        <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.message}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {offers.map((offer) => (
          <li key={offer.order_id} className="rounded-lg bg-white p-4 ring-1 ring-black/5">
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
              <Row label="Items" value={`${offer.item_count}`} />
              <Row label="Food" value="cooked and waiting" />
            </dl>

            <form action={accept} className="mt-3">
              <input type="hidden" name="order_id" value={offer.order_id} />
              <button
                type="submit"
                disabled={accepting}
                className="bg-brand-500 text-ink w-full rounded-lg py-3.5 text-base font-semibold disabled:opacity-60"
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
