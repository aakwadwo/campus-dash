import Link from 'next/link';
import { BackLink } from '@/app/ui';
import { notFound } from 'next/navigation';
import { orderMoney, orderVendorMoney } from '@/lib/admin';
import { ORDER_SETTLEMENT_LABEL, accraTime } from '@/lib/settlement/vendor-settlement';
import { adminScanOrder } from '@/lib/scan';
import { createClient } from '@/lib/supabase/server';
import {
  Panel,
  Badge,
  Facts,
  Fact,
  Table,
  Row,
  Cell,
  Cedis,
  Empty,
  Unavailable,
  SCAN_STATUS,
  when,
} from '../../ui';
import OrderOverrides from './order-overrides';
import ScanViewer from './scan-viewer';

export const dynamic = 'force-dynamic';

/**
 * One order, in full.
 *
 * The page is deliberately the same page for both order types — a scan errand
 * and a food order share a customer, a destination, a Partner, a payment and a
 * ledger, and only diverge in two panels. Two separate screens would mean two
 * places to fix every future change to the shared nine-tenths.
 */
export default async function AdminOrderPage({ params }) {
  const { orderId } = await params;

  const money = await orderMoney(orderId);
  if (!money) notFound();

  // Payment, Paystack split and vendor settlement, read as three facts. Null
  // means the question failed, which the panel says rather than drawing blanks.
  const vendorMoney = await orderVendorMoney(orderId).catch(() => null);

  const supabase = await createClient();
  const [{ data: order }, { data: events }, { data: items }, { data: note }] = await Promise.all([
    supabase.from('orders').select('*').eq('id', orderId).maybeSingle(),
    supabase
      .from('order_events')
      .select('event, actor_role, accepted, reason, dimension, from_state, to_state, created_at')
      .eq('order_id', orderId)
      .order('id'),
    supabase
      .from('order_items')
      .select('name_snapshot, unit_price_pesewas, quantity, line_total_pesewas')
      .eq('order_id', orderId),
    // Order information, the customer's note for the store.
    supabase.from('order_notes').select('body').eq('order_id', orderId).maybeSingle(),
  ]);

  if (!order) notFound();
  const isScan = order.order_type === 'SCAN';

  // Only asked for when it is a scan order, and it never returns the image path.
  const scan = isScan ? await adminScanOrder(orderId).catch(() => null) : null;

  const [{ data: customer }, { data: destination }] = await Promise.all([
    supabase
      .from('users')
      .select('id, full_name, phone, email')
      .eq('id', order.customer_id)
      .maybeSingle(),
    order.destination_location_id
      ? supabase.rpc('location_path', { p_location_id: order.destination_location_id })
      : Promise.resolve({ data: null }),
  ]);

  return (
    <>
      <BackLink href="/admin/orders" className="mb-2">
        Orders
      </BackLink>

      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h1 className="font-mono text-2xl font-semibold">{money.order_number}</h1>
        <Badge tone={isScan ? 'warn' : 'neutral'}>{order.order_type}</Badge>
      </div>

      <p className="mb-6 flex flex-wrap items-center gap-2 text-sm">
        <Badge>{order.order_status}</Badge>
        <Badge tone={order.payment_status === 'PAID' ? 'good' : 'warn'}>
          {order.payment_status}
        </Badge>
        <Badge>{order.delivery_status}</Badge>
        {order.scan_status ? (
          <Badge tone={SCAN_STATUS[order.scan_status]?.tone ?? 'neutral'}>
            scan: {SCAN_STATUS[order.scan_status]?.label ?? order.scan_status}
          </Badge>
        ) : null}
        {order.disputed_at && !order.dispute_resolved_at ? (
          <Badge tone="bad">DISPUTED</Badge>
        ) : null}
      </p>

      {/* ---------------------------------------------------------------- */}
      <Panel title="Order">
        <Facts>
          <Fact
            label="Order number"
            value={<span className="font-mono">{order.order_number}</span>}
          />
          <Fact label="Type" value={order.order_type} />
          <Fact
            label="Customer"
            value={
              customer ? (
                <Link
                  href={`/admin/customers/${customer.id}`}
                  className="text-brand-700 underline underline-offset-4"
                >
                  {customer.full_name ?? customer.phone}
                </Link>
              ) : (
                '-'
              )
            }
          />
          <Fact label="Customer phone" value={customer?.phone} />
          <Fact label={isScan ? 'Restaurant' : 'Vendor'} value={money.vendor_name} />
          <Fact label="Fulfilment" value={order.fulfilment_type} />
          <Fact
            label="Destination"
            value={
              destination ?? (order.fulfilment_type === 'PICKUP' ? 'Collected in person' : '-')
            }
          />
          <Fact label="Order information" value={note?.body ?? scan?.details} />
          <Fact label="Additional information" value={order.destination_note} />
          <Fact label="Partner" value={money.partner_name ?? 'none assigned'} />
          <Fact label="Placed" value={when(order.created_at)} />
          <Fact label="Completed" value={when(order.completed_at)} />
        </Facts>
      </Panel>

      {/* ---------------------------------------------------------------- */}
      {isScan ? (
        <Panel
          title="Scan"
          description="Redemption is its own act. A Partner who accepted this errand has not thereby redeemed anything."
        >
          {scan === null ? (
            <Unavailable>The scan record could not be read.</Unavailable>
          ) : (
            <>
              <Facts>
                <Fact
                  label="Scan status"
                  value={
                    <Badge tone={SCAN_STATUS[scan.scan_status]?.tone ?? 'neutral'}>
                      {SCAN_STATUS[scan.scan_status]?.label ?? scan.scan_status}
                    </Badge>
                  }
                />
                <Fact label="Restaurant" value={scan.restaurant_name} />
                <Fact label="Scan on file" value={scan.has_scan_image ? 'Yes' : 'No'} />
                <Fact label="Uploaded" value={when(scan.uploaded_at)} />
                <Fact
                  label="Released to Partner"
                  value={
                    scan.released_at
                      ? `${when(scan.released_at)} · ${scan.partner_name ?? 'assigned'}`
                      : 'Not released'
                  }
                />
                <Fact label="Redeemed" value={when(scan.redeemed_at)} />
                <Fact label="Refused" value={when(scan.refused_at)} />
                {scan.refusal_reason ? (
                  <Fact label="Refusal reason" value={scan.refusal_reason} />
                ) : null}
              </Facts>

              {scan.scan_status === 'REFUSED' ? (
                <p className="bg-bad-bg text-bad mt-4 rounded px-4 py-3 text-sm">
                  <strong>Requires admin decision.</strong> The restaurant would not honour this
                  scan. Campus Dash has no refund policy for this case, so nothing has moved
                  automatically: the customer is still charged and the Partner is still owed the
                  delivery fee. Use the overrides below once you have decided what should happen.
                </p>
              ) : null}

              <div className="border-line mt-5 border-t pt-4">
                <h3 className="mb-2 text-sm font-semibold">The scan itself</h3>
                <ScanViewer orderId={orderId} hasScan={Boolean(scan.has_scan_image)} />
              </div>
            </>
          )}
        </Panel>
      ) : (
        <Panel title="Items" description="Prices are snapshots taken when the order was placed.">
          {items?.length ? (
            <Table head={['Item', 'Unit', 'Qty', 'Line total']} minWidth="28rem">
              {items.map((item, i) => (
                <Row key={i}>
                  <Cell>{item.name_snapshot}</Cell>
                  <Cell numeric>
                    <Cedis pesewas={item.unit_price_pesewas} />
                  </Cell>
                  <Cell numeric>{item.quantity}</Cell>
                  <Cell numeric>
                    <Cedis pesewas={item.line_total_pesewas} />
                  </Cell>
                </Row>
              ))}
            </Table>
          ) : (
            <Empty>No items on this order.</Empty>
          )}
        </Panel>
      )}

      {/* ---------------------------------------------------------------- */}
      <Panel
        title="Money"
        description="What the customer paid, where we said it goes, and whether it has left."
      >
        <Facts>
          <Fact label="Customer paid" value={<Cedis pesewas={money.paid_pesewas} />} />
          <Fact label="Order total" value={<Cedis pesewas={money.total_pesewas} />} />
          <Fact
            label={isScan ? 'Food (settled by the university)' : 'Food subtotal'}
            value={<Cedis pesewas={order.subtotal_pesewas} />}
          />
          <Fact
            label={isScan ? 'Scan service fee (flat)' : 'Service fee (percentage of food)'}
            value={<Cedis pesewas={order.service_fee_pesewas} />}
          />
          <Fact label="Delivery fee" value={<Cedis pesewas={order.delivery_fee_pesewas} />} />
        </Facts>

        <h3 className="text-muted mt-5 mb-2 text-xs font-semibold tracking-wide uppercase">
          Entitlements
        </h3>
        <Facts>
          <Fact
            label={`Vendor · ${money.vendor_name}`}
            value={
              isScan ? (
                <span className="text-muted">No vendor liability, the meal was prepaid</span>
              ) : (
                <Cedis pesewas={money.vendor_allocation} />
              )
            }
          />
          <Fact
            label={`Partner · ${money.partner_name ?? 'none'}`}
            value={<Cedis pesewas={money.partner_allocation} />}
          />
          <Fact label="Campus Dash" value={<Cedis pesewas={money.platform_allocation} />} />
          <Fact label="Allocated in total" value={<Cedis pesewas={money.allocated_pesewas} />} />
        </Facts>

        <p className={`mt-3 text-sm font-medium ${money.balances ? 'text-brand-700' : 'text-bad'}`}>
          {money.balances
            ? '✓ Allocations balance against the order total.'
            : '✗ Allocations do NOT balance. This order needs investigating.'}
        </p>

        <p className="text-muted mt-2 text-xs">
          Paystack&apos;s processing fee is a platform expense and is not recorded anywhere in this
          ledger, and it is never deducted from what a vendor or a Partner is owed.
        </p>

        {money.allocations?.length ? (
          <div className="mt-4">
            <Table head={['Payee', 'Amount', 'Route', 'Ledger']} minWidth="30rem">
              {money.allocations.map((a, i) => (
                <Row key={i}>
                  <Cell>{a.payee_type}</Cell>
                  <Cell numeric>
                    <Cedis pesewas={a.amount_pesewas} />
                  </Cell>
                  <Cell muted>{ROUTE[a.settlement_channel] ?? '-'}</Cell>
                  <Cell muted>{ledgerState(a)}</Cell>
                </Row>
              ))}
            </Table>
          </div>
        ) : null}
      </Panel>

      <VendorMoney vendorMoney={vendorMoney} channel={money.vendor_channel} />

      {/* ---------------------------------------------------------------- */}
      <Panel title="Overrides" description="Every one of these is recorded with your reason.">
        <OrderOverrides order={order} />
      </Panel>

      <Panel title="History" description="Every attempted transition, accepted or rejected.">
        {events?.length ? (
          <ul className="divide-line divide-y text-sm">
            {events.map((event, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className={`font-mono text-xs ${event.accepted ? '' : 'text-bad'}`}>
                  {event.accepted ? '' : '✗ '}
                  {event.event}
                </span>
                <span className="text-muted text-xs">{event.actor_role}</span>
                {event.dimension ? (
                  <span className="text-muted text-xs">
                    {event.dimension}: {event.from_state ?? '-'} → {event.to_state ?? '-'}
                  </span>
                ) : null}
                {event.reason ? <span className="text-muted text-xs">{event.reason}</span> : null}
                <span className="text-muted ml-auto text-xs tabular-nums">
                  {when(event.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No events recorded.</Empty>
        )}
      </Panel>
    </>
  );
}

const ROUTE = {
  SPLIT: 'Paystack split',
  TRANSFER: 'Campus Dash balance',
};

/**
 * What the ledger row says, in words that do not overclaim. A SPLIT row is
 * written SETTLED the moment Paystack splits the charge, which is a fact
 * about the ledger, not about the store's bank or mobile money account.
 */
function ledgerState(a) {
  if (a.settlement_channel === 'SPLIT' && a.status === 'SETTLED') {
    return `Split to subaccount ${when(a.settled_at)}`;
  }
  if (a.status === 'SETTLED') return `Paid, recorded ${when(a.settled_at)}`;
  if (a.status === 'SETTLING') return 'Gathered, awaiting payment';
  if (a.status === 'ELIGIBLE') return 'Owed';
  return a.status;
}

/**
 * THE STORE'S MONEY, AS THREE SEPARATE FACTS.
 *
 * Payment: the customer paid. Paystack split: Paystack's signed record credits
 * the store's subaccount. Vendor settlement: a Paystack settlement's own
 * transaction list contains this charge. Each is shown on its own evidence,
 * and none is inferred from another. There is no action on this panel,
 * because Campus Dash controls none of it.
 */
function VendorMoney({ vendorMoney, channel }) {
  if (vendorMoney === null) {
    return (
      <Panel title="Store's money">
        <Unavailable>The payment, split and settlement could not be read.</Unavailable>
      </Panel>
    );
  }
  const { payment, split, settlement } = vendorMoney;
  const state = ORDER_SETTLEMENT_LABEL[settlement?.state] ?? ORDER_SETTLEMENT_LABEL.UNKNOWN;

  return (
    <Panel
      title="Store's money"
      description="Payment, split and settlement are separate events. Each is shown only on its own evidence."
    >
      <h3 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Payment</h3>
      {payment ? (
        <Facts>
          <Fact label="Customer paid" value={<Cedis pesewas={payment.amount_pesewas} />} />
          <Fact label="Confirmed" value={when(payment.succeeded_at)} />
          <Fact label="Provider" value={payment.provider} />
          <Fact label="Reference" value={<span className="font-mono text-xs">{payment.id}</span>} />
        </Facts>
      ) : (
        <Empty>No succeeded payment on this order.</Empty>
      )}

      <h3 className="text-muted mt-5 mb-2 text-xs font-semibold tracking-wide uppercase">
        Paystack split
      </h3>
      {split ? (
        <Facts>
          <Fact
            label="Status"
            value={
              split.confirmed ? (
                <Badge tone="good">Split confirmed by Paystack</Badge>
              ) : (
                <Badge tone="warn">Awaiting Paystack&apos;s signed record</Badge>
              )
            }
          />
          <Fact label="Vendor share" value={<Cedis pesewas={split.vendorSharePesewas} />} />
          <Fact
            label="Credited to subaccount"
            value={
              split.subaccountCreditPesewas === null ? (
                '-'
              ) : (
                <Cedis pesewas={split.subaccountCreditPesewas} />
              )
            }
          />
          <Fact
            label="Subaccount"
            value={<span className="font-mono text-xs">{split.subaccountCode}</span>}
          />
          <Fact label="Split at (Paystack)" value={accraTime(split.paystackPaidAt) ?? '-'} />
          <Fact
            label="Paystack transaction"
            value={<span className="font-mono text-xs">{split.paystackTransactionId ?? '-'}</span>}
          />
        </Facts>
      ) : (
        <p className="text-muted text-sm">
          {channel === 'TRANSFER'
            ? "Not split. The store's share stayed in the Campus Dash balance and is a manual vendor payment, recorded on the Money page."
            : 'No Paystack split on this order.'}
        </p>
      )}

      {split ? (
        <>
          <h3 className="text-muted mt-5 mb-2 text-xs font-semibold tracking-wide uppercase">
            Vendor settlement
          </h3>
          <Facts>
            <Fact label="Status" value={<Badge tone={state.tone}>{state.label}</Badge>} />
            {settlement.settlement ? (
              <>
                <Fact
                  label="Settlement"
                  value={<span className="font-mono text-xs">{settlement.settlement.id}</span>}
                />
                <Fact
                  label="Settlement date"
                  value={accraTime(settlement.settlement.settlementDate) ?? 'not reported'}
                />
                <Fact
                  label="Settlement amount"
                  value={
                    settlement.settlement.totalAmountPesewas === null ? (
                      'not reported'
                    ) : (
                      <Cedis pesewas={settlement.settlement.totalAmountPesewas} />
                    )
                  }
                />
              </>
            ) : null}
            {settlement.fetchedAt ? (
              <Fact label="Read from Paystack" value={accraTime(settlement.fetchedAt)} />
            ) : null}
          </Facts>
          <p className="text-muted mt-2 text-xs leading-relaxed">
            {SETTLEMENT_NOTE[settlement.state] ?? ''}
          </p>
        </>
      ) : null}
    </Panel>
  );
}

const SETTLEMENT_NOTE = {
  SETTLED:
    "Paystack lists this charge in a successful settlement to the store's destination. Whether the store's bank or network has shown it in their balance is theirs to confirm.",
  PROCESSING: 'Paystack lists this charge in a settlement it has not finished.',
  PENDING: 'Paystack lists this charge in a settlement it has not paid out yet.',
  FAILED:
    'Paystack lists this charge in a settlement that failed. The money has not reached the store. Check the subaccount in the Paystack dashboard.',
  NOT_FOUND:
    "No settlement Paystack returned contains this charge yet. The money is in the store's subaccount and has not been paid out to them.",
  INCOMPLETE:
    'This charge was not in the settlements that were read, but Paystack returned more than could be checked. It is not established either way.',
  UNAVAILABLE:
    'Paystack could not be asked about settlements from this deployment, so nothing is claimed either way.',
  UNKNOWN: 'Paystack reported a settlement status Campus Dash does not recognise.',
};
