import {
  pendingSettlement,
  settlementRuns,
  settlementPayouts,
  payoutDestinations,
} from '@/lib/admin';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable } from '../ui';
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
  const [vendorPending, partnerPending, runs, destinations] = await Promise.all([
    pendingSettlement('VENDOR').catch(() => null),
    pendingSettlement('PARTNER').catch(() => null),
    settlementRuns(20).catch(() => null),
    payoutDestinations().catch(() => null),
  ]);

  const latestRun = runs?.[0];
  const latestPayouts = latestRun
    ? await settlementPayouts(latestRun.run_id).catch(() => null)
    : [];

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settlements</h1>
      <p className="text-muted mb-6 text-sm">
        Vendors are settled daily, Partners weekly. Campus Dash does not hold anyone&apos;s money —
        a run gathers what is already owed and moves it out.
      </p>

      <SettlementControls />

      <PayoutDestinations destinations={destinations} />

      <Panel
        title="Owed to vendors"
        description="Eligible allocations not yet claimed by a run — including anything a run held back for being under the minimum payout."
      >
        <PendingTable rows={vendorPending} />
      </Panel>

      <Panel title="Owed to Partners">
        <PendingTable rows={partnerPending} />
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
                  <tr key={run.run_id} className="border-t border-black/5">
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
                        <span className="ml-1 text-red-700">({run.failed_count} failed)</span>
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
                  <tr key={payout.payout_id} className="border-t border-black/5">
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
                      {payout.provider_transfer_id ?? '—'}
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

function PendingTable({ rows }) {
  if (rows === null) return <Unavailable>What is owed could not be read.</Unavailable>;
  if (!rows.length) return <Empty>Nothing owed.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead className="text-muted text-left text-xs uppercase">
        <tr>
          <th className="pb-2 font-medium">Payee</th>
          <th className="pb-2 font-medium">Orders</th>
          <th className="pb-2 font-medium">Owed</th>
          <th className="pb-2 font-medium">Oldest</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.payee_id} className="border-t border-black/5">
            <td className="py-2">{row.payee_name ?? row.payee_id?.slice(0, 8)}</td>
            <td className="py-2 tabular-nums">{row.order_count}</td>
            <td className="py-2 tabular-nums">{formatPesewas(row.owed_pesewas)}</td>
            <td className="text-muted py-2 text-xs">
              {row.oldest_at ? new Date(row.oldest_at).toLocaleDateString() : '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
