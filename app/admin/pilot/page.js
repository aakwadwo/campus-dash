import {
  pilotMetrics,
  failedNotifications,
  platformConfig,
  reconcileAgainstProvider,
} from '@/lib/admin';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty } from '../ui';
import ConfigForm from './config-form';

export const dynamic = 'force-dynamic';

/**
 * The pilot control room.
 *
 * Three things an operator needs daily: what happened, whether the money and
 * messages are healthy, and the knobs to change when the answer is "no".
 */
export default async function PilotPage() {
  const [metrics, failures, config, providerIssues] = await Promise.all([
    pilotMetrics(),
    failedNotifications(20),
    platformConfig(),
    reconcileAgainstProvider().catch(() => []),
  ]);

  const by = Object.fromEntries((metrics ?? []).map((m) => [m.metric, Number(m.value)]));
  const seconds = (value) => (value == null ? '-' : `${Math.round(value)}s`);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Pilot</h1>
      <p className="text-muted mb-6 text-sm">
        Today so far. These are the numbers the pilot exists to discover, and none of them can be
        guessed from a desk.
      </p>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Stat label="Orders placed" value={by.orders_placed ?? 0} />
        <Stat label="Completed" value={by.orders_completed ?? 0} />
        <Stat
          label="Collected"
          value={formatPesewas(by.collected_pesewas ?? 0)}
          detail={`${formatPesewas(by.unsettled_pesewas ?? 0)} unsettled`}
        />
      </div>

      <Panel
        title="How long everything takes"
        description="Medians. The assumptions most likely to be wrong."
      >
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Row label="Vendor answers in" value={seconds(by.median_vendor_response_seconds)} />
          <Row label="Customer pays in" value={seconds(by.median_customer_pay_seconds)} />
          <Row label="Food takes" value={seconds(by.median_prep_seconds)} />
          <Row label="Partner found in" value={seconds(by.median_partner_match_seconds)} />
          <Row label="Delivery takes" value={seconds(by.median_delivery_seconds)} />
        </dl>
      </Panel>

      <Panel title="Where it goes wrong">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Row label="Vendor never answered" value={by.orders_expired_no_vendor_answer ?? 0} />
          <Row label="Vendor rejected" value={by.orders_rejected ?? 0} />
          <Row label="No Partner found" value={by.deliveries_no_partner_found ?? 0} />
          <Row label="Partner cancellations" value={by.partner_cancellations ?? 0} />
          <Row label="Customer absent" value={by.deliveries_customer_absent ?? 0} />
          <Row label="Open disputes" value={by.disputes_open ?? 0} />
        </dl>
      </Panel>

      <Panel title="Partner supply" description="Right now, not over the period.">
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <Row label="Approved" value={by.partners_approved ?? 0} />
          <Row label="Online" value={by.partners_online_now ?? 0} />
          <Row label="On a delivery" value={by.partners_on_a_delivery_now ?? 0} />
        </dl>
      </Panel>

      <Panel
        title="Money and messages"
        description="Anything but zero in the last two rows needs looking at."
      >
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Row label="Settled" value={formatPesewas(by.settled_pesewas ?? 0)} />
          <Row label="Unsettled" value={formatPesewas(by.unsettled_pesewas ?? 0)} />
          <Row label="SMS sent" value={by.notifications_sent ?? 0} />
          <Row label="SMS per order" value={by.notifications_per_order ?? 0} />
          <Row
            label="Failed payouts"
            value={by.payouts_failed ?? 0}
            alert={by.payouts_failed > 0}
          />
          <Row
            label="Reconciliation issues"
            value={by.reconciliation_issues ?? 0}
            alert={by.reconciliation_issues > 0}
          />
        </dl>
      </Panel>

      <Panel
        title={`Provider reconciliation (${providerIssues?.length ?? 0})`}
        description="Our records against the payment provider's. Reads only; safe to refresh."
      >
        {providerIssues?.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Issue</th>
                <th className="pb-2 font-medium">Transaction</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {providerIssues.map((issue, i) => (
                <tr key={i} className="border-line border-t">
                  <td className="py-2">
                    <Badge tone="bad">{issue.issue}</Badge>
                  </td>
                  <td className="py-2 font-mono text-xs">{issue.provider_transaction_id ?? '-'}</td>
                  <td className="text-muted py-2">{issue.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-brand-700 py-4 text-center text-sm font-medium">
            ✓ Our records and the provider&apos;s agree.
          </p>
        )}
      </Panel>

      <Panel title={`Messages that did not arrive (${failures?.length ?? 0})`}>
        {failures?.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 font-medium">To</th>
                <th className="pb-2 font-medium">Attempts</th>
                <th className="pb-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((failure) => (
                <tr key={failure.id} className="border-line border-t">
                  <td className="py-2 font-mono text-xs">{failure.event}</td>
                  <td className="py-2 tabular-nums">{failure.recipient}</td>
                  <td className="py-2 tabular-nums">{failure.attempts}</td>
                  <td className="text-muted py-2 text-xs">{failure.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Every message got through.</Empty>
        )}
      </Panel>

      <Panel
        title="Pilot settings"
        description="Changing any of these is an administrative action, and is audited with your reason."
      >
        <ConfigForm config={config} />
      </Panel>
    </>
  );
}

function Stat({ label, value, detail }) {
  return (
    <div className="rounded-card bg-surface ring-line px-5 py-4 ring-1">
      <p className="text-muted text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail ? <p className="text-muted mt-1 text-sm">{detail}</p> : null}
    </div>
  );
}

function Row({ label, value, alert }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular-nums ${alert ? 'text-bad font-semibold' : ''}`}>{value}</dd>
    </div>
  );
}
