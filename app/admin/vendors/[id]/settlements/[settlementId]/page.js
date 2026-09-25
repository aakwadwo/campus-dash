import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BackLink } from '@/app/ui';
import { createClient } from '@/lib/supabase/server';
import { payoutDestinations, vendorSettlementDetail } from '@/lib/admin';
import { SETTLEMENT_LABEL, accraTime } from '@/lib/settlement/vendor-settlement';
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
} from '../../../../ui';
import RefreshButton from '../../../../refresh-button';

export const dynamic = 'force-dynamic';

/**
 * One Paystack settlement, and the charges in it.
 *
 * This is the page that answers "did this order make it into a successful
 * settlement?" without guessing: the transaction list is Paystack's own, read
 * now, and each line is matched to a Campus Dash order by its reference, which
 * is our payment id. A line that matches nothing of ours is shown as such.
 *
 * Read only. Campus Dash does not start or control a settlement, so there is
 * nothing to press here but a re-read.
 */
export default async function VendorSettlementPage({ params }) {
  const { id, settlementId } = await params;

  const supabase = await createClient();
  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();
  if (!vendor) notFound();

  const current = await payoutDestinations()
    .then(
      (rows) =>
        (rows ?? []).find((d) => d.payee_type === 'VENDOR' && d.payee_id === id)
          ?.provider_subaccount_code ?? null
    )
    .catch(() => null);

  const detail = await vendorSettlementDetail(id, settlementId, {
    currentSubaccount: current,
  }).catch(() => null);

  const back = (
    <BackLink href={`/admin/vendors/${id}#settlements`} className="mb-2">
      {vendor.name}
    </BackLink>
  );

  if (detail === null) {
    return (
      <>
        {back}
        <h1 className="mb-4 font-mono text-2xl font-semibold">{settlementId}</h1>
        <Unavailable>Paystack could not be asked about this settlement.</Unavailable>
      </>
    );
  }
  if (!detail.readable) {
    return (
      <>
        {back}
        <h1 className="mb-4 font-mono text-2xl font-semibold">{settlementId}</h1>
        <Unavailable>
          The payment provider on this deployment cannot report settlements.
        </Unavailable>
      </>
    );
  }
  if (!detail.settlement) notFound();

  const s = detail.settlement;
  const label = SETTLEMENT_LABEL[s.status];
  const ours = detail.transactions.filter((t) => t.orderId);

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-baseline gap-3">
        <h1 className="font-mono text-2xl font-semibold">Settlement {s.id}</h1>
        <Badge tone={label.tone}>{label.label}</Badge>
        <span className="ml-auto">
          <RefreshButton>Refresh from Paystack</RefreshButton>
        </span>
      </div>

      <Panel title="Settlement" description="As Paystack reports it.">
        <Facts>
          <Fact
            label="Status"
            value={s.status === 'UNKNOWN' ? `${label.label}: ${s.rawStatus ?? '-'}` : label.label}
          />
          <Fact label="Settlement date" value={accraTime(s.settlementDate) ?? 'not reported'} />
          <Fact
            label="Amount"
            value={
              s.totalAmountPesewas === null ? (
                `not reported in GHS (${s.currency ?? 'no currency'})`
              ) : (
                <Cedis pesewas={s.totalAmountPesewas} />
              )
            }
          />
          <Fact label="Currency" value={s.currency} />
          <Fact
            label="Destination"
            value={
              s.destinationBank
                ? `${s.destinationBank}${s.destinationLast3 ? ` ···${s.destinationLast3}` : ''}`
                : 'not reported'
            }
          />
          <Fact
            label="Subaccount"
            value={<span className="font-mono text-xs">{s.subaccountCode}</span>}
          />
          <Fact label="Created at Paystack" value={accraTime(s.createdAt) ?? '-'} />
          <Fact label="Read from Paystack" value={accraTime(detail.fetchedAt)} />
        </Facts>
      </Panel>

      <Panel
        title="Transactions in this settlement"
        description={`${detail.transactions.length} listed by Paystack, ${ours.length} matched to this store's orders.`}
      >
        {detail.truncated ? (
          <div className="mb-3">
            <Unavailable>
              Paystack listed more transactions than were read. An order missing from this list may
              still be in the settlement.
            </Unavailable>
          </div>
        ) : null}
        {detail.transactions.length === 0 ? (
          <Empty>Paystack listed no transactions for this settlement.</Empty>
        ) : (
          <Table
            head={['Order', 'Paystack reference', 'Amount (Paystack)', 'Vendor share', 'Paid']}
            minWidth="48rem"
          >
            {detail.transactions.map((t, i) => (
              <Row key={t.id ?? i}>
                <Cell mono>
                  {t.orderId ? (
                    <Link
                      href={`/admin/orders/${t.orderId}`}
                      className="text-brand-700 underline underline-offset-4"
                    >
                      {t.orderNumber}
                    </Link>
                  ) : (
                    <span className="text-muted">not matched</span>
                  )}
                </Cell>
                <Cell mono>{t.reference ?? '-'}</Cell>
                <Cell numeric>
                  {t.amountPesewas === null ? '-' : <Cedis pesewas={t.amountPesewas} />}
                </Cell>
                <Cell numeric>
                  {t.vendorSharePesewas === null ? '-' : <Cedis pesewas={t.vendorSharePesewas} />}
                </Cell>
                <Cell muted>{accraTime(t.paidAt) ?? '-'}</Cell>
              </Row>
            ))}
          </Table>
        )}
        <p className="text-muted mt-3 text-xs leading-relaxed">
          The amount is as Paystack lists the transaction. The vendor share is Campus Dash&apos;s
          ledger figure for the split.
        </p>
      </Panel>
    </>
  );
}
