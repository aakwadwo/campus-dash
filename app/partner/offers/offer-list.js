'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { acceptDeliveryAction } from '../actions';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';
import { Button, ErrorNote, EmptyState, BikeIcon } from '@/app/ui';

/**
 * Offers, with everything needed to say yes.
 *
 * Store, block and floor, walking estimate and earnings are shown BEFORE
 * accepting; hiding them would make the decision a gamble. What is not shown is
 * who the customer is or which room, because that is not needed to judge the
 * job. Both arrive the instant the order is yours.
 *
 * EVERY OFFER HERE IS PAID FOR, but not every one is cooked: the pool opens the
 * moment a customer pays, so a Partner can claim a job while the kitchen works.
 * `food_is_ready` is therefore the most important line on the card — it is the
 * difference between "go now" and "it is yours, wait to be called".
 */
export default function OfferList({ offers, pollMs = 10000 }) {
  const router = useRouter();
  // Which offer was pressed, so only THAT button says "Accepting…" — the others
  // are disabled while it is in flight, but they did not do anything.
  const [pressed, setPressed] = useState(null);
  // ACCEPTED MEANS GO. The action redirects to the delivery screen itself, so a
  // win arrives as that screen, in the same response — it used to re-render this
  // list first and then make a second trip with router.push. A loss comes back
  // here as a message, and `accepting` stays true until one or the other lands.
  const [state, accept, accepting] = useActionState(acceptDeliveryAction, {});

  // Offers go stale fast: somebody else is looking at this list too. Paused
  // while an accept is in flight, so a refresh cannot pull the page out from
  // under the navigation it is about to become.
  useEffect(() => {
    if (accepting) return undefined;
    const timer = setInterval(() => router.refresh(), pollMs);
    return () => clearInterval(timer);
  }, [router, pollMs, accepting]);

  if (offers.length === 0 && !accepting) {
    return (
      <div className="bg-surface border-line rounded-card mt-5 border">
        <EmptyState
          icon={<BikeIcon className="size-6" />}
          title="No orders right now"
          description="New ones appear here on their own."
        />
      </div>
    );
  }

  return (
    <>
      {state.message && !state.ok ? <ErrorNote className="mt-4">{state.message}</ErrorNote> : null}

      <ul className="mt-5 space-y-3">
        {offers.map((offer) => (
          <li
            key={offer.order_id}
            className="rounded-card bg-surface border-line border p-4 sm:p-5"
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="font-semibold">{offer.vendor_name}</span>
                <span className="text-muted ml-2 text-sm tabular-nums">#{orderLabel(offer)}</span>
              </span>
              <span className="text-brand-800 font-semibold tabular-nums">
                {formatPesewas(offer.earnings_pesewas)}
              </span>
            </div>

            {/* WHETHER TO GO NOW. A meal scan is an ordinary store order that
                the store checks at its own counter, so it reads the same way,
                with a small mark saying so. */}
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span
                className={`inline-flex items-center gap-1.5 font-semibold ${
                  offer.food_is_ready ? 'text-good' : 'text-warn'
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${offer.food_is_ready ? 'bg-good' : 'bg-warn'}`}
                  aria-hidden
                />
                {offer.food_is_ready ? 'Ready at the store' : 'Still being prepared'}
              </span>
              {offer.order_type === 'SCAN' ? (
                <span className="bg-brand-50 text-brand-800 rounded px-1.5 py-0.5 text-xs font-semibold">
                  Meal scan
                </span>
              ) : null}
            </p>

            {/* BLOCK AND FLOOR, WHICH IS AS FAR AS AN OFFER GOES. The floor is
                most of the walk, so it is here; the ROOM, the customer's name
                and their number arrive with the assignment, to the one Partner
                who then needs them. */}
            <p className="text-muted border-line mt-3 border-t pt-3 text-sm">
              <span className="text-ink font-medium">{offer.destination_zone}</span>
              {offer.destination_floor ? `, ${offer.destination_floor}` : ''}
              {offer.walk_minutes == null ? '' : ` · about ${offer.walk_minutes} min walk`}
              {` · ${offer.item_count} item${Number(offer.item_count) === 1 ? '' : 's'}`}
            </p>

            <form action={accept} onSubmit={() => setPressed(offer.order_id)} className="mt-4">
              <input type="hidden" name="order_id" value={offer.order_id} />
              <Button
                type="submit"
                size="lg"
                block
                disabled={accepting}
                pending={accepting && pressed === offer.order_id}
              >
                {accepting && pressed === offer.order_id ? 'Accepting…' : 'Accept this order'}
              </Button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
