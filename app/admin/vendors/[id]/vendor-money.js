import Link from 'next/link';
import RefreshButton from '../../refresh-button';
import { SETTLEMENT_LABEL, settlementSummary, accraTime } from '@/lib/settlement/vendor-settlement';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Cedis,
  Facts,
  Fact,
  when,
} from '../../ui';

/**
 * A store's money, split by who controls it.
 *
 * PAYSTACK SETTLEMENTS are Paystack's: it pays the subaccount out to the
 * store's destination on its own schedule. This section only READS them,
 * fresh from Paystack on every load, and offers no action, because there is
 * nothing for Campus Dash to press. "Refresh" re-reads and changes nothing.
 *
 * MANUAL VENDOR PAYMENTS are Campus Dash's: money that was not split is owed
 * until an administrator pays it outside Campus Dash and records it. That
 * record is made on the Money page, where the rest of the manual list is.
 *
 * `history` is vendorSettlements(): null when it could not be read at all.
 * `manual` is { owed, awaiting, paid }, each null when it could not be read.
 */
export default function VendorMoney({ vendorId, history, manual, destination }) {
  const hasPaystack = history?.codes?.length > 0;
  const hasManual =
    !destination?.provider_subaccount_code ||
    (manual.owed?.length ?? 0) + (manual.awaiting?.length ?? 0) + (manual.paid?.length ?? 0) > 0;

  return (
    <Panel
      title="Money and settlements"
      description="Paystack settlements are shown as Paystack reports them. Only manual vendor payments need anything from you."
      actions={hasPaystack ? <RefreshButton>Refresh from Paystack</RefreshButton> : null}
    >
      <div id="settlements" className="scroll-mt-6">
        {history === null ? (
          <Unavailable>
            This store&apos;s Paystack settlements could not be read. That is not the same as there
            being none.
          </Unavailable>
        ) : hasPaystack ? (
          <PaystackSettlements vendorId={vendorId} history={history} />
        ) : (
          <p className="text-muted text-sm">
            No Paystack subaccount. This store&apos;s share is not split at the charge, so it is
            paid manually.
          </p>
        )}
      </div>

      {hasManual ? <ManualPayments manual={manual} /> : null}
    </Panel>
  );
}

function PaystackSettlements({ vendorId, history }) {
  if (!history.readable) {
    return (
      <Unavailable>
        The payment provider on this deployment cannot report settlements, so none are shown. That
        says nothing about whether Paystack has settled this store.
      </Unavailable>
    );
  }

  return (
    <div className="space-y-6">
      {history.subaccounts.map((sub) => (
        <Subaccount key={sub.code} vendorId={vendorId} sub={sub} />
      ))}
      <p className="text-muted text-xs">
        Read from Paystack {accraTime(history.fetchedAt)}. Paystack sends no settlement webhook, so
        this is read each time the page loads. Paystack does not report a subaccount&apos;s
        unsettled balance, so none is shown.
      </p>
    </div>
  );
}

function Subaccount({ vendorId, sub }) {
  const summary = sub.settlements ? settlementSummary(sub.settlements) : null;
  const latestLabel = summary?.latest ? SETTLEMENT_LABEL[summary.latest.status] : null;

  return (
    <section>
      <h3 className="mb-2 flex flex-wrap items-baseline gap-2 text-sm font-semibold">
        <span className="font-mono">{sub.code}</span>
        {sub.current ? <Badge tone="good">current</Badge> : <Badge>earlier</Badge>}
      </h3>

      <Facts>
        <Fact
          label="Subaccount"
          value={
            sub.infoError
              ? 'could not be read'
              : sub.info
                ? [
                    sub.info.active === false ? 'inactive' : sub.info.active ? 'active' : null,
                    sub.info.verified ? 'verified' : null,
                    sub.info.schedule ? `${sub.info.schedule} schedule` : null,
                  ]
                    .filter(Boolean)
                    .join(', ') || 'no status reported'
                : 'not found at Paystack'
          }
        />
        <Fact
          label="Destination"
          value={
            sub.info?.bank
              ? `${sub.info.bank}${sub.info.last3 ? ` ···${sub.info.last3}` : ''}`
              : '-'
          }
        />
        <Fact
          label="Latest settlement"
          value={
            sub.error ? (
              'could not be read'
            ) : latestLabel ? (
              <Badge tone={latestLabel.tone}>{latestLabel.label}</Badge>
            ) : (
              'none yet'
            )
          }
        />
        <Fact
          label="Last settled"
          value={
            summary?.lastSettled
              ? `${accraTime(summary.lastSettled.settlementDate ?? summary.lastSettled.createdAt)} · ${summary.lastSettled.id}`
              : sub.error
                ? '-'
                : 'never'
          }
        />
      </Facts>

      <div className="mt-3">
        {sub.error ? (
          <Unavailable>Paystack could not list this subaccount&apos;s settlements.</Unavailable>
        ) : sub.settlements.length === 0 ? (
          <Empty>Paystack reports no settlements for this subaccount yet.</Empty>
        ) : (
          <Table
            head={['Settlement', 'Status', 'Settlement date', 'Amount', 'Destination']}
            minWidth="40rem"
          >
            {sub.settlements.map((s) => {
              const label = SETTLEMENT_LABEL[s.status];
              return (
                <Row key={s.id}>
                  <Cell mono>
                    <Link
                      href={`/admin/vendors/${vendorId}/settlements/${encodeURIComponent(s.id)}`}
                      className="text-brand-700 underline underline-offset-4"
                    >
                      {s.id}
                    </Link>
                  </Cell>
                  <Cell>
                    <Badge tone={label.tone}>{label.label}</Badge>
                    {s.status === 'UNKNOWN' && s.rawStatus ? (
                      <span className="text-muted block text-xs">{s.rawStatus}</span>
                    ) : null}
                  </Cell>
                  <Cell muted>{accraTime(s.settlementDate) ?? 'not reported'}</Cell>
                  <Cell numeric>
                    {s.totalAmountPesewas === null ? (
                      `- ${s.currency ?? ''}`
                    ) : (
                      <Cedis pesewas={s.totalAmountPesewas} />
                    )}
                  </Cell>
                  <Cell muted>
                    {s.destinationBank
                      ? `${s.destinationBank}${s.destinationLast3 ? ` ···${s.destinationLast3}` : ''}`
                      : '-'}
                  </Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </div>
    </section>
  );
}

function ManualPayments({ manual }) {
  const owed = (manual.owed ?? []).reduce((sum, r) => sum + Number(r.owed_pesewas ?? 0), 0);
  return (
    <section className="border-line mt-6 border-t pt-4">
      <h3 className="mb-1 text-sm font-semibold">Manual vendor payments</h3>
      <p className="text-muted mb-3 text-sm">
        Money not split by Paystack is owed until you pay the store outside Campus Dash and record
        it on the{' '}
        <Link href="/admin/settlements" className="text-brand-700 underline underline-offset-4">
          Money page
        </Link>
        .
      </p>
      <Facts>
        <Fact
          label="Owed, not yet gathered"
          value={manual.owed === null ? 'could not be read' : <Cedis pesewas={owed} />}
        />
        <Fact
          label="Gathered, waiting for you to pay and record"
          value={
            manual.awaiting === null ? (
              'could not be read'
            ) : (
              <Cedis
                pesewas={manual.awaiting.reduce((s, p) => s + Number(p.amount_pesewas ?? 0), 0)}
              />
            )
          }
        />
      </Facts>
      <div className="mt-3">
        {manual.paid === null ? (
          <Unavailable>The manual payment history could not be read.</Unavailable>
        ) : manual.paid.length === 0 ? (
          <Empty>No manual vendor payments recorded.</Empty>
        ) : (
          <Table head={['Amount', 'Status', 'Reference', 'Recorded']} minWidth="32rem">
            {manual.paid.map((p) => (
              <Row key={p.payout_id}>
                <Cell numeric>
                  <Cedis pesewas={p.amount_pesewas} />
                </Cell>
                <Cell>{p.status}</Cell>
                <Cell mono>{p.provider_transfer_id ?? '-'}</Cell>
                <Cell muted>{p.paid_at ? when(p.paid_at) : '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </div>
    </section>
  );
}
