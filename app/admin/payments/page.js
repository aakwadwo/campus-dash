import Link from 'next/link';
import { payments as listPayments, webhookEvents } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, when } from '../ui';

export const dynamic = 'force-dynamic';

const TXN_TONE = { SUCCEEDED: 'good', PENDING: 'warn', FAILED: 'bad', CANCELLED: 'neutral' };

/**
 * Payments — money coming in.
 *
 * READ ONLY, and that is the design. There is no button on this page that can
 * mark a payment successful, because there is no such admin function: a payment
 * moves on a signature-verified webhook or a server-to-server verify with the
 * provider, never because somebody in an office decided it had arrived. Adding
 * a "confirm" control here would be handing the office the provider's job.
 *
 * Provider credentials appear nowhere. The transaction id is an identifier the
 * provider already shares with the customer on their receipt.
 */
export default async function AdminPaymentsPage() {
  const [rows, hooks] = await Promise.all([
    listPayments(200).catch(() => null),
    webhookEvents(50).catch(() => null),
  ]);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Payments</h1>
      <p className="text-muted mb-6 text-sm">
        What customers have paid, and what the provider told us about it. Nothing here can be marked
        paid by hand. A payment moves on a verified provider event, never on an admin&apos;s say-so.
      </p>

      <Panel title="Payments" description={rows ? `${rows.length} shown` : undefined}>
        {rows === null ? (
          <Unavailable>Payments could not be loaded.</Unavailable>
        ) : rows.length === 0 ? (
          <Empty>No payments have been taken yet.</Empty>
        ) : (
          <Table
            head={[
              'Order',
              'Customer',
              'Provider',
              'Amount',
              'Status',
              'Reference',
              'Created',
              'Succeeded',
            ]}
            minWidth="58rem"
          >
            {rows.map((p) => (
              <Row key={p.payment_id ?? p.id}>
                <Cell>
                  {p.order_id ? (
                    <Link
                      href={`/admin/orders/${p.order_id}`}
                      className="text-brand-700 font-mono text-xs underline underline-offset-4"
                    >
                      {p.order_number}
                    </Link>
                  ) : (
                    <span className="font-mono text-xs">{p.order_number ?? '-'}</span>
                  )}
                </Cell>
                <Cell>{p.customer_name ?? '-'}</Cell>
                <Cell muted>{p.provider}</Cell>
                <Cell numeric>
                  <Cedis pesewas={p.amount_pesewas} />
                </Cell>
                <Cell>
                  <Badge tone={TXN_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                </Cell>
                <Cell mono muted>
                  {p.provider_transaction_id ?? '-'}
                </Cell>
                <Cell muted>{when(p.created_at)}</Cell>
                <Cell muted>{when(p.succeeded_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Recent provider events"
        description="Deduplicated on the provider's own event id. An invalid signature is recorded and never acted on."
      >
        {hooks === null ? (
          <Unavailable>Webhook history could not be loaded.</Unavailable>
        ) : hooks.length === 0 ? (
          <Empty>No provider events received yet.</Empty>
        ) : (
          <Table
            head={['Provider', 'Event', 'Signature', 'Status', 'Received', 'Error']}
            minWidth="46rem"
          >
            {hooks.map((h) => (
              <Row key={h.webhook_id ?? h.id}>
                <Cell muted>{h.provider}</Cell>
                <Cell mono>{h.event_id}</Cell>
                <Cell>
                  <Badge tone={h.signature_valid ? 'good' : 'bad'}>
                    {h.signature_valid ? 'valid' : 'INVALID'}
                  </Badge>
                </Cell>
                <Cell>
                  <Badge
                    tone={
                      h.status === 'PROCESSED' ? 'good' : h.status === 'FAILED' ? 'bad' : 'neutral'
                    }
                  >
                    {h.status}
                  </Badge>
                </Cell>
                <Cell muted>{when(h.received_at)}</Cell>
                <Cell muted>{h.error ?? '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
