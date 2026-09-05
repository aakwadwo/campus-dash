import Link from 'next/link';
import { exceptions } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, ATTENTION, when } from '../ui';

export const dynamic = 'force-dynamic';

/**
 * The exceptions queue — everything waiting on a person.
 *
 * Four sources in one list: orders whose state is already a problem, payouts
 * that failed, and anything the ledger cannot explain.
 *
 * THE POINT OF THE "REQUIRES A DECISION" COLUMN. Campus Dash has no refund
 * policy for a refused scan, an absent customer, or a disputed delivery — that
 * policy does not exist, and the system does not pretend to know it. Those rows
 * say so plainly instead of implying an automatic resolution is coming. Nothing
 * on this page moves money; it tells a human where to look and then gets out of
 * the way.
 */
export default async function AdminDisputesPage() {
  const rows = await exceptions(200).catch(() => null);

  const decisions = (rows ?? []).filter((r) => r.requires_decision);
  const watching = (rows ?? []).filter((r) => !r.requires_decision);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Disputes and exceptions</h1>
      <p className="text-muted mb-6 text-sm">
        Orders, payouts and ledger discrepancies that a person has to resolve. Oldest first, because
        the thing that has been broken longest has been costing somebody the longest.
      </p>

      {rows === null ? (
        <Unavailable>The exceptions queue could not be loaded.</Unavailable>
      ) : rows.length === 0 ? (
        <Panel title="Nothing needs you">
          <Empty>
            No disputes, no failed payouts, no unexplained money. This is the state you want.
          </Empty>
        </Panel>
      ) : (
        <>
          <Panel
            title={`Requires a decision (${decisions.length})`}
            description="Campus Dash has no automatic resolution for these. Nothing has moved."
          >
            {decisions.length === 0 ? (
              <Empty>Nothing is waiting on a decision.</Empty>
            ) : (
              <Queue rows={decisions} />
            )}
          </Panel>

          <Panel
            title={`Worth watching (${watching.length})`}
            description="These resolve on their own or through an existing flow, but are visible here so nothing is lost."
          >
            {watching.length === 0 ? (
              <Empty>Nothing else outstanding.</Empty>
            ) : (
              <Queue rows={watching} />
            )}
          </Panel>
        </>
      )}
    </>
  );
}

function Queue({ rows }) {
  return (
    <Table head={['Kind', 'Order', 'Subject', 'What happened', 'Amount', 'Since']} minWidth="60rem">
      {rows.map((r, i) => (
        <Row key={`${r.kind}-${r.order_id ?? i}-${i}`}>
          <Cell>
            <Badge tone={ATTENTION[r.kind]?.tone ?? 'bad'}>
              {ATTENTION[r.kind]?.label ?? r.kind}
            </Badge>
          </Cell>
          <Cell>
            {r.order_id ? (
              <Link
                href={`/admin/orders/${r.order_id}`}
                className="text-brand-700 font-mono text-xs underline underline-offset-4"
              >
                {r.order_number}
              </Link>
            ) : (
              <span className="text-muted text-xs">-</span>
            )}
          </Cell>
          <Cell>{r.subject ?? '-'}</Cell>
          <Cell muted>{r.detail}</Cell>
          <Cell numeric>
            <Cedis pesewas={r.amount_pesewas} />
          </Cell>
          <Cell muted>{when(r.since)}</Cell>
        </Row>
      ))}
    </Table>
  );
}
