import Link from 'next/link';
import { getCapabilities } from '@/lib/auth/session';
import {
  getMyApplication,
  getActiveDeliveries,
  getEarnings,
  getHistory,
  getCapacity,
  getPayoutDestination,
  getPayouts,
} from '@/lib/partner';
import { formatPesewas } from '@/lib/util/money';
import { orderLabel } from '@/lib/orders/state';
import AvailabilityToggle from './availability-toggle';

export const dynamic = 'force-dynamic';

const STATUS_COPY = {
  PENDING_REVIEW: {
    title: 'Application under review',
    body: 'Someone at Campus Dash is checking your student ID. You will get an SMS when there is a decision.',
  },
  REJECTED: {
    title: 'Application not approved',
    body: 'You can still order as a customer. Contact Campus Dash support if you think this is a mistake.',
  },
  SUSPENDED: {
    title: 'Partner access suspended',
    body: 'You cannot accept orders at the moment. Contact Campus Dash support.',
  },
};

export default async function PartnerHome() {
  const me = await getCapabilities();
  const application = await getMyApplication();

  // Not applied yet.
  if (!application) {
    return (
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight">Become a Campus Dash Partner</h1>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Partners help other students get what they need across Academic City, and earn on every
          order they bring. You choose when you are available, and you keep the delivery fee.
        </p>
        <ul className="text-muted mt-4 space-y-1.5 text-sm">
          <li>You need a student ID and a phone.</li>
          <li>You already have the account. This adds to it.</li>
          <li>Someone at Campus Dash reads every application.</li>
        </ul>
        <Link
          href="/partner/apply"
          className="press bg-brand-700 hover:bg-brand-800 mt-6 block rounded-full py-4 text-center text-base font-semibold text-white transition-colors"
        >
          Apply to be a Partner
        </Link>
      </main>
    );
  }

  if (application.status !== 'APPROVED') {
    const copy = STATUS_COPY[application.status] ?? STATUS_COPY.PENDING_REVIEW;
    return (
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted mt-2 text-sm leading-relaxed">{copy.body}</p>
        {application.review_notes ? (
          <p className="rounded-card bg-surface border-line mt-3 border px-4 py-3 text-sm">
            {application.review_notes}
          </p>
        ) : null}
        {application.status === 'REJECTED' ? (
          <Link
            href="/partner/apply"
            className="press bg-surface border-line-strong mt-6 block rounded-full border py-3 text-center text-sm font-semibold transition-colors"
          >
            Apply again
          </Link>
        ) : null}
      </main>
    );
  }

  const [active, earnings, history, capacity, payout, payouts] = await Promise.all([
    getActiveDeliveries(),
    getEarnings(),
    getHistory(10),
    getCapacity(),
    getPayoutDestination(),
    getPayouts(6),
  ]);
  const atCapacity = active.length >= capacity.maxActive;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-16">
      <h1 className="text-xl font-semibold tracking-tight">
        {me.first_name ? `Hello, ${me.first_name}` : 'Partner'}
      </h1>

      <AvailabilityToggle available={application.is_available} hasActive={active.length > 0} />

      {/* EVERY ORDER IN HAND, LISTED. A Partner holding more than one is
          deciding which building to walk to next, and that decision needs all
          of them on screen rather than one hidden behind another. How many they
          may hold is set by an administrator, not by this file. */}
      {active.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {active.map((job) => (
            <li key={job.order_id}>
              <Link
                href={`/partner/delivery?order=${job.order_id}`}
                className="bg-brand-700 rounded-card block px-4 py-4 text-white"
              >
                <p className="text-sm opacity-90">
                  {job.delivery_status !== 'ASSIGNED'
                    ? 'On the way'
                    : job.food_is_ready
                      ? 'Ready to collect'
                      : 'Being prepared'}
                </p>
                <p className="mt-0.5 text-2xl font-bold tabular-nums">#{orderLabel(job)}</p>
                <p className="mt-1 text-sm opacity-90">
                  {job.delivery_status === 'ASSIGNED'
                    ? job.food_is_ready
                      ? `Collect from ${job.vendor_name}`
                      : `${job.vendor_name} is still preparing it`
                    : `Take to ${job.destination ?? job.destination_zone}`}
                  {job.customer_first_name ? ` for ${job.customer_first_name}` : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {atCapacity ? (
        <p className="rounded-card bg-warn-bg text-warn mt-3 px-4 py-3 text-sm">
          You are carrying {active.length} of {capacity.maxActive}, which is the limit right now.
          Finish one to take another.
        </p>
      ) : (
        <Link
          href="/partner/offers"
          className="press bg-surface border-line hover:bg-surface-2 mt-3 block rounded-full border px-4 py-4 text-center font-semibold transition-colors"
        >
          See available orders
        </Link>
      )}

      <Earnings earnings={earnings} payouts={payouts} />

      {/* Where the money goes. Shown here rather than buried in a settings
          screen, because a Partner with earnings and no destination is somebody
          who will not be paid, and they should find that out early. */}
      <section className="rounded-card bg-surface border-line mt-4 border p-4">
        <h2 className="text-xs font-semibold tracking-[0.12em] uppercase">Payout details</h2>
        {payout ? (
          <>
            <p className="mt-2 text-sm">
              {payout.momo_network} ending {payout.account_last3} &middot; {payout.account_name}
            </p>
            <p className="text-muted mt-1 text-xs">
              This is where your weekly payout is sent. Tell Campus Dash support if it changes.
            </p>
          </>
        ) : (
          <p className="text-muted mt-2 text-sm leading-relaxed">
            No mobile money number on file yet. Campus Dash support will ask for one before your
            first payout.
          </p>
        )}
      </section>

      {history?.length ? (
        <section className="rounded-card bg-surface border-line mt-4 border p-4">
          <h2 className="mb-2 text-xs font-semibold tracking-[0.12em] uppercase">Recent orders</h2>
          <ul className="divide-line divide-y text-sm">
            {history.map((job) => (
              <li key={job.order_id} className="flex items-baseline justify-between gap-3 py-2">
                <span>
                  <span className="text-xs tabular-nums">#{orderLabel(job)}</span>{' '}
                  <span className="text-muted">{job.destination_zone}</span>
                </span>
                <span className="tabular-nums">
                  {formatPesewas(job.earnings_pesewas)}
                  {job.paid_out ? '' : <span className="text-muted"> · pending</span>}
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

/**
 * Earnings, and the weekly payout policy.
 *
 * WHAT THIS DELIBERATELY DOES NOT SAY. There is no mention of a payment
 * provider, a transfer minimum, or anything Campus Dash cannot do. A Partner
 * reads a normal weekly payout policy: earnings accumulate, payouts run weekly,
 * a balance under the threshold carries forward. That is a true and complete
 * account of what happens to their money, and the provider's constraints are
 * Campus Dash's problem rather than an explanation owed to somebody who has
 * done the work.
 *
 * `available` and `in_progress` are shown as different things because they are:
 * one is a balance the next run will consider, the other is already on its way.
 */
function Earnings({ earnings, payouts }) {
  const available = Number(earnings?.available_pesewas ?? 0);
  const inProgress = Number(earnings?.in_progress_pesewas ?? 0);
  const threshold = Number(earnings?.payout_threshold_pesewas ?? 0);
  const toGo = Number(earnings?.pesewas_to_threshold ?? 0);
  const eligible = Boolean(earnings?.eligible_for_payout);
  const ratings = Number(earnings?.rating_count ?? 0);

  return (
    <section className="rounded-card bg-surface border-line mt-6 border p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-muted text-xs font-semibold tracking-[0.12em] uppercase">
          Your earnings
        </h2>
        {ratings > 0 ? (
          <p className="text-muted text-xs">
            <span className="text-ink font-semibold tabular-nums">
              {Number(earnings.average_stars).toFixed(1)}
            </span>{' '}
            from {ratings} {ratings === 1 ? 'rating' : 'ratings'}
          </p>
        ) : null}
      </div>

      <p className="text-display mt-2 text-4xl font-semibold tabular-nums">
        {formatPesewas(available)}
      </p>
      <p className="text-muted mt-1 text-sm">Available now</p>

      {threshold > 0 ? (
        <div className="mt-4">
          <div className="bg-surface-2 h-1.5 w-full rounded-full">
            <div
              className="bg-brand-500 h-1.5 rounded-full"
              style={{ width: `${Math.min(100, Math.round((available / threshold) * 100))}%` }}
              role="progressbar"
              aria-valuenow={Math.min(available, threshold)}
              aria-valuemin={0}
              aria-valuemax={threshold}
              aria-label="Progress towards the weekly payout amount"
            />
          </div>
          <p className="text-muted mt-2.5 text-sm leading-relaxed">
            {eligible
              ? `Payouts are processed weekly. Your earnings are ready to be paid in the next payout.`
              : `Payouts are processed weekly when your available earnings reach ${formatPesewas(threshold)}. ` +
                `${formatPesewas(toGo)} to go, and anything below that carries forward to the next cycle.`}
          </p>
        </div>
      ) : null}

      <dl className="border-line mt-4 space-y-1 border-t pt-4 text-sm">
        <Row label="Orders completed" value={String(earnings?.delivered_count ?? 0)} />
        <Row label="Earned in total" value={formatPesewas(earnings?.earned_pesewas ?? 0)} />
        {inProgress > 0 ? (
          <Row label="Payout on its way" value={formatPesewas(inProgress)} />
        ) : null}
        <Row label="Already paid out" value={formatPesewas(earnings?.settled_pesewas ?? 0)} />
      </dl>

      {payouts?.length ? (
        <div className="border-line mt-4 border-t pt-4">
          <h3 className="text-muted mb-2 text-xs font-semibold tracking-[0.12em] uppercase">
            Payout history
          </h3>
          <ul className="divide-line divide-y text-sm">
            {payouts.map((p) => (
              <li key={p.payout_id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="text-muted">
                  {new Date(p.paid_at ?? p.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                  {p.status === 'PAID' ? '' : ` · ${p.status.toLowerCase()}`}
                </span>
                <span className="tabular-nums">{formatPesewas(p.amount_pesewas)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
