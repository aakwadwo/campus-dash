import Link from 'next/link';
import { requireCustomer } from '@/lib/auth/session';
import { listMyOrders, getMyOrderSummary } from '@/lib/customer';
import { orderLabel } from '@/lib/orders/state';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import { STAGE, LIVE_STAGES } from './stage';
import RewardProgress from '../reward-progress';
import {
  Container,
  Card,
  Badge,
  Money,
  EmptyState,
  ButtonLink,
  ImagePlaceholder,
  ChevronRightIcon,
  ReceiptIcon,
  LiveDot,
} from '../ui';

export const metadata = { title: 'My orders · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Order history, and the one live order on top of it.
 *
 * An order in flight is the only thing anybody opens this page for, so it gets
 * a card of its own with the thing that is actually happening spelled out —
 * including who is bringing it, once somebody has taken the job. Everything
 * settled reads as a record: same information, quieter type.
 */
export default async function MyOrdersPage() {
  await requireCustomer('/orders');
  const [orders, summary] = await Promise.all([listMyOrders(50), getMyOrderSummary()]);

  const live = orders.filter((o) => LIVE_STAGES.has(o.stage));
  const past = orders.filter((o) => !LIVE_STAGES.has(o.stage));

  return (
    <div className="min-h-dvh">
      <SiteHeader active="orders" />

      <main className="pb-24 sm:pb-0">
        <Container className="pt-8 sm:pt-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-display text-3xl font-semibold sm:text-4xl">My orders</h1>
              <p className="text-muted mt-1.5 text-sm">
                {summary.total_orders === 0
                  ? 'Nothing yet.'
                  : `${summary.total_orders} order${summary.total_orders === 1 ? '' : 's'} · ${summary.completed_orders} completed`}
              </p>
            </div>
            <ButtonLink href="/order" variant="secondary" size="sm">
              Order something
            </ButtonLink>
          </div>

          {orders.length === 0 ? (
            <Card className="mt-8">
              <EmptyState
                icon={<ReceiptIcon className="size-6" />}
                title="No orders yet"
                description="When you order from a store around campus, it will show up here with its live status."
                action={<ButtonLink href="/order">Browse stores</ButtonLink>}
              />
            </Card>
          ) : null}

          {live.length ? (
            <section className="mt-8">
              <h2 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
                In progress
              </h2>
              <ul className="space-y-3">
                {live.map((order) => (
                  <li key={order.order_id}>
                    <ActiveOrderCard order={order} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {past.length ? (
            <section className="mt-10">
              <h2 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
                Past orders
              </h2>
              <ul className="space-y-3">
                {past.map((order) => (
                  <li key={order.order_id}>
                    <OrderRow order={order} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Under the orders, not over them. It counts what is above it. */}
          <RewardProgress className="mt-10" />
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * A live order, told as a sentence.
 *
 * The Partner's first name goes here the moment somebody accepts — "Kwame has
 * accepted your order" is the update people actually want, and it arrives while
 * the food is still cooking now that dispatch opens at payment.
 */
function ActiveOrderCard({ order }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'brand', detail: null };
  const headline = partnerHeadline(order) ?? stage.label;

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className="press bg-surface rounded-card border-brand-600/40 hover:border-brand-600 block border p-4 transition-colors sm:p-5"
    >
      <div className="flex items-start gap-4">
        <ImagePlaceholder
          name={order.vendor_name}
          ratio="aspect-square"
          className="w-14 shrink-0 sm:w-16"
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <LiveDot tone={stage.badge === 'bad' ? 'bad' : 'good'} />
            <span className={stage.tone}>{headline}</span>
          </p>
          <p className="mt-1 truncate font-semibold">{order.vendor_name}</p>
          <p className="text-muted mt-1 text-sm leading-relaxed">{stage.detail}</p>
          <Meta order={order} />
        </div>
        <ChevronRightIcon className="text-faint mt-1 hidden size-5 shrink-0 sm:block" />
      </div>
    </Link>
  );
}

function OrderRow({ order }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'neutral' };

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className="press bg-surface rounded-card border-line hover:border-line-strong flex items-center gap-4 border p-3 transition-colors sm:p-4"
    >
      <ImagePlaceholder
        name={order.vendor_name}
        ratio="aspect-square"
        className="w-14 shrink-0 sm:w-16"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate font-semibold">{order.vendor_name}</p>
          <span className="shrink-0 font-semibold">
            <Money pesewas={order.total_pesewas} />
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Badge tone={stage.badge ?? 'neutral'}>{stage.label}</Badge>
        </div>
        <Meta order={order} />
      </div>

      <ChevronRightIcon className="text-faint hidden size-5 shrink-0 sm:block" />
    </Link>
  );
}

/**
 * The facts a receipt needs: which order, when, how, how much.
 *
 * One line, wrapping, rather than a grid of labelled fields — this is a list
 * row and the labels would outweigh the values.
 */
function Meta({ order }) {
  return (
    <p className="text-muted mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-ink font-semibold tabular-nums">#{orderLabel(order)}</span>
      <span className="text-faint">·</span>
      <span>{when(order.completed_at ?? order.submitted_at)}</span>
      <span className="text-faint">·</span>
      <span>{order.fulfilment_type === 'PICKUP' ? 'Collected' : 'Partner delivery'}</span>
      <span className="text-faint">·</span>
      <span>
        {order.item_count} item{order.item_count === 1 ? '' : 's'}
      </span>
      <span className="text-faint">·</span>
      <span className="text-ink font-semibold">
        <Money pesewas={order.total_pesewas} />
      </span>
    </p>
  );
}

/** "Kwame has accepted your order." The name comes from the server, first only. */
function partnerHeadline(order) {
  if (!order.partner_first_name) return null;
  if (order.stage === 'ON_THE_WAY') return `${order.partner_first_name} is on the way`;
  if (order.stage === 'PARTNER_ASSIGNED') {
    return `${order.partner_first_name} is collecting your order`;
  }
  if (order.stage === 'PREPARING_PARTNER_ASSIGNED') {
    return `${order.partner_first_name} has accepted your order`;
  }
  return null;
}

function when(value) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
