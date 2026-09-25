import Link from 'next/link';
import {
  settlementOverview,
  settlementRuns,
  payoutDestinations,
  payoutReadiness,
  partnerBalances,
  payoutHistory,
  payoutsAwaitingSettlement,
  vendorSplitPayments,
  paystackVendorSummary,
  listVendors,
} from '@/lib/admin';
import { getPaymentProvider } from '@/lib/payments';
import { formatPesewas } from '@/lib/util/money';
import { SETTLEMENT_LABEL, accraTime } from '@/lib/settlement/vendor-settlement';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, when } from '../ui';
import RefreshButton from '../refresh-button';
import SettlementControls from './settlement-controls';
import PayoutDestinations from './payout-destinations';
import ManualSettlement from './manual-settlement';

export const dynamic = 'force-dynamic';

/**
 * THE MONEY PAGE, IN TWO HALVES, BY WHO CONTROLS THE MONEY.
 *
 * NEEDS YOU: Partner payouts and manual vendor payments. Campus Dash gathers
 * what is owed; an administrator pays it outside Campus Dash and records it.
 * Every button on the page lives in this half, and each one does what it says.
 *
 * PAYSTACK HANDLES: stores with a subaccount. Paystack splits their share at
 * the charge and later settles the subaccount to their bank or mobile money.
 * Campus Dash controls neither, so this half is status and history, read from
 * Paystack when the page loads, with no action but a re-read.
 *
 * NULL MEANS THE QUESTION FAILED, [] MEANS THE ANSWER IS NONE. Every fetch is
 * caught to null and every panel renders <Unavailable> for null and <Empty>
 * for an empty list. On a money screen the difference is money.
 */
export default async function AdminSettlementsPage() {
  const [overview, runs, destinations, readiness, history] = await Promise.all([
    settlementOverview().catch(() => null),
    settlementRuns(20).catch(() => null),
    payoutDestinations().catch(() => null),
    payoutReadiness().catch(() => null),
    payoutHistory({ limit: 200 }).catch(() => null),
  ]);

  const [balances, awaiting, awaitingVendors, splits, vendors] = await Promise.all([
    partnerBalances().catch(() => null),
    // THE WEEKLY LIST. Partner payouts are created by the run and stop there:
    // a person sends the money and records it.
    payoutsAwaitingSettlement('PARTNER').catch(() => null),
    payoutsAwaitingSettlement('VENDOR').catch(() => null),
    vendorSplitPayments({ limit: 200 }).catch(() => null),
    listVendors().catch(() => []),
  ]);

  const paystackStores =
    splits === null ? null : await paystackVendorSummary(splits).catch(() => null);

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
  const partnerHistory =
    history === null ? null : history.filter((p) => p.payee_type === 'PARTNER');
  const vendorHistory = history === null ? null : history.filter((p) => p.payee_type === 'VENDOR');

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Money</h1>

      <SectionHeading
        title="Needs you"
        body={`Partner payouts${transfersOn ? '' : ' and manual vendor payments'}. Campus Dash lists what is owed and sends nothing. You pay each one by mobile money outside Campus Dash, then record it with the transaction reference.`}
      />

      <SettlementControls transfersOn={transfersOn} />

      <ManualSettlement
        title="Partner payouts to pay"
        payouts={awaiting}
        payeeLabel="Partner"
        countLabel="Deliveries"
        emptyText="No Partner payouts are waiting. On Sunday, gather last week's payouts to see who is owed."
      />

      <ManualSettlement
        title="Manual vendor payments to pay"
        payouts={vendorPayouts}
        payeeLabel="Store"
        countLabel="Orders"
        emptyText="No manual vendor payments are waiting. A store paid by Paystack split never needs one."
      />

      <Panel
        title="Owed to stores without a Paystack split"
        description="From orders paid without a split, not yet gathered into a manual vendor payment."
      >
        <PendingTable rows={vendorPending} />
      </Panel>

      <Panel
        title="Owed to Partners, not yet gathered"
        description="Earned and not yet paid. Gathered into a payout on Sunday once it reaches the threshold."
      >
        <PendingTable rows={partnerPending} />
      </Panel>

      <SectionHeading
        title="Paystack handles these"
        body="Stores with a Paystack subaccount. Paystack splits their share into the subaccount when the customer pays, then settles the subaccount to their bank or mobile money on its own schedule. Campus Dash controls neither step, so there is nothing to pay here. A split is not a settlement."
      />

      <Panel
        title="Paystack vendor settlements"
        description="One row per store paid by split. Settlement status is read from Paystack when this page loads, because Paystack sends no settlement webhook."
        actions={<RefreshButton>Refresh from Paystack</RefreshButton>}
      >
        <PaystackStores rows={paystackStores} />
      </Panel>

      <Panel
        title="Paystack splits"
        description="Each order whose vendor share Paystack split into a subaccount. The money columns are Paystack's own signed record of the charge. Open an order to see whether its split has been settled."
      >
        <SplitLog rows={splits} />
      </Panel>

      <SectionHeading title="Records and setup" />

      <Panel
        title="Partner balances"
        description="Every approved Partner and what they are owed. Anything under the threshold is carried forward, not lost. Change the threshold at /admin/pilot."
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
                  {row.has_destination ? (
                    <Badge tone="good">On file</Badge>
                  ) : (
                    <Badge tone="bad">None</Badge>
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
        description="Every store and Partner who could be owed money, and how they are paid. A Partner is never in a Paystack split."
      >
        {readiness === null ? (
          <Unavailable>Payout setup could not be loaded.</Unavailable>
        ) : readiness.length === 0 ? (
          <Empty>No active vendors or approved Partners yet.</Empty>
        ) : (
          <Table head={['Payee', 'Type', 'Account', 'Paid by', 'Owed']} minWidth="40rem">
            {readiness.map((row) => (
              <Row key={`${row.payee_type}:${row.payee_id}`}>
                <Cell>{row.payee_name ?? '-'}</Cell>
                <Cell muted>{row.payee_type}</Cell>
                <Cell muted>
                  {row.has_destination ? `${row.momo_network} ···${row.account_last3}` : 'none'}
                </Cell>
                <Cell>
                  {row.payee_type === 'VENDOR' && row.split_ready ? (
                    <Badge tone="good">Paystack split</Badge>
                  ) : row.payee_type === 'VENDOR' && row.setup_error ? (
                    <Badge tone="bad">Split setup failed</Badge>
                  ) : (
                    <Badge tone="neutral">{transfersOn ? 'Transfer' : 'You, manually'}</Badge>
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

      <PayoutDestinations destinations={destinations} />

      <Panel
        title="Partner payout history"
        description="Every Partner payout gathered. PAID with provider 'manual' means an administrator recorded paying it outside Campus Dash, with the reference shown."
      >
        <PayoutHistory rows={partnerHistory} empty="No Partner payouts yet." />
      </Panel>

      <Panel
        title="Manual vendor payment history"
        description="Payments to stores without a Paystack split. Paystack settlements are not listed here. They are on each store's page."
      >
        <PayoutHistory rows={vendorHistory} empty="No manual vendor payments yet." />
      </Panel>

      <Panel
        title="Gathering runs"
        description="Each run gathers what is owed for a period into payouts. Gathering pays nobody."
      >
        {runs === null ? (
          <Unavailable>The runs could not be loaded.</Unavailable>
        ) : runs.length ? (
          <Table head={['Type', 'Period', 'Total', 'Payouts recorded', 'Status']} minWidth="40rem">
            {runs.map((run) => (
              <Row key={run.run_id}>
                <Cell>{run.payee_type}</Cell>
                <Cell muted>
                  {new Date(run.period_start).toLocaleDateString()} →{' '}
                  {new Date(run.period_end).toLocaleDateString()}
                </Cell>
                <Cell numeric>
                  {formatPesewas(run.total_pesewas)}
                  {run.deferred_pesewas > 0 ? (
                    <span className="text-muted ml-1 text-xs">
                      (+{formatPesewas(run.deferred_pesewas)} held)
                    </span>
                  ) : null}
                </Cell>
                <Cell numeric>
                  {run.paid_count}/{run.payout_count}
                  {run.failed_count > 0 ? (
                    <span className="text-bad ml-1">({run.failed_count} failed)</span>
                  ) : null}
                </Cell>
                <Cell>
                  <Badge
                    tone={
                      run.status === 'COMPLETED' ? 'good' : run.status === 'FAILED' ? 'bad' : 'warn'
                    }
                  >
                    {run.status}
                  </Badge>
                </Cell>
              </Row>
            ))}
          </Table>
        ) : (
          <Empty>No runs yet.</Empty>
        )}
      </Panel>
    </>
  );
}

function SectionHeading({ title, body }) {
  return (
    <div className="border-line mt-10 mb-4 border-t pt-6 first-of-type:mt-0">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {body ? <p className="text-muted mt-1 max-w-3xl text-sm leading-relaxed">{body}</p> : null}
    </div>
  );
}

function PayoutHistory({ rows, empty }) {
  if (rows === null) return <Unavailable>The history could not be loaded.</Unavailable>;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <Table
      head={['Payee', 'Amount', 'Status', 'Attempt', 'Reference', 'Created', 'Paid']}
      minWidth="52rem"
    >
      {rows.map((payout) => (
        <Row key={payout.payout_id}>
          <Cell>{payout.payee_name ?? '-'}</Cell>
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
  );
}

/**
 * One row per store paid by split: what was split, and the latest settlement
 * Paystack reports for its subaccount. No action column, deliberately.
 */
function PaystackStores({ rows }) {
  if (rows === null) return <Unavailable>The Paystack stores could not be loaded.</Unavailable>;
  if (!rows.length) return <Empty>No order has been paid by split yet.</Empty>;
  return (
    <Table
      head={['Store', 'Split orders', 'Vendor amount', 'Split', 'Latest settlement', 'Settled', '']}
      minWidth="60rem"
    >
      {rows.map((row) => {
        const latest = row.latest ? SETTLEMENT_LABEL[row.latest.status] : null;
        return (
          <Row key={row.vendorId}>
            <Cell>{row.vendorName ?? '-'}</Cell>
            <Cell numeric>{row.orders}</Cell>
            <Cell numeric>
              <Cedis pesewas={row.vendorSharePesewas} />
            </Cell>
            <Cell>
              <Badge tone={row.awaiting ? 'warn' : 'good'}>
                {row.confirmed}/{row.orders} confirmed
              </Badge>
            </Cell>
            <Cell>
              {!row.readable ? (
                <span className="text-muted text-xs">not readable here</span>
              ) : row.error ? (
                <span className="text-muted text-xs">could not be read</span>
              ) : latest ? (
                <>
                  <Badge tone={latest.tone}>{latest.label}</Badge>
                  <span className="text-faint block font-mono text-xs">{row.latest.id}</span>
                </>
              ) : (
                <span className="text-muted text-xs">none yet</span>
              )}
            </Cell>
            <Cell muted>
              {row.lastSettled
                ? accraTime(row.lastSettled.settlementDate ?? row.lastSettled.createdAt)
                : '-'}
            </Cell>
            <Cell>
              <Link
                href={`/admin/vendors/${row.vendorId}#settlements`}
                className="text-brand-700 text-xs font-semibold underline underline-offset-4"
              >
                View settlements
              </Link>
            </Cell>
          </Row>
        );
      })}
    </Table>
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
 * NEITHER means the store has received the money: Paystack settles the
 * subaccount afterwards, and that settlement is read per order and per store,
 * never inferred from the split.
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
          <Cell mono>
            <Link
              href={`/admin/orders/${row.orderId}`}
              className="text-brand-700 underline underline-offset-4"
            >
              {row.orderNumber ?? '-'}
            </Link>
          </Cell>
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
            <span className="text-muted mt-1 block text-xs">A split, not a settlement.</span>
          </Cell>
        </Row>
      ))}
    </Table>
  );
}
