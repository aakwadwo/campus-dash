import Link from 'next/link';
import { getCapabilities } from '@/lib/auth/session';
import { getMyApplication, getActiveDelivery, getEarnings, getHistory } from '@/lib/partner';
import { formatPesewas } from '@/lib/util/money';
import AvailabilityToggle from './availability-toggle';

export const dynamic = 'force-dynamic';

const STATUS_COPY = {
  PENDING_REVIEW: {
    title: 'Application under review',
    body: 'An admin is comparing your photograph with your student ID. You will get an SMS when there is a decision.',
  },
  REJECTED: {
    title: 'Application not approved',
    body: 'You can still order as a customer. Contact Campus Dash support if you think this is a mistake.',
  },
  SUSPENDED: {
    title: 'Partner access suspended',
    body: 'You cannot accept deliveries. Contact Campus Dash support.',
  },
};

export default async function PartnerHome() {
  const me = await getCapabilities();
  const application = await getMyApplication();

  // Not applied yet.
  if (!application) {
    return (
      <main className="mx-auto max-w-md px-4 pt-6 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight">Deliver with Campus Dash</h1>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Pick up orders from stalls around Academic City and bring them to other students. You keep
          the delivery fee on every job you complete.
        </p>
        <ul className="text-muted mt-4 space-y-1 text-sm">
          <li>· You need a student ID and a phone.</li>
          <li>· One delivery at a time.</li>
          <li>· An admin checks every application by hand.</li>
        </ul>
        <Link
          href="/partner/apply"
          className="bg-brand-600 mt-6 block rounded-lg py-4 text-center text-base font-semibold text-white"
        >
          Apply to be a Partner
        </Link>
      </main>
    );
  }

  if (application.status !== 'APPROVED') {
    const copy = STATUS_COPY[application.status] ?? STATUS_COPY.PENDING_REVIEW;
    return (
      <main className="mx-auto max-w-md px-4 pt-6 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted mt-2 text-sm leading-relaxed">{copy.body}</p>
        {application.review_notes ? (
          <p className="mt-3 rounded-lg bg-white px-4 py-3 text-sm ring-1 ring-black/5">
            {application.review_notes}
          </p>
        ) : null}
        {application.status === 'REJECTED' ? (
          <Link
            href="/partner/apply"
            className="mt-6 block rounded-lg bg-white py-3 text-center text-sm font-semibold ring-1 ring-black/15"
          >
            Apply again
          </Link>
        ) : null}
      </main>
    );
  }

  const [active, earnings, history] = await Promise.all([
    getActiveDelivery(),
    getEarnings(),
    getHistory(10),
  ]);

  return (
    <main className="mx-auto max-w-md px-4 pt-5 pb-16">
      <h1 className="text-xl font-semibold tracking-tight">{me.full_name ?? 'Partner'}</h1>

      <AvailabilityToggle available={application.is_available} hasActive={Boolean(active)} />

      {active ? (
        <Link
          href="/partner/delivery"
          className="bg-brand-600 mt-4 block rounded-lg px-4 py-4 text-white"
        >
          <p className="text-sm opacity-90">You are carrying an order</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">{active.order_number}</p>
          <p className="mt-1 text-sm opacity-90">
            {active.delivery_status === 'ASSIGNED'
              ? `Collect from ${active.vendor_name}`
              : `Deliver to ${active.destination ?? active.destination_zone}`}
          </p>
        </Link>
      ) : (
        <Link
          href="/partner/offers"
          className="mt-4 block rounded-lg bg-white px-4 py-4 text-center font-semibold ring-1 ring-black/5"
        >
          See available deliveries
        </Link>
      )}

      <section className="mt-6 rounded-lg bg-white p-4 ring-1 ring-black/5">
        <h2 className="mb-3 text-xs font-semibold tracking-wide uppercase">Your earnings</h2>
        <dl className="space-y-1 text-sm">
          <Row label="Deliveries completed" value={String(earnings?.delivered_count ?? 0)} />
          <Row label="Earned" value={formatPesewas(earnings?.earned_pesewas ?? 0)} />
          <Row label="Awaiting payout" value={formatPesewas(earnings?.awaiting_pesewas ?? 0)} />
          <Row label="Already paid out" value={formatPesewas(earnings?.settled_pesewas ?? 0)} />
        </dl>
        <p className="text-muted mt-3 text-xs">Partners are paid weekly.</p>
      </section>

      {history?.length ? (
        <section className="mt-4 rounded-lg bg-white p-4 ring-1 ring-black/5">
          <h2 className="mb-2 text-xs font-semibold tracking-wide uppercase">Recent deliveries</h2>
          <ul className="divide-y divide-black/5 text-sm">
            {history.map((job) => (
              <li key={job.order_id} className="flex items-baseline justify-between gap-3 py-2">
                <span>
                  <span className="font-mono text-xs">{job.order_number}</span>{' '}
                  <span className="text-muted">{job.destination_zone}</span>
                </span>
                <span className="tabular-nums">
                  {formatPesewas(job.earnings_pesewas)}
                  {job.paid_out ? '' : ' ·'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
