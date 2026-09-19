import { requireCustomer } from '@/lib/auth/session';
import { listMyOrders } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import { LIVE_STAGES } from './stage';
import OrderRow from './order-row';
import RewardProgress from '../reward-progress';
import { Container, ButtonLink } from '../ui';

export const metadata = {
  robots: { index: false, follow: false },
  title: 'My orders',
};
export const dynamic = 'force-dynamic';

/**
 * Order history.
 *
 * A LIST OF SUMMARIES. Each row is the store, what was ordered, the amount, the
 * stage and the date; everything else is on the order, one tap away. Orders in
 * progress sit on top because they are the only reason most people open this
 * page, and they are marked by colour rather than by a paragraph each.
 */
export default async function MyOrdersPage() {
  await requireCustomer('/orders');
  const orders = (await listMyOrders(50)).map((order) => ({
    ...order,
    image_url: vendorImageUrl(order.vendor_image_path),
  }));

  const live = orders.filter((o) => LIVE_STAGES.has(o.stage));
  const past = orders.filter((o) => !LIVE_STAGES.has(o.stage));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader active="orders" />

      <main className="flex-1 pb-24 sm:pb-0">
        <Container size="narrow" className="pt-8 sm:pt-12">
          <h1 className="text-display text-2xl font-semibold sm:text-4xl">My orders</h1>

          {orders.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-muted">No orders yet.</p>
              <ButtonLink href="/order" className="mt-5">
                Browse
              </ButtonLink>
            </div>
          ) : null}

          {live.length ? (
            <section className="mt-6">
              <h2 className="text-muted mb-1 text-sm font-semibold">In progress</h2>
              <ul className="divide-line divide-y">
                {live.map((order) => (
                  <li key={order.order_id}>
                    <OrderRow order={order} imageUrl={order.image_url} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {past.length ? (
            <section className="mt-8">
              {live.length ? <h2 className="text-muted mb-1 text-sm font-semibold">Past</h2> : null}
              <ul className="divide-line divide-y">
                {past.map((order) => (
                  <li key={order.order_id}>
                    <OrderRow order={order} imageUrl={order.image_url} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Under the orders, not over them. It counts what is above it. */}
          {orders.length ? <RewardProgress className="mt-10" /> : null}
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
