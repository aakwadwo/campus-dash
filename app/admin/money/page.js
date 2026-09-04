import Link from 'next/link';
import { payments, webhookEvents, reconciliation, notificationLog } from '@/lib/admin';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable } from '../ui';

export const dynamic = 'force-dynamic';

/**
 * Four independent reads, caught independently.
 *
 * One failing query must not take the other three down with it: an operator
 * chasing a payment does not care that the notification log is unavailable, and
 * Promise.all rejecting would have thrown the whole page away for it.
 *
 * The reconciliation panel is the one that matters most. Its good outcome is an
 * EMPTY table, so a failed read rendering as empty would announce "✓ everything
 * reconciles" on the strength of a question we never managed to ask.
 */
export default async function AdminMoneyPage() {
  const [issues, paymentRows, webhooks, notifications] = await Promise.all([
    reconciliation(100).catch(() => null),
    payments(50).catch(() => null),
    webhookEvents(50).catch(() => null),
    notificationLog(50).catch(() => null),
  ]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Money</h1>
      <p className="text-muted mb-6 text-sm">
        Payments, provider events, and anything that does not add up.
      </p>

      <Panel
        title={issues === null ? 'Reconciliation' : `Reconciliation (${issues.length})`}
        description="Only discrepancies. An empty table here is the good outcome."
      >
        {issues === null ? (
          <Unavailable>
            Reconciliation could not be run. That is not a clean bill of health — nothing was
            checked.
          </Unavailable>
        ) : issues.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Order</th>
                <th className="pb-2 font-medium">Issue</th>
                <th className="pb-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue, i) => (
                <tr key={i} className="border-t border-black/5">
                  <td className="py-2">
                    <Link
                      href={`/admin/orders/${issue.order_id}`}
                      className="text-brand-700 font-mono underline underline-offset-4"
                    >
                      {issue.order_number}
                    </Link>
                  </td>
                  <td className="py-2">
                    <Badge tone="bad">{issue.issue}</Badge>
                  </td>
                  <td className="text-muted py-2">{issue.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-brand-700 py-4 text-center text-sm font-medium">
            ✓ Everything reconciles. Internal records match the provider.
          </p>
        )}
      </Panel>

      <Panel title="Payments">
        {paymentRows === null ? (
          <Unavailable>The payments could not be loaded.</Unavailable>
        ) : paymentRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th className="pb-2 font-medium">Order</th>
                  <th className="pb-2 font-medium">Amount</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Provider txn</th>
                  <th className="pb-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {paymentRows.map((payment) => (
                  <tr key={payment.payment_id} className="border-t border-black/5">
                    <td className="py-2">
                      <Link
                        href={`/admin/orders/${payment.order_id}`}
                        className="text-brand-700 font-mono underline underline-offset-4"
                      >
                        {payment.order_number}
                      </Link>
                    </td>
                    <td className="py-2 tabular-nums">{formatPesewas(payment.amount_pesewas)}</td>
                    <td className="py-2">
                      <Badge
                        tone={
                          payment.status === 'SUCCEEDED'
                            ? 'good'
                            : payment.status === 'FAILED'
                              ? 'bad'
                              : 'warn'
                        }
                      >
                        {payment.status}
                      </Badge>
                      {payment.failure_reason ? (
                        <span className="text-muted ml-2 text-xs">{payment.failure_reason}</span>
                      ) : null}
                    </td>
                    <td className="text-muted py-2 font-mono text-xs">
                      {payment.provider_transaction_id ?? '—'}
                    </td>
                    <td className="text-muted py-2 text-xs tabular-nums">
                      {new Date(payment.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No payments yet.</Empty>
        )}
      </Panel>

      <Panel title="Provider events" description="Deduplicated on the provider's own event id.">
        {webhooks === null ? (
          <Unavailable>The provider events could not be loaded.</Unavailable>
        ) : webhooks.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Signature</th>
                <th className="pb-2 font-medium">Received</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((event) => (
                <tr key={event.webhook_id} className="border-t border-black/5">
                  <td className="py-2 font-mono text-xs">{event.event_id}</td>
                  <td className="py-2">
                    <Badge
                      tone={
                        event.status === 'PROCESSED'
                          ? 'good'
                          : event.status === 'RECEIVED'
                            ? 'warn'
                            : 'bad'
                      }
                    >
                      {event.status}
                    </Badge>
                  </td>
                  <td className="py-2">
                    {event.signature_valid ? (
                      <Badge tone="good">valid</Badge>
                    ) : (
                      <Badge tone="bad">INVALID</Badge>
                    )}
                  </td>
                  <td className="text-muted py-2 text-xs tabular-nums">
                    {new Date(event.received_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No provider events yet.</Empty>
        )}
      </Panel>

      <Panel title="Notifications" description="What was sent, to whom, and whether it arrived.">
        {notifications === null ? (
          <Unavailable>The notification log could not be loaded.</Unavailable>
        ) : notifications.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 font-medium">To</th>
                <th className="pb-2 font-medium">Result</th>
                <th className="pb-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((notification) => (
                <tr key={notification.id} className="border-t border-black/5">
                  <td className="py-2 font-mono text-xs">
                    {notification.event}
                    <span className="text-muted"> · {notification.audience}</span>
                  </td>
                  <td className="py-2 tabular-nums">{notification.recipient}</td>
                  <td className="py-2">
                    {notification.succeeded ? (
                      <Badge tone="good">sent</Badge>
                    ) : (
                      <Badge tone="bad">failed</Badge>
                    )}
                  </td>
                  <td className="text-muted py-2 text-xs tabular-nums">
                    {new Date(notification.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing sent yet.</Empty>
        )}
      </Panel>
    </>
  );
}
