import {
  settlementOverview,
  settlementRuns,
  settlementPayouts,
  payoutDestinations,
  payoutReadiness,
  partnerBalances,
  payoutHistory,
  payoutsAwaitingSettlement,
  vendorSplitPayments,
  listVendors,
} from '@/lib/admin';
import { getPaymentProvider } from '@/lib/payments';
import { formatPesewas } from '@/lib/util/money';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, when } from '../ui';
import SettlementControls from './settlement-controls';
import PayoutDestinations from './payout-destinations';
import ManualSettlement from './manual-settlement';

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

  const [balances, awaiting, awaitingVendors, splits, vendors] = await Promise.all([
    partnerBalances().catch(() => null),
    // THE WEEKLY LIST. Partner payouts are created by the run and stop there —
    // a person sends the money and records it — so this is the screen's most
    // operational panel, not a report.
    payoutsAwaitingSettlement('PARTNER').catch(() => null),
    payoutsAwaitingSettlement('VENDOR').catch(() => null),
    vendorSplitPayments({ limit: 50 }).catch(() => null),
    listVendors().catch(() => []),
  ]);

  // Whether Campus Dash can push money out at all on this deployment. It
  // cannot while PAYSTACK_TRANSFERS_ENABLED is off, and every label below that
  // mentions paying somebody is written from this, not assumed.
  const transfersOn = getPaymentProvider().canSendTransfers;

  // admin_payouts_awaiting_settlement() names a payee from the account table,
  // which a STORE is not; the store's own name is what an operator recognises.
  const vendorPayouts =
    awaitingVendors === null
      ? null
      : awaitingVendors.map((p) => ({
          ...p,
          payee_name: (vendors ?? []).find((v) => v.vendor_id === p.payee_id)?.name ?? null,
          payee_phone: null,
        }));

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
      <p className="text-muted mb-3 max-w-3xl text-sm leading-relaxed">
        <span className="text-ink font-semibold">
          Stores with a Paystack subaccount are paid automatically.
        </span>{' '}
        Paystack splits their food amount to their subaccount when the customer pays, and they never
        appear in a run. There is nothing to pay them here.
      </p>
      <p className="text-muted mb-6 max-w-3xl text-sm leading-relaxed">
        <span className="text-ink font-semibold">
          Partners{transfersOn ? '' : ', and stores without a subaccount,'} are paid by you.
        </span>{' '}
        Gathering a run lists what is owed and sends nothing. You pay each one by mobile money
        outside Campus Dash, then record it below with the transaction reference.
      </p>

      <SettlementControls transfersOn={transfersOn} />

      <ManualSettlement
        title="Partners to pay"
        payouts={awaiting}
        payeeLabel="Partner"
        countLabel="Deliveries"
        emptyText="No Partner payouts are waiting. On Sunday, gather last week's payouts to see who is owed."
      />

      <ManualSettlement
        title="Stores without a Paystack split, to pay"
        payouts={vendorPayouts}
        payeeLabel="Store"
        countLabel="Orders"
        emptyText="No store payouts are waiting. A store paid by Paystack split never needs one."
      />

      <Panel
        title="Paid automatically by Paystack split"
        description="The store's food amount went to its Paystack subaccount when the customer paid. Campus Dash does not track what happens next: Paystack settles the subaccount to the store's mobile money on its own schedule, and that settlement is visible only in the Paystack dashboard."
      >
        <SplitLog rows={splits} />
      </Panel>

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
                    <Badge tone="neutral">{transfersOn ? 'By transfer' : 'Paid by you'}</Badge>
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
        title="Owed to stores without a Paystack split"
        description="The store's amount from orders paid without a split, not yet gathered into a payout. It is owed and has not been paid. Stores paid by split never appear here."
      >
        <PendingTable rows={vendorPending} />
      </Panel>

      <Panel
        title="Owed to Partners, not yet gathered"
        description="Earned and not yet paid. Gathered into a payout on Sunday once it reaches the threshold."
      >
        <PendingTable rows={partnerPending} />
      </Panel>

      <Panel
        title="Payout history"
        description="Every payout ever gathered. PAID with provider 'manual' means an administrator recorded paying it outside Campus Dash, with the reference shown. A FAILED payout released what it covered back to owed. Split payments are not payouts and are listed above."
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

/**
 * Split payments, stated for exactly what they are.
 *
 * THE MONEY COLUMNS ARE PAYSTACK'S, read from its signed charge.success split
 * shares: the store's share, Paystack's fee, what Paystack credited the store's
 * subaccount, and what Campus Dash kept. With bearer_type 'account' the fee is
 * Campus Dash's, so the credit equals the share; the row says who bore it
 * rather than leaving anybody to infer it.
 *
 * "Split confirmed by Paystack" means that signed record lists the store's
 * subaccount receiving its full share. "Awaiting Paystack's confirmation" means
 * the payment is confirmed and the split was requested, but the signed event
 * that proves it has not been stored yet — normally a matter of seconds.
 * NEITHER means the store has received the money: the subaccount is settled to
 * mobile money by Paystack afterwards, untracked here, and the row says so.
 */
function SplitLog({ rows }) {
  if (rows === null) return <Unavailable>The split payments could not be loaded.</Unavailable>;
  if (!rows.length) return <Empty>No order has been paid by split yet.</Empty>;
  const money = (pesewas) => (pesewas === null ? '-' : <Cedis pesewas={pesewas} />);
  return (
    <Table
      head={[
        'Store',
        'Order',
        'Vendor share',
        'Paystack fee',
        'Subaccount credit',
        'Campus Dash net',
        'Split at',
        'Paystack',
        'Status',
      ]}
      minWidth="76rem"
    >
      {rows.map((row) => (
        <Row key={row.orderId}>
          <Cell>{row.vendorName ?? '-'}</Cell>
          <Cell mono>{row.orderNumber ?? '-'}</Cell>
          <Cell numeric>{money(row.vendorSharePesewas)}</Cell>
          <Cell numeric muted>
            {money(row.paystackFeePesewas)}
            {row.paystackFeePesewas !== null ? (
              <span className="text-faint block text-xs">
                {row.vendorFeePesewas === 0
                  ? 'borne by Campus Dash'
                  : `store bore ${(row.vendorFeePesewas / 100).toFixed(2)}`}
              </span>
            ) : null}
          </Cell>
          <Cell numeric>{money(row.subaccountCreditPesewas)}</Cell>
          <Cell numeric muted>
            {money(row.campusDashNetPesewas)}
          </Cell>
          <Cell muted>{row.splitAt ? when(row.splitAt) : '-'}</Cell>
          <Cell mono>
            {row.paystackTransactionId ? (
              <span className="block">txn {row.paystackTransactionId}</span>
            ) : null}
            <span className="text-faint block text-xs">
              ref {row.paystackReference ? `${row.paystackReference.slice(0, 8)}…` : '-'}
            </span>
            <span className="text-faint block text-xs">{row.subaccountCode ?? '-'}</span>
          </Cell>
          <Cell>
            {row.confirmedByPaystack ? (
              <Badge tone="good">Split confirmed by Paystack</Badge>
            ) : (
              <Badge tone="warn">Awaiting Paystack&apos;s confirmation</Badge>
            )}
            <span className="text-muted mt-1 block text-xs">
              Automatically split by Paystack. MoMo settlement not tracked here.
            </span>
          </Cell>
        </Row>
      ))}
    </Table>
  );
}
