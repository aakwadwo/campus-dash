import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCapabilities } from '@/lib/auth/session';
import { getActiveDelivery, getMyPickupCode } from '@/lib/partner';
import { formatPesewas } from '@/lib/util/money';
import DeliveryActions from './delivery-actions';

export const dynamic = 'force-dynamic';

export default async function PartnerDeliveryPage() {
  const me = await getCapabilities();
  if (!me.is_partner) redirect('/partner');

  const delivery = await getActiveDelivery();
  if (!delivery) redirect('/partner');

  // Only the assigned Partner can read this, and only while assigned.
  const pickupCode =
    delivery.delivery_status === 'ASSIGNED'
      ? await getMyPickupCode(delivery.order_id).catch(() => null)
      : null;

  const collecting = delivery.delivery_status === 'ASSIGNED';

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <Link href="/partner" className="text-muted text-sm underline underline-offset-4">
        ← Partner
      </Link>

      <header className="mt-3 mb-4">
        <p className="font-mono text-sm">{delivery.order_number}</p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {collecting ? 'Collect the order' : 'Deliver the order'}
        </h1>
        <p className="text-brand-700 mt-1 text-sm font-semibold">
          You earn {formatPesewas(delivery.earnings_pesewas)}
        </p>
      </header>

      {collecting ? (
        <>
          <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
            <h2 className="text-xs font-semibold tracking-wide uppercase">Go to</h2>
            <p className="mt-1 text-lg font-semibold">{delivery.vendor_name}</p>
            <p className="text-muted text-sm">{delivery.vendor_location}</p>
            <a
              href={`tel:${delivery.vendor_phone}`}
              className="text-brand-700 mt-2 inline-block text-sm underline underline-offset-4"
            >
              Call the stall
            </a>
          </section>

          <section className="bg-brand-500 text-ink mt-3 rounded-lg p-4">
            <h2 className="text-xs font-semibold tracking-wide uppercase opacity-90">
              Read this to the vendor
            </h2>
            <p className="mt-1 font-mono text-5xl font-bold tracking-[0.2em] tabular-nums">
              {pickupCode ?? '––––'}
            </p>
            <p className="mt-2 text-sm opacity-90">
              They type it in to release the food. Only then do you get the delivery address.
            </p>
          </section>

          <section className="text-muted mt-3 rounded-lg bg-white p-4 text-sm ring-1 ring-black/5">
            Delivering to <strong className="text-ink">{delivery.destination_zone}</strong>. The
            exact room appears once the vendor confirms the handoff.
          </section>
        </>
      ) : (
        <>
          <section className="rounded-lg bg-white p-4 ring-1 ring-black/5">
            <h2 className="text-xs font-semibold tracking-wide uppercase">Take it to</h2>
            <p className="mt-1 text-lg font-semibold">{delivery.destination}</p>
            {delivery.destination_note ? (
              <p className="mt-1 text-sm">“{delivery.destination_note}”</p>
            ) : null}
            <p className="text-muted mt-2 text-sm">{delivery.customer_name}</p>
            <a
              href={`tel:${delivery.customer_phone}`}
              className="text-brand-700 mt-1 inline-block text-sm underline underline-offset-4"
            >
              Call {delivery.customer_phone}
            </a>
          </section>

          <section className="text-muted mt-3 rounded-lg bg-white p-4 text-sm ring-1 ring-black/5">
            Ask the customer for their <strong className="text-ink">4-digit delivery code</strong>{' '}
            and enter it below. That is what completes the job and records your earning.
          </section>
        </>
      )}

      <div className="mt-4">
        <DeliveryActions delivery={delivery} />
      </div>
    </main>
  );
}
