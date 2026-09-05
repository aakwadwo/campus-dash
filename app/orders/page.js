import Link from 'next/link';
import { requireCustomer } from '@/lib/auth/session';
import { listMyOrders } from '@/lib/customer';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import { STAGE } from './stage';
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
} from '../ui';

export const metadata = { title: 'My orders · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Order history.
 *
 * Live orders come first and are visually louder — an order in flight is the
 * only thing on this page anyone opens it for. Everything settled reads as a
 * record: same layout, quieter type.
 */
const LIVE = new Set([
  'AWAITING_VENDOR',
  'PAYMENT_REQUIRED',
  'PAYMENT_PROCESSING',
  'PAID_AWAITING_KITCHEN',
  'PREPARING',
  'READY',
  'SEARCHING_PARTNER',
  'PARTNER_ASSIGNED',
  'ON_THE_WAY',
  'NO_PARTNER',
]);

export default async function MyOrdersPage() {
  await requireCustomer('/orders');
  const orders = await listMyOrders();

  const live = orders.filter((o) => LIVE.has(o.stage));
  const past = orders.filter((o) => !LIVE.has(o.stage));

  return (
    <div className="min-h-dvh">
      <SiteHeader active="orders" />

      <main className="pb-24 sm:pb-0">
        <Container className="pt-8 sm:pt-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-display text-3xl font-semibold sm:text-4xl">My orders</h1>
            <ButtonLink href="/order" variant="secondary" size="sm">
              Order something
            </ButtonLink>
          </div>

          {orders.length === 0 ? (
            <Card className="mt-8">
              <EmptyState
                icon={<ReceiptIcon className="size-6" />}
                title="No orders yet"
                description="When you order from a vendor around campus, it will show up here with its live status."
                action={<ButtonLink href="/order">Browse vendors</ButtonLink>}
              />
            </Card>
          ) : null}

          {live.length ? (
            <section className="mt-8">
              <h2 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
                In progress
              </h2>
              <ul className="stagger space-y-3">
                {live.map((order) => (
                  <li key={order.order_id}>
                    <OrderRow order={order} emphasis />
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
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}

function OrderRow({ order, emphasis = false }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'neutral' };

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className={`press bg-surface rounded-card hover:border-line-strong flex items-center gap-4 border p-3 transition-colors sm:p-4 ${
        emphasis ? 'border-brand-600/40' : 'border-line'
      }`}
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
          <span className="text-faint font-mono text-xs">{order.order_number}</span>
          <span className="text-muted text-xs">
            {order.fulfilment_type === 'PICKUP' ? 'Collect' : 'Delivery'}
          </span>
        </div>
      </div>

      <ChevronRightIcon className="text-faint hidden size-5 shrink-0 sm:block" />
    </Link>
  );
}
