import { notificationLog, failedNotifications } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, when } from '../ui';

export const dynamic = 'force-dynamic';

/**
 * Notifications — what we sent, and whether it arrived.
 *
 * PROVIDER ACCEPTANCE IS NOT DELIVERY. A 200 from Arkesel means the message was
 * taken, not that a handset received it; the outcome arrives later on the
 * delivery webhook and lands on the same row. So "sent" and "delivered" are two
 * different columns here, and a message can be the first without ever becoming
 * the second.
 *
 * Message BODIES are not shown. A one-time passcode is in there, and a support
 * screen is not a reason to put it on a second display.
 */
export default async function AdminNotificationsPage() {
  const [failed, log] = await Promise.all([
    failedNotifications(100).catch(() => null),
    notificationLog(200).catch(() => null),
  ]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Notifications</h1>
      <p className="text-muted mb-6 text-sm">
        Provider acceptance is not delivery. A message the provider took can still fail to arrive.
        the delivery report updates the same row later.
      </p>

      <Panel
        title={`Failed to send (${failed?.length ?? 0})`}
        description="These never reached the provider at all."
      >
        {failed === null ? (
          <Unavailable>Failed notifications could not be loaded.</Unavailable>
        ) : failed.length === 0 ? (
          <Empty>Nothing failed to send.</Empty>
        ) : (
          <Table head={['Event', 'Audience', 'Recipient', 'Error', 'When']} minWidth="46rem">
            {failed.map((n, i) => (
              <Row key={n.notification_id ?? i}>
                <Cell mono>{n.event}</Cell>
                <Cell muted>{n.audience}</Cell>
                <Cell mono muted>
                  {n.recipient}
                </Cell>
                <Cell muted>{n.error ?? '-'}</Cell>
                <Cell muted>{when(n.created_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Recent messages"
        description="Newest first. Message bodies are deliberately not shown."
      >
        {log === null ? (
          <Unavailable>The notification log could not be loaded.</Unavailable>
        ) : log.length === 0 ? (
          <Empty>No messages have been sent yet.</Empty>
        ) : (
          <Table
            head={['Event', 'Audience', 'Channel', 'Recipient', 'Sent', 'Delivery', 'When']}
            minWidth="54rem"
          >
            {log.map((n, i) => (
              <Row key={n.notification_id ?? i}>
                <Cell mono>{n.event}</Cell>
                <Cell muted>{n.audience}</Cell>
                <Cell muted>{n.channel}</Cell>
                <Cell mono muted>
                  {n.recipient}
                </Cell>
                <Cell>
                  <Badge tone={n.succeeded ? 'good' : 'bad'}>
                    {n.succeeded ? 'accepted' : 'failed'}
                  </Badge>
                </Cell>
                <Cell>
                  {n.delivery_status ? (
                    <Badge tone={n.delivery_status === 'DELIVERED' ? 'good' : 'warn'}>
                      {n.delivery_status}
                    </Badge>
                  ) : (
                    <span className="text-muted text-xs">no report yet</span>
                  )}
                </Cell>
                <Cell muted>{when(n.created_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
