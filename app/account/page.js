import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listMyOrders } from '@/lib/customer';
import { outstandingTerms } from '@/lib/terms';
import { vendorImageUrl } from '@/lib/verification/documents';
import OrderRow from '../orders/order-row';
import RewardProgress from '../reward-progress';
import { Card, EmptyState, ButtonLink, ReceiptIcon, TextLink } from '../ui';

export const metadata = { title: 'Your account' };
export const dynamic = 'force-dynamic';

/**
 * The account, which is to say: your orders.
 *
 * Nobody comes here to change their surname; they come to see what they
 * ordered, from where, and what it cost. So this is the last few orders, in the
 * same rows My orders uses, and settings are one tap away in the sidebar.
 */
export default async function AccountPage() {
  const me = await requireUser();

  // A signed-in account with no CUSTOMER capability has no history to show.
  // Onboarding is the one thing they can do about that, so it is the page.
  if (!me.can_order) return <NotYetACustomer me={me} />;

  const [orders, outstanding] = await Promise.all([listMyOrders(5), outstandingTerms()]);
  const recent = orders.map((order) => ({
    ...order,
    image_url: vendorImageUrl(order.vendor_image_path),
  }));

  return (
    <div>
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">
        {me.first_name ? `Hello, ${me.first_name}` : 'Your account'}
      </h1>

      {outstanding?.length ? (
        <Link
          href="/terms"
          className="rounded-card bg-warn-bg text-warn mt-5 block px-4 py-3 text-sm"
        >
          <span className="font-semibold">Updated terms need your agreement.</span> Tap to read
          them.
        </Link>
      ) : null}

      <section className="mt-6">
        <div className="mb-1 flex items-baseline justify-between gap-4">
          <h2 className="font-semibold">Recent orders</h2>
          {recent.length ? (
            <TextLink href="/orders" className="text-sm">
              See all
            </TextLink>
          ) : null}
        </div>

        {recent.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-muted">No orders yet.</p>
            <ButtonLink href="/order" className="mt-5">
              Browse
            </ButtonLink>
          </div>
        ) : (
          <ul className="divide-line divide-y">
            {recent.map((order) => (
              <li key={order.order_id}>
                <OrderRow order={order} imageUrl={order.image_url} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <RewardProgress className="mt-8" />
    </div>
  );
}

/** Signed in, but ordering has not been unlocked. One thing to do about it. */
function NotYetACustomer({ me }) {
  return (
    <div>
      <h1 className="text-display text-2xl font-semibold sm:text-3xl">
        {me.first_name ? `Hello, ${me.first_name}` : 'Your account'}
      </h1>
      <Card className="mt-6">
        <EmptyState
          icon={<ReceiptIcon className="size-6" />}
          title="Finish signing up to order"
          description="Add your details and you can order."
          action={<ButtonLink href="/signup">Finish signing up</ButtonLink>}
        />
      </Card>
    </div>
  );
}
