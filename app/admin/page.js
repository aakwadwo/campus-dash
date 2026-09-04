import Link from 'next/link';
import { dashboard, scheduledJobStatus } from '@/lib/admin';
import { Panel, Stat, StatGrid, Badge, Empty, Unavailable, Cedis, Table, Row, Cell } from './ui';

export const dynamic = 'force-dynamic';

/**
 * The operating console.
 *
 * Four questions, in the order an operator asks them on a bad morning:
 * what needs me, what is happening, where is the money, and is anything broken.
 *
 * EVERY NUMBER IS COUNTED. There are no estimates, no projections and no
 * sampled figures anywhere on this page — an empty pilot reports zeros, and
 * zero is a true answer rather than a placeholder.
 */
export default async function AdminOverviewPage() {
  const [data, jobs] = await Promise.all([
    dashboard().catch(() => null),
    scheduledJobStatus().catch(() => null),
  ]);

  // Null means the database declined, not that the business is empty. Saying
  // "0 orders" when we actually failed to ask would be a lie an operator could
  // act on.
  if (!data) {
    return (
      <>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Unavailable>
          The dashboard could not be loaded. This is not the same as there being no activity — do
          not treat it as an empty day.
        </Unavailable>
      </>
    );
  }

  const ops = data.operations ?? {};
  const money = data.money ?? {};
  const people = data.people ?? {};
  const system = data.system ?? {};

  const attention = Number(ops.needs_attention ?? 0);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        {attention > 0 ? (
          <Link
            href="/admin/disputes"
            className="rounded-lg bg-red-50 px-4 py-2 text-sm font-semibold text-red-700 ring-1 ring-red-200"
          >
            {attention} {attention === 1 ? 'order needs' : 'orders need'} a decision →
          </Link>
        ) : (
          <span className="text-brand-700 text-sm font-medium">Nothing is waiting on you.</span>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      <h2 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Operations</h2>
      <StatGrid>
        <Stat label="Orders today" value={ops.orders_today ?? 0} href="/admin/orders" />
        <Stat
          label="Active food"
          value={ops.active_food ?? 0}
          href="/admin/orders?type=FOOD"
          hint="Not yet completed or closed"
        />
        <Stat
          label="Active scan"
          value={ops.active_scan ?? 0}
          href="/admin/orders?type=SCAN"
          hint="Errands in flight"
        />
        <Stat
          label="Searching for Partner"
          value={ops.searching ?? 0}
          href="/admin/orders?attention=SEARCHING_PARTNER"
          tone={Number(ops.searching) > 0 ? 'warn' : 'neutral'}
        />
        <Stat label="Assigned deliveries" value={ops.assigned ?? 0} />
        <Stat
          label="No Partner found"
          value={ops.no_partner ?? 0}
          href="/admin/orders?attention=NO_PARTNER"
          tone={Number(ops.no_partner) > 0 ? 'bad' : 'neutral'}
        />
        <Stat
          label="Scan refused"
          value={ops.scan_refused ?? 0}
          href="/admin/orders?attention=SCAN_REFUSED"
          tone={Number(ops.scan_refused) > 0 ? 'bad' : 'neutral'}
          hint="Restaurant would not honour"
        />
        <Stat
          label="Needs a decision"
          value={attention}
          href="/admin/disputes"
          tone={attention > 0 ? 'bad' : 'good'}
        />
      </StatGrid>

      {/* ---------------------------------------------------------------- */}
      <h2 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Money</h2>
      <StatGrid>
        <Stat
          label="Collected"
          value={<Cedis pesewas={money.collected_pesewas} />}
          hint={`${money.payments_count ?? 0} successful payments`}
          href="/admin/payments"
        />
        <Stat
          label="Owed to vendors"
          value={<Cedis pesewas={money.vendor_owed} />}
          href="/admin/finance?payee=VENDOR"
        />
        <Stat
          label="Owed to Partners"
          value={<Cedis pesewas={money.partner_owed} />}
          href="/admin/finance?payee=PARTNER"
        />
        {/* REVENUE AND LIABILITY, SIDE BY SIDE AND NEVER ADDED UP.
            Both numbers come out of the same PLATFORM allocation row, because
            at payment time there is no Partner to allocate to yet. The first is
            ours; the second is a delivery fee we are holding for whoever
            completes the delivery. Showing only their sum — which this tile
            used to do — overstates platform revenue by the delivery fee of
            every order still in flight. */}
        <Stat
          label="Platform earned"
          value={<Cedis pesewas={money.platform_earned} />}
          hint="Service fees we have actually earned, before Paystack costs"
          href="/admin/finance?payee=PLATFORM"
        />
        <Stat
          label="Delivery fees held"
          value={<Cedis pesewas={money.delivery_fees_held} />}
          hint="Owed to Partners on deliveries not yet completed — not ours"
          tone={Number(money.delivery_fees_held) > 0 ? 'warn' : 'neutral'}
          href="/admin/finance?payee=PLATFORM"
        />
        <Stat
          label="Payouts pending"
          value={<Cedis pesewas={money.payouts_pending} />}
          href="/admin/settlements"
        />
        <Stat
          label="Payouts processing"
          value={<Cedis pesewas={money.payouts_processing} />}
          href="/admin/settlements"
        />
        <Stat
          label="Payouts failed"
          value={<Cedis pesewas={money.payouts_failed} />}
          tone={Number(money.payouts_failed) > 0 ? 'bad' : 'neutral'}
          href="/admin/settlements"
        />
        <Stat
          label="Refunded / pending"
          value={
            <>
              <Cedis pesewas={money.refunded_pesewas} />
              <span className="text-muted text-sm"> / </span>
              <Cedis pesewas={money.refund_pending_pesewas} />
            </>
          }
          tone={Number(money.refund_pending_pesewas) > 0 ? 'warn' : 'neutral'}
        />
      </StatGrid>

      {/* ---------------------------------------------------------------- */}
      <h2 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">People</h2>
      <StatGrid>
        <Stat label="Customers" value={people.customers ?? 0} href="/admin/customers" />
        <Stat
          label="Partners"
          value={people.partners ?? 0}
          hint={`${people.partners_online ?? 0} online now`}
          href="/admin/partners"
        />
        <Stat
          label="Awaiting verification"
          value={people.partners_pending ?? 0}
          tone={Number(people.partners_pending) > 0 ? 'warn' : 'neutral'}
          href="/admin/partners?status=PENDING_REVIEW"
        />
        <Stat
          label="Vendors"
          value={people.vendors ?? 0}
          hint={`${people.vendors_active ?? 0} active · ${people.vendors_scan ?? 0} take scans`}
          href="/admin/vendors"
        />
        <Stat
          label="Suspended accounts"
          value={people.suspended ?? 0}
          tone={Number(people.suspended) > 0 ? 'warn' : 'neutral'}
        />
      </StatGrid>

      {/* ---------------------------------------------------------------- */}
      <h2 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">System</h2>
      <StatGrid>
        <Stat
          label="Webhooks (24h)"
          value={system.webhooks_24h ?? 0}
          hint={`${system.webhooks_invalid_24h ?? 0} with a bad signature`}
          tone={Number(system.webhooks_invalid_24h) > 0 ? 'warn' : 'neutral'}
          href="/admin/system"
        />
        <Stat
          label="Notifications (24h)"
          value={system.notifications_24h ?? 0}
          hint={`${system.notifications_failed_24h ?? 0} failed`}
          tone={Number(system.notifications_failed_24h) > 0 ? 'warn' : 'neutral'}
          href="/admin/notifications"
        />
        <Stat
          label="Admin actions (24h)"
          value={system.admin_actions_24h ?? 0}
          href="/admin/audit"
        />
        <Stat
          label="Scan pricing"
          value={system.scan_fee_configured ? 'Configured' : 'Not set'}
          tone={system.scan_fee_configured ? 'good' : 'bad'}
          hint={system.scan_fee_configured ? undefined : 'Scan ordering will refuse'}
          href="/admin/pilot"
        />
      </StatGrid>

      <Panel
        title="Scheduled jobs"
        description="A scheduler that silently stops looks like an application bug."
      >
        {jobs === null ? (
          <Unavailable>Job status could not be read.</Unavailable>
        ) : jobs.length === 0 ? (
          <Empty>No scheduled jobs are registered.</Empty>
        ) : (
          <Table head={['Job', 'Schedule', 'Last run', 'Status']} minWidth="34rem">
            {jobs.map((job) => (
              <Row key={job.jobname}>
                <Cell mono>{job.jobname}</Cell>
                <Cell mono muted>
                  {job.schedule}
                </Cell>
                <Cell muted>
                  {job.last_run_at ? new Date(job.last_run_at).toLocaleTimeString('en-GB') : '—'}
                </Cell>
                <Cell>
                  <Badge tone={job.last_status === 'succeeded' ? 'good' : 'bad'}>
                    {job.last_status ?? 'never run'}
                  </Badge>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
