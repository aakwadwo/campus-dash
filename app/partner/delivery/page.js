import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getActiveDeliveries } from '@/lib/partner';
import { scanImageUrl, getPartnerScanBrief } from '@/lib/scan';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';
import DeliveryActions from './delivery-actions';
import ScanCollection from './scan-collection';
import { BackLink } from '@/app/ui';

export const dynamic = 'force-dynamic';

/**
 * One delivery, in detail.
 *
 * A Partner can carry more than one at once, so this page names WHICH —
 * `?order=<id>`, defaulting to the first. The list is partner_active_delivery(), which returns
 * only rows where partner_id = auth.uid() and the delivery is still live, so an
 * order id that is not theirs is not in the list and 404s. The screen never
 * queries an order by id.
 *
 * THE CUSTOMER'S PHONE NUMBER is on this page from the moment the delivery is
 * assigned, and it is authorised three times over: the read model selects it
 * only for the assigned Partner while ASSIGNED or PICKED_UP, the RLS policy on
 * public.users says the same thing independently, and neither returns anything
 * once the delivery is DELIVERED. It is not hidden with CSS anywhere.
 */
export default async function PartnerDeliveryPage({ searchParams }) {
  const me = await getCapabilities();
  if (!me.is_partner) redirect('/partner');

  const params = await searchParams;
  const deliveries = await getActiveDeliveries();
  const requested = typeof params?.order === 'string' ? params.order : null;
  const delivery = requested
    ? (deliveries.find((d) => d.order_id === requested) ?? null)
    : (deliveries[0] ?? null);

  // THE ORDER IS NO LONGER IN HAND. Almost always because the Partner has just
  // finished it on this screen: the action revalidates this page, and the
  // delivery is gone from partner_active_delivery(). That used to be a bare
  // bounce to /partner — the "Delivered" message lost on the way — or, with a
  // second delivery still active, a 404. Partner home says what happened.
  //
  // Nothing about the order is trusted from the URL: home looks the id up in
  // this Partner's own history and says nothing if it is not there.
  if (!delivery) {
    redirect(requested ? `/partner?finished=${encodeURIComponent(requested)}` : '/partner');
  }

  const collecting = delivery.delivery_status === 'ASSIGNED';
  const isScan = delivery.order_type === 'SCAN';

  // The scan the Partner presents at the counter. The store checks it and then
  // reads out the ordinary four digits, so this is what a Partner SHOWS rather
  // than what they report on. The URL is short-lived and re-derived on every
  // load, which is what makes losing the assignment revoke access rather than
  // merely hide a link.
  const scanUrl = collecting && isScan ? await scanImageUrl(delivery.order_id) : null;

  // What the customer asked for. Gated on the same release as the image, so it
  // opens on assignment and closes when the delivery does.
  const brief = isScan ? await getPartnerScanBrief(delivery.order_id) : null;

  // WHERE IT IS GOING, and who to ring. Shown from assignment for both legs,
  // but in the order the legs happen: while collecting it sits UNDER the
  // collection, because the counter is the next thing, not the door.
  const destinationCard = (
    <section className="rounded-card bg-surface border-line border p-4">
      <h2 className="text-muted text-sm font-medium">
        {collecting ? 'Then take it to' : 'Take it to'}
      </h2>
      {/* THE FIRST NAME, LARGE. It is what the Partner says out loud when
          somebody opens the door, so it is the biggest thing on the card —
          above the room, which they need second. */}
      {delivery.customer_first_name ? (
        <p className="mt-1 text-xl font-semibold">{delivery.customer_first_name}</p>
      ) : null}
      <p className="mt-0.5 text-lg">{delivery.destination}</p>
      {delivery.destination_note ? (
        <p className="text-muted mt-1 text-sm">“{delivery.destination_note}”</p>
      ) : null}
      {delivery.customer_phone ? (
        <a
          href={`tel:${delivery.customer_phone}`}
          className={`press mt-3 inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition-colors ${
            // The primary action only once the door is the next thing. While
            // collecting, the counter is, and two orange buttons compete.
            collecting
              ? 'border-line-strong hover:bg-surface-2 border'
              : 'bg-brand-700 hover:bg-brand-800 text-white'
          }`}
        >
          Call {delivery.customer_first_name ?? 'the customer'} · {delivery.customer_phone}
        </a>
      ) : null}
    </section>
  );

  return (
    <main className="mx-auto max-w-2xl px-4 pt-3 pb-16 sm:px-6 sm:pt-6">
      <BackLink href="/partner">Partner home</BackLink>

      {deliveries.length > 1 ? (
        <nav className="mt-3 flex flex-wrap gap-2" aria-label="Orders you are carrying">
          {deliveries.map((d) => (
            <Link
              key={d.order_id}
              href={`/partner/delivery?order=${d.order_id}`}
              aria-current={d.order_id === delivery.order_id ? 'page' : undefined}
              className={`press-sm inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold tabular-nums transition-colors ${
                d.order_id === delivery.order_id
                  ? 'bg-brand-700 border-brand-700 text-white'
                  : 'bg-surface border-line-strong text-ink hover:bg-surface-2'
              }`}
            >
              #{orderLabel(d)}
            </Link>
          ))}
        </nav>
      ) : null}

      <header className="mt-3 mb-5">
        {/* WHERE IN THE JOB. Two legs, and which one this is. */}
        <ol className="mb-3 flex items-center gap-2 text-sm font-semibold" aria-label="Progress">
          <li className={collecting ? 'text-brand-700' : 'text-good'}>
            {collecting ? '1. Collect' : '✓ Collected'}
          </li>
          <li aria-hidden className="bg-line-strong h-px w-6" />
          <li className={collecting ? 'text-faint' : 'text-brand-700'}>2. Deliver</li>
        </ol>
        {/* THE STORE CHECKS A MEAL SCAN, not the Partner. The job is the same
            as any order: collect with the store's code, deliver with the
            customer's. */}
        {isScan ? (
          <p className="bg-brand-50 text-brand-800 mb-1.5 w-fit rounded px-1.5 py-0.5 text-xs font-semibold">
            Meal scan
          </p>
        ) : null}
        <h1 className="text-display text-2xl font-semibold sm:text-3xl">
          {collecting
            ? delivery.food_is_ready
              ? 'Collect the order'
              : 'Wait for the store'
            : 'Deliver the order'}
        </h1>
        <p className="text-muted mt-1.5 text-sm">
          <span className="text-ink font-semibold tabular-nums">Order #{orderLabel(delivery)}</span>
          {' · '}You earn{' '}
          <span className="text-ink font-semibold">{formatPesewas(delivery.earnings_pesewas)}</span>
        </p>
      </header>

      {collecting ? null : destinationCard}

      {collecting && isScan ? (
        <>
          <section className="rounded-card bg-surface border-line mt-3 border p-4">
            <h2 className="text-muted text-sm font-medium">Go to</h2>
            <p className="mt-1 text-lg font-semibold">{delivery.vendor_name}</p>
            <p className="text-muted text-sm">{delivery.vendor_location}</p>
          </section>

          {/* The customer's optional note. The ITEMS say what the order is —
              they are on the order like any other — so this is context rather
              than the whole instruction it used to have to be. */}
          {brief?.details ? (
            <section className="rounded-card bg-brand-50 mt-3 p-4">
              <h2 className="text-muted text-sm font-medium">What they asked for</h2>
              <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line">{brief.details}</p>
            </section>
          ) : null}

          <div className="mt-3">
            <ScanCollection scanUrl={scanUrl} restaurantName={delivery.vendor_name} />
          </div>
        </>
      ) : collecting ? (
        <section className="rounded-card bg-surface border-line mt-3 border p-4">
          <h2 className="text-muted text-sm font-medium">Collect from</h2>
          <p className="mt-1 text-lg font-semibold">{delivery.vendor_name}</p>
          <p className="text-muted text-sm">{delivery.vendor_location}</p>
          {delivery.vendor_phone ? (
            <a
              href={`tel:${delivery.vendor_phone}`}
              className="press border-line-strong hover:bg-surface-2 mt-3 inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors"
            >
              Call the store
            </a>
          ) : null}
          {/* TAKEN EARLY, ON PURPOSE. The offer pool opens the moment a customer
              pays, so a Partner usually claims a job while it is still cooking.
              Saying so plainly is what stops somebody walking to a counter for
              food that is not there. */}
          {delivery.food_is_ready ? (
            <p className="text-muted mt-3 text-sm leading-relaxed">
              Ask the store for the <strong className="text-ink">4-digit code</strong> on their
              screen and enter it below. That is what releases the food.
            </p>
          ) : (
            <p className="text-warn mt-3 text-sm leading-relaxed font-medium">
              This order is still being prepared. It is yours, so wait until the store marks it
              ready. This page updates on its own.
            </p>
          )}
        </section>
      ) : (
        <section className="text-muted rounded-card bg-surface border-line mt-3 border p-4 text-sm">
          Ask {delivery.customer_first_name ?? 'the customer'} for their{' '}
          <strong className="text-ink">4-digit delivery code</strong> and enter it below. That is
          what completes the order and records your earning.
        </section>
      )}

      {/* The code box follows the instruction that asks for it. While
          collecting, where the food goes next comes after the step in hand. */}
      <div className="mt-4">
        <DeliveryActions delivery={delivery} isScan={isScan} />
      </div>

      {collecting ? <div className="mt-4">{destinationCard}</div> : null}
    </main>
  );
}
