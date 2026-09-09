import {
  settlementOverview,
  settlementRuns,
  settlementPayouts,
  payoutDestinations,
  payoutReadiness,
  partnerBalances,
  payoutHistory,
} from '@/lib/admin';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, when } from '../ui';
import SettlementControls from './settlement-controls';
import PayoutDestinations from './payout-destinations';

export const dynamic = 'force-dynamic';

/**
 * NULL MEANS THE QUESTION FAILED, [] MEANS THE ANSWER IS NONE.
 *
 * Every fetch on this page is caught to null, and every panel below renders
 * <Unavailable> for null and <Empty> for an empty list. On a settlement screen
 * the difference is money: "nothing owed to Partners" and "we could not find
 * out what is owed to Partners" look identical as an empty table, and an
 * operator who reads the second as the first concludes the week is settled.
 */
export default async function AdminSettlementsPage() {
  const [overview, runs, destinations, readiness, history] = await Promise.all([
    settlementOverview().catch(() => null),
    settlementRuns(20).catch(() => null),
    payoutDestinations().catch(() => null),
    payoutReadiness().catch(() => null),
    payoutHistory({ limit: 100 }).catch(() => null),
  ]);

  const balances = await partnerBalances().catch(() => null);

  const vendorPending =
    overview === null ? null : overview.filter((r) => r.payee_type === 'VENDOR');
  const partnerPending =
    overview === null ? null : overview.filter((r) => r.payee_type === 'PARTNER');

  const latestRun = runs?.[0];
  const latestPayouts = latestRun
    ? await settlementPayouts(latestRun.run_id).catch(() => null)
    : [];

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settlements</h1>
      <p className="text-muted mb-6 max-w-3xl text-sm leading-relaxed">
        A vendor with a registered subaccount is paid by Paystack as each order is charged, and
        never appears in a run at all. Everything else is settled by transfer: vendors daily,
        Partners weekly. Campus Dash holds nobody&apos;s money — a run gathers what is already owed
        and moves it out.
      </p>

      <SettlementControls />

      <PayoutDestinations destinations={destinations} />

      <Panel
        title="Partner balances"
        description="Every approved Partner and what they are owed. ELIGIBLE means the weekly run will pay them; anything under the threshold is carried forward, not lost. Change the threshold at /admin/pilot."
      >
        {balances === null ? (
          <Unavailable>Partner balances could not be loaded.</Unavailable>
        ) : balances.length === 0 ? (
          <Empty>No approved Partners yet.</Empty>
        ) : (
          <Table
            head={[
              'Partner',
              'Orders',
              'Available',
              'In flight',
              'Paid',
              'Payable',
              'Destination',
              'Last paid',
            ]}
            minWidth="60rem"
          >
            {balances.map((row) => (
              <Row key={row.partner_id}>
                <Cell>{row.partner_name ?? '-'}</Cell>
                <Cell numeric muted>
                  {row.delivered_count}
                </Cell>
                <Cell>
                  <Cedis pesewas={row.available_pesewas} />
                </Cell>
                <Cell muted>
                  <Cedis pesewas={row.in_progress_pesewas} />
                </Cell>
                <Cell muted>
                  <Cedis pesewas={row.settled_pesewas} />
                </Cell>
                <Cell>
                  {row.eligible_for_payout ? (
                    <Badge tone="good">Eligible</Badge>
                  ) : (
                    <Badge tone="neutral">Carries forward</Badge>
                  )}
                </Cell>
                <Cell>
                  {!row.has_destination ? (
                    <Badge tone="bad">None</Badge>
                  ) : row.transfers_ready ? (
                    <Badge tone="good">Ready</Badge>
                  ) : (
                    <Badge tone="warn">Not registered</Badge>
                  )}
                </Cell>
                <Cell muted>{row.last_paid_at ? when(row.last_paid_at) : 'never'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Payout setup"
        description="Every vendor and Partner who could be owed money, and whether they can actually be paid. The rows with nothing set are the ones that matter."
      >
        {readiness === null ? (
          <Unavailable>Payout setup could not be loaded.</Unavailable>
        ) : readiness.length === 0 ? (
          <Empty>No active vendors or approved Partners yet.</Empty>
        ) : (
          <Table head={['Payee', 'Type', 'Account', 'Split', 'Transfers', 'Owed']} minWidth="44rem">
            {readiness.map((row) => (
              <Row key={`${row.payee_type}:${row.payee_id}`}>
                <Cell>{row.payee_name ?? '-'}</Cell>
                <Cell muted>{row.payee_type}</Cell>
                <Cell muted>
                  {row.has_destination ? `${row.momo_network} ···${row.account_last3}` : 'none'}
                </Cell>
                <Cell>
                  {row.split_ready ? (
                    <Badge tone="good">Automatic</Badge>
                  ) : row.setup_error ? (
                    <Badge tone="bad">Failed</Badge>
                  ) : (
                    <Badge tone="neutral">By run</Badge>
                  )}
                </Cell>
                <Cell>
                  {row.transfers_ready ? (
                    <Badge tone="good">Ready</Badge>
                  ) : (
                    <Badge tone="neutral">Not registered</Badge>
                  )}
                </Cell>
                <Cell>
                  <Cedis pesewas={row.owed_pesewas} />
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel
        title="Owed to vendors, settled daily"
        description="Eligible allocations not yet claimed by a run, including anything a run held back for being under the minimum payout. DUE says whether today is the day; owed money that is not yet due is normal, not stuck."
      >
        <PendingTable rows={vendorPending} />
      </Panel>

      <Panel title="Owed to Partners, settled weekly">
        <PendingTable rows={partnerPending} />
      </Panel>

      <Panel
        title="Payout history"
        description="Every payout ever, not only those in the run below. PROCESSING means the provider accepted a transfer; only its own success event makes one PAID."
      >
        {history === null ? (
          <Unavailable>The payout history could not be loaded.</Unavailable>
        ) : history.length === 0 ? (
          <Empty>No payouts yet.</Empty>
        ) : (
          <Table
            head={['Payee', 'Type', 'Amount', 'Status', 'Attempt', 'Reference', 'Created', 'Paid']}
            minWidth="56rem"
          >
            {history.map((payout) => (
              <Row key={payout.payout_id}>
                <Cell>{payout.payee_name ?? '-'}</Cell>
                <Cell>{payout.payee_type}</Cell>
                <Cell numeric>
                  <Cedis pesewas={payout.amount_pesewas} />
                </Cell>
                <Cell>
                  <Badge tone={PAYOUT_TONE[payout.status] ?? 'neutral'}>{payout.status}</Badge>
                  {payout.failure_reason ? (
                    <span className="text-muted block text-xs">{payout.failure_reason}</span>
                  ) : null}
                </Cell>
                <Cell numeric>{payout.transfer_attempt}</Cell>
                <Cell mono>{payout.provider_transfer_id ?? '-'}</Cell>
                <Cell muted>{when(payout.created_at)}</Cell>
                <Cell muted>{payout.paid_at ? when(payout.paid_at) : '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Settlement runs">
        {runs === null ? (
          <Unavailable>The settlement runs could not be loaded.</Unavailable>
        ) : runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Period</th>
                  <th className="pb-2 font-medium">Total</th>
                  <th className="pb-2 font-medium">Payouts</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.run_id} className="border-line border-t">
                    <td className="py-2">{run.payee_type}</td>
                    <td className="text-muted py-2 text-xs tabular-nums">
                      {new Date(run.period_start).toLocaleDateString()} →{' '}
                      {new Date(run.period_end).toLocaleDateString()}
                    </td>
                    <td className="py-2 tabular-nums">
                      {formatPesewas(run.total_pesewas)}
                      {run.deferred_pesewas > 0 ? (
                        <span className="text-muted ml-1 text-xs">
                          (+{formatPesewas(run.deferred_pesewas)} held)
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 tabular-nums">
                      {run.paid_count}/{run.payout_count}
                      {run.failed_count > 0 ? (
                        <span className="text-bad ml-1">({run.failed_count} failed)</span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <Badge
                        tone={
                          run.status === 'COMPLETED'
                            ? 'good'
                            : run.status === 'FAILED'
                              ? 'bad'
                              : 'warn'
                        }
                      >
                        {run.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No settlement runs yet.</Empty>
        )}
      </Panel>

      {latestRun ? (
        <Panel
          title="Most recent run"
          description={`${latestRun.payee_type} · ${new Date(latestRun.created_at).toLocaleString()}`}
        >
          {latestPayouts === null ? (
            <Unavailable>This run&apos;s payouts could not be loaded.</Unavailable>
          ) : latestPayouts.length ? (
            <table className="w-full text-sm">
              <thead className="text-muted text-left text-xs uppercase">
                <tr>
                  <th className="pb-2 font-medium">Payee</th>
                  <th className="pb-2 font-medium">Amount</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Transfer</th>
                </tr>
              </thead>
              <tbody>
                {latestPayouts.map((payout) => (
                  <tr key={payout.payout_id} className="border-line border-t">
                    <td className="py-2">{payout.payee_name}</td>
                    <td className="py-2 tabular-nums">{formatPesewas(payout.amount_pesewas)}</td>
                    <td className="py-2">
                      <Badge
                        tone={
                          payout.status === 'PAID'
                            ? 'good'
                            : payout.status === 'FAILED'
                              ? 'bad'
                              : 'warn'
                        }
                      >
                        {payout.status}
                      </Badge>
                      {payout.failure_reason ? (
                        <span className="text-muted ml-2 text-xs">{payout.failure_reason}</span>
                      ) : null}
                    </td>
                    <td className="text-muted py-2 font-mono text-xs">
                      {payout.provider_transfer_id ?? '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>This run produced no payouts.</Empty>
          )}
        </Panel>
      ) : null}
    </>
  );
}

const PAYOUT_TONE = {
  PAID: 'good',
  FAILED: 'bad',
  REVERSED: 'bad',
  CANCELLED: 'neutral',
  PROCESSING: 'warn',
  PENDING: 'warn',
};

/**
 * What is owed, AND whether it is due.
 *
 * "GH₵240 owed" on its own tells an operator nothing about whether pressing the
 * button will do anything — the cadence used to live only in JavaScript. DUE
 * and BELOW MINIMUM are both computed in SQL now, so a run that would hold the
 * money back says so before it is started rather than afterwards.
 */
function PendingTable({ rows }) {
  if (rows === null) return <Unavailable>What is owed could not be read.</Unavailable>;
  if (!rows.length) return <Empty>Nothing owed.</Empty>;
  return (
    <Table head={['Payee', 'Orders', 'Owed', 'Oldest', 'Due', 'Last paid']} minWidth="44rem">
      {rows.map((row) => (
        <Row key={`${row.payee_type}:${row.payee_id}`}>
          <Cell>
            {row.payee_name ?? row.payee_id?.slice(0, 8)}
            {row.payee_contact ? (
              <span className="text-muted block text-xs tabular-nums">{row.payee_contact}</span>
            ) : null}
          </Cell>
          <Cell numeric>{row.order_count}</Cell>
          <Cell numeric>
            <Cedis pesewas={row.owed_pesewas} />
          </Cell>
          <Cell muted>{row.oldest_at ? new Date(row.oldest_at).toLocaleDateString() : '-'}</Cell>
          <Cell>
            {row.below_minimum ? (
              <Badge tone="neutral">below minimum</Badge>
            ) : row.is_due ? (
              <Badge tone="good">due now</Badge>
            ) : (
              <Badge tone="warn">from {new Date(row.eligible_from).toLocaleDateString()}</Badge>
            )}
            {row.failed_payouts > 0 ? <Badge tone="bad">{row.failed_payouts} failed</Badge> : null}
          </Cell>
          <Cell muted>{row.last_paid_at ? when(row.last_paid_at) : 'never'}</Cell>
        </Row>
      ))}
    </Table>
  );
}
