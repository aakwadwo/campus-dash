import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getActiveDeliveries } from '@/lib/partner';
import { scanImageUrl, getPartnerScanBrief } from '@/lib/scan';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';
import DeliveryActions from './delivery-actions';
import ScanCollection from './scan-collection';

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
  if (deliveries.length === 0) redirect('/partner');

  const requested = typeof params?.order === 'string' ? params.order : null;
  const delivery = requested
    ? (deliveries.find((d) => d.order_id === requested) ?? null)
    : deliveries[0];
  if (!delivery) notFound();

  const collecting = delivery.delivery_status === 'ASSIGNED';
  const isScan = delivery.order_type === 'SCAN';

  // A scan errand has no vendor handover and therefore no pickup code — the
  // scan image is what the Partner presents instead. The URL is short-lived and
  // re-derived on every load, which is what makes losing the assignment revoke
  // access rather than merely hide a link.
  const scanUrl = collecting && isScan ? await scanImageUrl(delivery.order_id) : null;

  // What the customer asked for. Gated on the same release as the image, so it
  // opens on assignment and closes when the delivery does.
  const brief = isScan ? await getPartnerScanBrief(delivery.order_id) : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-16">
      <Link href="/partner" className="text-muted text-sm underline underline-offset-4">
        ← Partner
      </Link>

      {deliveries.length > 1 ? (
        <nav className="mt-3 flex gap-2" aria-label="Your active orders">
          {deliveries.map((d) => (
            <Link
              key={d.order_id}
              href={`/partner/delivery?order=${d.order_id}`}
              className={`rounded-full border px-3.5 py-2 font-mono text-sm font-semibold ${
                d.order_id === delivery.order_id
                  ? 'bg-brand-700 border-brand-700 text-white'
                  : 'bg-surface border-line text-muted'
              }`}
            >
              #{orderLabel(d)}
            </Link>
          ))}
        </nav>
      ) : null}

      <header className="mt-3 mb-4">
        <p className="text-muted text-sm tabular-nums">Order #{orderLabel(delivery)}</p>
        {isScan ? (
          <p className="text-brand-800 text-xs font-semibold tracking-[0.12em] uppercase">
            Scan delivery
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">
          {collecting
            ? isScan
              ? 'Redeem the scan'
              : delivery.food_is_ready
                ? 'Collect the order'
                : 'Wait for the store'
            : 'Deliver the order'}
        </h1>
        <p className="text-brand-800 mt-1 text-sm font-semibold">
          You earn {formatPesewas(delivery.earnings_pesewas)}
        </p>
      </header>

      {/* WHERE IT IS GOING, and who to ring. Shown from assignment for both
          legs of the journey: a Partner who cannot find a room needs to call
          before they are holding food that is going cold, not after. */}
      <section className="rounded-card bg-surface border-line border p-4">
        <h2 className="text-muted text-xs font-semibold tracking-[0.12em] uppercase">
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
            className="press bg-brand-700 hover:bg-brand-800 mt-3 inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-white"
          >
            Call {delivery.customer_first_name ?? 'the customer'} · {delivery.customer_phone}
          </a>
        ) : null}
      </section>

      {collecting && isScan ? (
        <>
          <section className="rounded-card bg-surface border-line mt-3 border p-4">
            <h2 className="text-muted text-xs font-semibold tracking-[0.12em] uppercase">Go to</h2>
            <p className="mt-1 text-lg font-semibold">{delivery.vendor_name}</p>
            <p className="text-muted text-sm">{delivery.vendor_location}</p>
          </section>

          {/* What to ask for. Written by the customer, and required of them, so
              this is never empty on a new errand. */}
          {brief?.details ? (
            <section className="rounded-card bg-brand-50 mt-3 p-4">
              <h2 className="text-muted text-xs font-semibold tracking-[0.12em] uppercase">
                What they asked for
              </h2>
              <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line">{brief.details}</p>
            </section>
          ) : null}

          <div className="mt-3">
            <ScanCollection
              orderId={delivery.order_id}
              scanUrl={scanUrl}
              restaurantName={delivery.vendor_name}
            />
          </div>
        </>
      ) : collecting ? (
        <section className="rounded-card bg-surface border-line mt-3 border p-4">
          <h2 className="text-muted text-xs font-semibold tracking-[0.12em] uppercase">
            Collect from
          </h2>
          <p className="mt-1 text-lg font-semibold">{delivery.vendor_name}</p>
          <p className="text-muted text-sm">{delivery.vendor_location}</p>
          <a
            href={`tel:${delivery.vendor_phone}`}
            className="text-brand-700 mt-2 inline-block text-sm underline underline-offset-4"
          >
            Call the store
          </a>
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
              This order is still being prepared. It is yours — wait until the store marks it ready,
              then collect it. This page updates on its own.
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

      <div className="mt-4">
        <DeliveryActions delivery={delivery} isScan={isScan} />
      </div>
    </main>
  );
}
