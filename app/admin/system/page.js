import { dashboard, scheduledJobStatus, webhookEvents, reconciliation } from '@/lib/admin';
import { getPlatformConfig } from '@/lib/platform-config';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Stat,
  StatGrid,
  Facts,
  Fact,
  when,
} from '../ui';

export const dynamic = 'force-dynamic';

/**
 * System health.
 *
 * Everything here is OBSERVED, never asserted. "Payments: paystack" is what the
 * running deployment is configured with, not a claim that Paystack is up — this
 * page reports what we can see from inside the process and does not invent a
 * green tick for anything it has not actually checked.
 *
 * No secret, key or credential appears on this page or in the queries behind it.
 */
export default async function AdminSystemPage() {
  const [data, jobs, hooks, recon, config] = await Promise.all([
    dashboard().catch(() => null),
    scheduledJobStatus().catch(() => null),
    webhookEvents(50).catch(() => null),
    reconciliation(50).catch(() => null),
    getPlatformConfig().catch(() => null),
  ]);

  const system = data?.system ?? {};
  const invalid = Number(system.webhooks_invalid_24h ?? 0);
  const failedNotifications = Number(system.notifications_failed_24h ?? 0);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">System</h1>
      <p className="text-muted mb-6 text-sm">
        What this deployment can see about itself. Nothing here is a claim about a provider being up
        — only about what has actually reached us.
      </p>

      <StatGrid>
        <Stat
          label="Webhooks (24h)"
          value={system.webhooks_24h ?? 0}
          hint={`${invalid} rejected for a bad signature`}
          tone={invalid > 0 ? 'warn' : 'neutral'}
        />
        <Stat
          label="Notifications (24h)"
          value={system.notifications_24h ?? 0}
          hint={`${failedNotifications} failed to send`}
          tone={failedNotifications > 0 ? 'warn' : 'neutral'}
        />
        <Stat label="Admin actions (24h)" value={system.admin_actions_24h ?? 0} />
        <Stat
          label="Ledger discrepancies"
          value={recon === null ? '—' : recon.length}
          tone={recon && recon.length > 0 ? 'bad' : 'good'}
        />
      </StatGrid>

      <Panel
        title="Configuration in force"
        description="Operational numbers live in the database, not in code."
      >
        {config === null ? (
          <Unavailable>Configuration could not be read.</Unavailable>
        ) : (
          <Facts>
            <Fact
              label="Food service fee"
              value={`${(config.service_fee_bps / 100).toFixed(2)}% of the food subtotal`}
            />
            <Fact
              label="Scan service fee"
              value={
                config.scan_service_fee_pesewas == null ? (
                  <span className="text-red-700">Not configured — scan ordering will refuse</span>
                ) : (
                  `GH₵${(Number(config.scan_service_fee_pesewas) / 100).toFixed(2)} flat`
                )
              }
            />
            <Fact
              label="Delivery fee"
              value={`GH₵${(Number(config.delivery_fee_pesewas) / 100).toFixed(2)}`}
            />
            <Fact
              label="Partner share of delivery"
              value={`${config.partner_share_of_delivery_bps / 100}%`}
            />
            <Fact label="Vendor answer window" value={`${config.vendor_response_seconds}s`} />
            <Fact label="Partner search window" value={`${config.partner_search_seconds}s`} />
            <Fact label="Payment timeout" value={`${config.payment_pending_timeout_seconds}s`} />
            <Fact label="Document link lifetime" value={`${config.document_signed_url_seconds}s`} />
          </Facts>
        )}
      </Panel>

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
                <Cell muted>{when(job.last_run_at)}</Cell>
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

      <Panel
        title="Money that does not add up"
        description="Only discrepancies. An empty table here is the good outcome."
      >
        {recon === null ? (
          <Unavailable>Reconciliation could not be run.</Unavailable>
        ) : recon.length === 0 ? (
          <Empty>✓ Everything reconciles. Internal records match the provider.</Empty>
        ) : (
          <Table head={['Order', 'Issue', 'Detail', 'When']} minWidth="42rem">
            {recon.map((r, i) => (
              <Row key={i}>
                <Cell mono>{r.order_number}</Cell>
                <Cell>
                  <Badge tone="bad">{r.issue}</Badge>
                </Cell>
                <Cell muted>{r.detail}</Cell>
                <Cell muted>{when(r.created_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Recent provider events">
        {hooks === null ? (
          <Unavailable>Webhook history could not be loaded.</Unavailable>
        ) : hooks.length === 0 ? (
          <Empty>No provider events received yet.</Empty>
        ) : (
          <Table head={['Provider', 'Event', 'Signature', 'Status', 'Received']} minWidth="44rem">
            {hooks.map((h, i) => (
              <Row key={h.webhook_id ?? i}>
                <Cell muted>{h.provider}</Cell>
                <Cell mono>{h.event_id}</Cell>
                <Cell>
                  <Badge tone={h.signature_valid ? 'good' : 'bad'}>
                    {h.signature_valid ? 'valid' : 'INVALID'}
                  </Badge>
                </Cell>
                <Cell>{h.status}</Cell>
                <Cell muted>{when(h.received_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
