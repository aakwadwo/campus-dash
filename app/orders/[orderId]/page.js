import { notFound } from 'next/navigation';
import { requireCustomer } from '@/lib/auth/session';
import { getMyOrder } from '@/lib/customer';
import { getPollIntervals } from '@/lib/platform-config';
import SiteHeader from '../../site-header';
import { STAGE } from '../stage';
import OrderStatus from './order-status';
import {
  Container,
  Card,
  Badge,
  Money,
  Timeline,
  Fact,
  Facts,
  Callout,
  LiveDot,
  ArrowLeftIcon,
} from '../../ui';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * One order, tracked.
 *
 * A FOCUSED, NARROW COLUMN. This is the most-refreshed screen in the product —
 * somebody watching their lunch — so it drops the marketplace's width and puts
 * one thing at the top: what is happening now.
 *
 * NO MAP, DELIBERATELY. Campus Dash has no GPS and no live tracking, so the
 * progress is expressed as steps that have or have not happened. The references
 * put a map above the same timeline; showing a map we cannot populate would be
 * inventing a capability.
 */

/**
 * Turns the server's single `stage` into a list of steps.
 *
 * Derived entirely from the stage the database computed — this never decides
 * what state an order is in, only how a state is drawn. Pickup and delivery
 * have genuinely different journeys, so they get different step lists rather
 * than one list with the irrelevant half greyed out.
 */
function stepsFor(order) {
  const stage = order.stage;
  const pickup = order.fulfilment_type === 'PICKUP';

  const at = (value) =>
    value
      ? new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : null;

  // Terminal states that ended the journey early get their own short list: a
  // half-finished timeline with four grey steps below it reads as "still
  // going", which is the opposite of the truth.
  if (['REJECTED', 'EXPIRED', 'CANCELLED', 'PAYMENT_FAILED'].includes(stage)) {
    return [
      { label: 'Order placed', state: 'done', at: at(order.submitted_at) },
      {
        label: STAGE[stage]?.label ?? stage,
        state: 'failed',
        detail: order.cancellation_reason ?? STAGE[stage]?.detail,
      },
    ];
  }

  const order_ = [
    { key: 'placed', label: 'Order placed', at: at(order.submitted_at) },
    { key: 'accepted', label: 'Vendor accepted your order', at: at(order.accepted_at) },
    { key: 'paid', label: 'Payment confirmed' },
    { key: 'preparing', label: 'Your order is being prepared' },
    {
      key: 'ready',
      label: pickup ? 'Ready to collect' : 'Ready for a Partner to collect',
      at: at(order.ready_at),
    },
    ...(pickup
      ? []
      : [
          { key: 'searching', label: 'Finding a Partner' },
          { key: 'assigned', label: 'Partner is collecting your order' },
          { key: 'otw', label: 'On the way to you' },
        ]),
    { key: 'done', label: pickup ? 'Collected' : 'Delivered', at: at(order.completed_at) },
  ];

  // Where the order has got to, expressed as an index into the list above.
  const reached = {
    AWAITING_VENDOR: 'placed',
    PAYMENT_REQUIRED: 'accepted',
    PAYMENT_PROCESSING: 'accepted',
    PAID_AWAITING_KITCHEN: 'paid',
    PREPARING: 'preparing',
    READY: 'ready',
    SEARCHING_PARTNER: 'searching',
    NO_PARTNER: 'searching',
    PARTNER_ASSIGNED: 'assigned',
    ON_THE_WAY: 'otw',
    CUSTOMER_ABSENT: 'otw',
    COMPLETED: 'done',
  }[stage];

  const currentIndex = order_.findIndex((s) => s.key === reached);

  return order_.map((step, index) => ({
    label: step.label,
    at: index <= currentIndex ? step.at : null,
    state:
      currentIndex === -1
        ? 'todo'
        : index < currentIndex
          ? 'done'
          : index === currentIndex
            ? stage === 'COMPLETED'
              ? 'done'
              : 'current'
            : 'todo',
  }));
}

export default async function CustomerOrderPage({ params }) {
  const { orderId } = await params;
  // The capabilities come back from the database on this request; `email` is
  // read from them so the pay button can ask for one when the provider needs it.
  const me = await requireCustomer(`/orders/${orderId}`);

  // Returns nothing unless the order belongs to the signed-in customer, so
  // another customer's id lands on a 404 rather than a message confirming it
  // exists.
  const [order, intervals] = await Promise.all([getMyOrder(orderId), getPollIntervals()]);
  if (!order) notFound();

  const stage = STAGE[order.stage] ?? { label: order.stage, tone: '', detail: null };
  const live = !['COMPLETED', 'REJECTED', 'EXPIRED', 'CANCELLED'].includes(order.stage);

  return (
    <div className="min-h-dvh">
      <SiteHeader active="orders" />

      <main className="pb-24 sm:pb-16">
        <Container size="narrow" className="pt-6 sm:pt-10">
          <Link
            href="/orders"
            className="text-muted hover:text-ink press-sm mb-6 -ml-1 inline-flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-sm font-medium transition-colors"
          >
            <ArrowLeftIcon className="size-4" />
            My orders
          </Link>

          {/* The headline: one sentence saying what is happening, centred and
              large, the way the references treat a status screen. */}
          <header className="text-center">
            <p className="text-muted text-sm">{order.vendor_name}</p>
            <h1 className={`text-display mt-2 text-3xl font-semibold sm:text-4xl ${stage.tone}`}>
              {stage.label}
            </h1>
            {stage.detail ? (
              <p className="text-muted mx-auto mt-3 max-w-sm leading-relaxed">{stage.detail}</p>
            ) : null}
            {order.cancellation_reason ? (
              <p className="mt-3 text-sm">Reason: {order.cancellation_reason}</p>
            ) : null}
            <p className="text-faint mt-4 flex items-center justify-center gap-2 font-mono text-xs">
              {live ? <LiveDot tone={stage.badge === 'bad' ? 'bad' : 'good'} /> : null}
              {order.order_number}
            </p>
          </header>

          {/* Whatever the customer can DO right now — pay, give a code, decide
              what happens when nobody took the delivery. */}
          <div className="mt-8">
            <OrderStatus order={order} email={me.email ?? null} pollMs={intervals.customerMs} />
          </div>

          <Card className="mt-6 p-5 sm:p-6">
            <h2 className="text-muted mb-5 text-xs font-semibold tracking-[0.14em] uppercase">
              Progress
            </h2>
            <Timeline steps={stepsFor(order)} />
          </Card>

          <Card className="mt-4 p-5 sm:p-6">
            <h2 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
              Your order
            </h2>
            <ul className="divide-line divide-y">
              {order.items.map((item, index) => (
                <li key={index} className="flex items-baseline justify-between gap-4 py-2.5">
                  <span className="min-w-0">
                    <span className="bg-surface-2 mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                      {item.quantity}×
                    </span>
                    {item.name}
                  </span>
                  <span className="text-muted shrink-0 text-sm">
                    <Money pesewas={item.line_total_pesewas} />
                  </span>
                </li>
              ))}
            </ul>

            <dl className="border-line mt-4 border-t pt-4">
              <Line label="Food" value={order.subtotal_pesewas} />
              <Line label="Service fee" value={order.service_fee_pesewas} />
              {order.delivery_fee_pesewas > 0 ? (
                <Line label="Delivery fee" value={order.delivery_fee_pesewas} />
              ) : null}
              <div className="border-line mt-2 flex items-baseline justify-between gap-4 border-t pt-3">
                <dt className="font-semibold">Total</dt>
                <dd className="text-lg font-semibold">
                  <Money pesewas={order.total_pesewas} />
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="mt-4 p-5 sm:p-6">
            <h2 className="text-muted mb-2 text-xs font-semibold tracking-[0.14em] uppercase">
              Details
            </h2>
            <Facts>
              <Fact
                label="Fulfilment"
                value={
                  <Badge tone="neutral">
                    {order.fulfilment_type === 'PICKUP' ? 'You collect' : 'Delivered to you'}
                  </Badge>
                }
              />
              {order.destination ? <Fact label="Destination" value={order.destination} /> : null}
              {order.destination_note ? <Fact label="Note" value={order.destination_note} /> : null}
              {order.partner_name ? <Fact label="Partner" value={order.partner_name} /> : null}
            </Facts>

            {order.fulfilment_type === 'DELIVERY' && order.order_status === 'READY' ? (
              <Callout className="mt-4">
                Your food is ready. A Partner will be found to bring it to you.
              </Callout>
            ) : null}
          </Card>
        </Container>
      </main>
    </div>
  );
}

function Line({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-muted text-sm">{label}</dt>
      <dd className="text-sm">
        <Money pesewas={value} />
      </dd>
    </div>
  );
}
