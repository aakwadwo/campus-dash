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
import { ButtonLink, Callout, Completion, ChevronRightIcon, Card, Disclosure } from '@/app/ui';

export const dynamic = 'force-dynamic';

const PAYOUT_STATUS = {
  PENDING: 'Scheduled',
  PROCESSING: 'On its way',
  FAILED: 'Delayed',
  CANCELLED: 'Cancelled',
  REVERSED: 'Delayed',
};

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

export default async function PartnerHome({ searchParams }) {
  const me = await getCapabilities();
  const application = await getMyApplication();

  // Not applied yet.
  if (!application) {
    return (
      <main className="mx-auto max-w-2xl px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <h1 className="text-display text-2xl font-semibold sm:text-3xl">
          Become a Campus Dash Partner
        </h1>
        <p className="text-muted mt-3 leading-relaxed">
          Partners help other students get what they need across Academic City, and earn on every
          order they bring. You choose when you are available.
        </p>
        <ul className="mt-5 space-y-2 text-sm">
          <li>You need your student ID and a phone.</li>
          <li>It adds to the account you already have.</li>
          <li>Someone at Campus Dash reads every application.</li>
        </ul>
        <ButtonLink href="/partner/apply" size="lg" block className="mt-7">
          Apply to be a Partner
        </ButtonLink>
      </main>
    );
  }

  if (application.status !== 'APPROVED') {
    const copy = STATUS_COPY[application.status] ?? STATUS_COPY.PENDING_REVIEW;
    return (
      <main className="mx-auto max-w-2xl px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        <h1 className="text-display text-2xl font-semibold sm:text-3xl">{copy.title}</h1>
        <p className="text-muted mt-3 leading-relaxed">{copy.body}</p>
        {application.review_notes ? (
          <Callout tone={application.status === 'REJECTED' ? 'bad' : 'neutral'} className="mt-4">
            {application.review_notes}
          </Callout>
        ) : null}
        <div className="mt-7 flex flex-wrap gap-3">
          {application.status === 'REJECTED' ? (
            <ButtonLink href="/partner/apply" size="lg">
              Apply again
            </ButtonLink>
          ) : null}
          <ButtonLink
            href="/order"
            size="lg"
            variant={application.status === 'REJECTED' ? 'secondary' : 'primary'}
          >
            Order food
          </ButtonLink>
        </div>
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

  // JUST FINISHED ONE. The delivery screen sends its id here once the order has
  // left this Partner's hands. It is looked up in their OWN history, so a
  // hand-typed id shows nothing, and a returned order (not in history) shows
  // nothing either.
  const params = await searchParams;
  const finishedId = typeof params?.finished === 'string' ? params.finished : null;
  const finished = finishedId ? (history ?? []).find((h) => h.order_id === finishedId) : null;

  return (
    <main className="mx-auto max-w-2xl px-4 pt-5 pb-16 sm:px-6 sm:pt-8">
      {finished ? (
        <Card className="mb-6 px-5 py-7">
          <Completion
            title={
              finished.delivery_status === 'DELIVERED'
                ? `Delivered #${orderLabel(finished)}`
                : `Closed #${orderLabel(finished)}`
            }
          >
            You earned{' '}
            <span className="text-ink font-semibold">
              {formatPesewas(finished.earnings_pesewas)}
            </span>
            . It is added to your earnings below.
          </Completion>
        </Card>
      ) : null}

      <h1 className="text-display text-2xl font-semibold sm:text-3xl">
        {me.first_name ? `Hello, ${me.first_name}` : 'Partner home'}
      </h1>

      <AvailabilityToggle available={application.is_available} hasActive={active.length > 0} />

      {/* EVERY ORDER IN HAND, LISTED. A Partner holding more than one is
          deciding which building to walk to next, and that decision needs all
          of them on screen rather than one hidden behind another. */}
      {active.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-3 font-semibold">
            {active.length === 1 ? 'Your delivery' : `Your deliveries (${active.length})`}
          </h2>
          <ul className="space-y-2.5">
            {active.map((job) => (
              <li key={job.order_id}>
                <Link
                  href={`/partner/delivery?order=${job.order_id}`}
                  className="press bg-brand-700 hover:bg-brand-800 rounded-card flex items-center gap-4 px-4 py-4 text-white transition-colors"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-white/90">
                      {job.delivery_status !== 'ASSIGNED'
                        ? 'On the way'
                        : job.food_is_ready
                          ? 'Ready to collect'
                          : 'Being prepared'}
                    </span>
                    <span className="mt-0.5 block text-2xl font-bold tabular-nums">
                      #{orderLabel(job)}
                    </span>
                    <span className="mt-1 block text-sm text-white/90">
                      {job.delivery_status === 'ASSIGNED'
                        ? job.food_is_ready
                          ? `Collect from ${job.vendor_name}`
                          : `${job.vendor_name} is still preparing it`
                        : `Take to ${job.destination ?? job.destination_zone}`}
                      {job.customer_first_name ? ` for ${job.customer_first_name}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold">
                    Open
                    <ChevronRightIcon className="ml-0.5 inline size-4 align-[-3px]" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* THE NEXT THING TO DO. Only offered when it can succeed. */}
      {application.is_available ? (
        atCapacity ? (
          <Callout tone="warn" className="mt-4">
            You are carrying {active.length} of {capacity.maxActive}, the most allowed right now.
            Finish one to take another.
          </Callout>
        ) : (
          <ButtonLink
            href="/partner/offers"
            size="lg"
            block
            variant={active.length ? 'secondary' : 'primary'}
            className="mt-4"
          >
            See available orders
          </ButtonLink>
        )
      ) : null}

      <Earnings earnings={earnings} payouts={payouts} />

      {/* Where the money goes. Shown here rather than buried in a settings
          screen, because a Partner with earnings and no destination is somebody
          who will not be paid, and they should find that out early. */}
      <section className="rounded-card bg-surface border-line mt-4 border p-5">
        <h2 className="font-semibold">Payout details</h2>
        {payout ? (
          <>
            <p className="mt-2 text-sm">
              {payout.momo_network} ending {payout.account_last3} &middot; {payout.account_name}
            </p>
            <p className="text-muted mt-1 text-sm">
              Your weekly payout is sent here. Tell Campus Dash support if it changes.
            </p>
          </>
        ) : (
          <Callout tone="warn" className="mt-3">
            No mobile money number on file yet. Campus Dash support will ask for one before your
            first payout.
          </Callout>
        )}
      </section>

      {history?.length ? (
        <section className="rounded-card bg-surface border-line mt-4 border p-5">
          <h2 className="mb-2 font-semibold">Recent deliveries</h2>
          <ul className="divide-line divide-y text-sm">
            {history.map((job) => (
              <li key={job.order_id} className="flex items-baseline justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="font-semibold tabular-nums">#{orderLabel(job)}</span>{' '}
                  <span className="text-muted">
                    {job.vendor_name ? `${job.vendor_name} to ` : ''}
                    {job.destination_zone}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums">
                  {formatPesewas(job.earnings_pesewas)}
                  {job.paid_out ? (
                    <span className="text-good"> · Paid</span>
                  ) : (
                    <span className="text-muted"> · Not paid yet</span>
                  )}
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
        <h2 className="font-semibold">Earnings</h2>
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
          {/* ONE LINE AT A GLANCE; the policy behind it is a tap away. */}
          <p className="text-muted mt-2.5 text-sm">
            {eligible
              ? 'Ready for the next weekly payout.'
              : `${formatPesewas(toGo)} to go until the weekly payout.`}
          </p>
        </div>
      ) : null}

      <Disclosure title="How earnings work" flush className="border-line mt-3 border-t">
        <p className="text-muted text-sm leading-relaxed">
          You earn the Campus Dash Partner fee for every order you complete. Payouts are processed
          weekly
          {threshold > 0 ? ` once your available earnings reach ${formatPesewas(threshold)}` : ''}.
          Anything below that carries forward to the next cycle, so nothing is lost.
        </p>
      </Disclosure>

      <dl className="border-line space-y-1 border-t pt-4 text-sm">
        <Row label="Orders completed" value={String(earnings?.delivered_count ?? 0)} />
        <Row label="Earned in total" value={formatPesewas(earnings?.earned_pesewas ?? 0)} />
        {inProgress > 0 ? (
          <Row label="Payout on its way" value={formatPesewas(inProgress)} />
        ) : null}
        <Row label="Already paid out" value={formatPesewas(earnings?.settled_pesewas ?? 0)} />
      </dl>

      {payouts?.length ? (
        <div className="border-line mt-4 border-t pt-4">
          <h3 className="mb-2 font-semibold">Payout history</h3>
          <ul className="divide-line divide-y text-sm">
            {payouts.map((p) => (
              <li key={p.payout_id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="text-muted">
                  {new Date(p.paid_at ?? p.created_at).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                  })}
                  {p.status === 'PAID'
                    ? ' · Paid'
                    : ` · ${PAYOUT_STATUS[p.status] ?? 'Processing'}`}
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
