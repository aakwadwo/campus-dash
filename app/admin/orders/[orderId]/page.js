import Link from 'next/link';
import { notFound } from 'next/navigation';
import { orderMoney } from '@/lib/admin';
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

  const supabase = await createClient();
  const [{ data: order }, { data: events }, { data: items }] = await Promise.all([
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
      <p className="text-muted mb-2 text-sm">
        <Link href="/admin/orders" className="underline underline-offset-4">
          Orders
        </Link>
      </p>

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
                '—'
              )
            }
          />
          <Fact label="Customer phone" value={customer?.phone} />
          <Fact label={isScan ? 'Restaurant' : 'Vendor'} value={money.vendor_name} />
          <Fact label="Fulfilment" value={order.fulfilment_type} />
          <Fact
            label="Destination"
            value={
              destination ?? (order.fulfilment_type === 'PICKUP' ? 'Collected in person' : '—')
            }
          />
          <Fact label="Destination note" value={order.destination_note} />
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
                <p className="mt-4 rounded bg-red-50 px-4 py-3 text-sm text-red-800">
                  <strong>Requires admin decision.</strong> The restaurant would not honour this
                  scan. Campus Dash has no refund policy for this case, so nothing has moved
                  automatically: the customer is still charged and the Partner is still owed the
                  delivery fee. Use the overrides below once you have decided what should happen.
                </p>
              ) : null}

              <div className="mt-5 border-t border-black/5 pt-4">
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
            label={isScan ? 'Scan service fee (flat)' : 'Service fee (5% of food)'}
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
                <span className="text-muted">No vendor liability — the meal was prepaid</span>
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

        <p
          className={`mt-3 text-sm font-medium ${money.balances ? 'text-brand-700' : 'text-red-700'}`}
        >
          {money.balances
            ? '✓ Allocations balance against the order total.'
            : '✗ Allocations do NOT balance — this order needs investigating.'}
        </p>

        <p className="text-muted mt-2 text-xs">
          Paystack&apos;s processing fee is a platform expense and is not recorded anywhere in this
          ledger — it is never deducted from what a vendor or a Partner is owed.
        </p>

        <p className="text-muted mt-3 text-xs">
          Provider: {money.payment_provider ?? '—'} · txn{' '}
          <span className="font-mono">{money.provider_transaction_id ?? '—'}</span> ·{' '}
          {money.payment_txn_status ?? 'no payment'}
        </p>

        {money.allocations?.length ? (
          <div className="mt-4">
            <Table head={['Payee', 'Amount', 'Status', 'Settled']} minWidth="30rem">
              {money.allocations.map((a, i) => (
                <Row key={i}>
                  <Cell>{a.payee_type}</Cell>
                  <Cell numeric>
                    <Cedis pesewas={a.amount_pesewas} />
                  </Cell>
                  <Cell>{a.status}</Cell>
                  <Cell muted>{when(a.settled_at)}</Cell>
                </Row>
              ))}
            </Table>
          </div>
        ) : null}
      </Panel>

      {/* ---------------------------------------------------------------- */}
      <Panel title="Overrides" description="Every one of these is recorded with your reason.">
        <OrderOverrides order={order} />
      </Panel>

      <Panel title="History" description="Every attempted transition, accepted or rejected.">
        {events?.length ? (
          <ul className="divide-y divide-black/5 text-sm">
            {events.map((event, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <span className={`font-mono text-xs ${event.accepted ? '' : 'text-red-700'}`}>
                  {event.accepted ? '' : '✗ '}
                  {event.event}
                </span>
                <span className="text-muted text-xs">{event.actor_role}</span>
                {event.dimension ? (
                  <span className="text-muted text-xs">
                    {event.dimension}: {event.from_state ?? '—'} → {event.to_state ?? '—'}
                  </span>
                ) : null}
                {event.reason ? <span className="text-muted text-xs">— {event.reason}</span> : null}
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
