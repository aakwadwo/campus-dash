import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { listMyOrders, getMyOrderSummary } from '@/lib/customer';
import { outstandingTerms } from '@/lib/terms';
import { orderLabel } from '@/lib/orders/state';
import { STAGE, LIVE_STAGES } from '../orders/stage';
import RewardProgress from '../reward-progress';
import {
  Card,
  Badge,
  Money,
  EmptyState,
  ButtonLink,
  ImagePlaceholder,
  ChevronRightIcon,
  ReceiptIcon,
  LiveDot,
  TextLink,
} from '../ui';

export const metadata = { title: 'Your account · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * The account, which is to say: your orders.
 *
 * THE OLD SCREEN LED WITH SETTINGS — a name field, an email field and a list of
 * capability rows explaining the account model. That is a screen built around
 * how Campus Dash works rather than around why anybody opened it. Almost
 * nobody comes here to change their surname; they come to see what they
 * ordered, from where, and what it cost.
 *
 * So this is order history, with the live one on top, and settings are one tap
 * away in the sidebar.
 */
export default async function AccountPage() {
  const me = await requireUser();

  // A signed-in account with no CUSTOMER capability has no history to show.
  // Onboarding is the one thing they can do about that, so it is the page.
  if (!me.can_order) return <NotYetACustomer me={me} />;

  const [orders, summary, outstanding] = await Promise.all([
    listMyOrders(6),
    getMyOrderSummary(),
    outstandingTerms(),
  ]);

  const live = orders.filter((o) => LIVE_STAGES.has(o.stage));
  // A GLANCE, not a second copy of My orders. The full history lives at
  // /orders, one tap from here and from the header, so this shows the last
  // few and says where the rest are.
  const past = orders.filter((o) => !LIVE_STAGES.has(o.stage)).slice(0, 5);

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-display text-2xl font-semibold sm:text-3xl">
            {me.first_name ? `Hello, ${me.first_name}` : 'Your orders'}
          </h1>
          <p className="text-muted mt-1.5 text-sm">
            {summary.total_orders === 0
              ? 'You have not ordered anything yet.'
              : `${summary.total_orders} order${summary.total_orders === 1 ? '' : 's'} so far.`}
          </p>
        </div>
        <ButtonLink href="/order" size="sm">
          Order something
        </ButtonLink>
      </header>

      {outstanding?.length ? (
        <Link
          href="/terms"
          className="rounded-card bg-warn-bg text-warn mt-5 block px-4 py-3 text-sm"
        >
          <span className="font-semibold">Updated terms need your agreement.</span> Tap to read and
          accept.
        </Link>
      ) : null}

      {/* Three numbers, because "how many orders have I made" is a question
          people genuinely ask and counting a list is not an answer. */}
      <dl className="mt-6 grid grid-cols-3 gap-2.5">
        <Stat label="Orders" value={summary.total_orders} />
        <Stat label="Completed" value={summary.completed_orders} />
        <Stat label="Active" value={summary.active_orders} highlight={summary.active_orders > 0} />
      </dl>

      {live.length ? (
        <section className="mt-8">
          <h2 className="text-muted mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
            Happening now
          </h2>
          <ul className="space-y-3">
            {live.map((order) => (
              <li key={order.order_id}>
                <ActiveRow order={order} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 className="text-muted text-xs font-semibold tracking-[0.14em] uppercase">
            Recent orders
          </h2>
          {summary.total_orders > 0 ? (
            <TextLink href="/orders" className="text-sm">
              See all orders
            </TextLink>
          ) : null}
        </div>

        {past.length === 0 && live.length === 0 ? (
          <Card>
            <EmptyState
              icon={<ReceiptIcon className="size-6" />}
              title="No orders yet"
              description="Everything you order from a store around campus shows up here — what you bought, from where, and what it cost."
              action={<ButtonLink href="/order">Browse stores</ButtonLink>}
            />
          </Card>
        ) : (
          <ul className="space-y-3">
            {past.map((order) => (
              <li key={order.order_id}>
                <HistoryRow order={order} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <RewardProgress className="mt-8" />
    </div>
  );
}

function Stat({ label, value, highlight = false }) {
  return (
    <div
      className={`rounded-card border px-4 py-3.5 ${
        highlight ? 'border-brand-600/40 bg-brand-50' : 'border-line bg-surface'
      }`}
    >
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dt className="text-muted mt-0.5 text-xs font-medium">{label}</dt>
    </div>
  );
}

function ActiveRow({ order }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'brand', detail: null };
  const headline = partnerHeadline(order) ?? stage.label;

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className="press bg-surface rounded-card border-brand-600/40 hover:border-brand-600 flex items-start gap-4 border p-4 transition-colors"
    >
      <ImagePlaceholder
        name={order.vendor_name}
        ratio="aspect-square"
        className="w-12 shrink-0 sm:w-14"
      />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <LiveDot tone={stage.badge === 'bad' ? 'bad' : 'good'} />
          <span className={stage.tone}>{headline}</span>
        </p>
        <p className="mt-1 truncate font-semibold">{order.vendor_name}</p>
        <Meta order={order} />
      </div>
      <ChevronRightIcon className="text-faint mt-1 size-5 shrink-0" />
    </Link>
  );
}

function HistoryRow({ order }) {
  const stage = STAGE[order.stage] ?? { label: order.stage, badge: 'neutral' };

  return (
    <Link
      href={`/orders/${order.order_id}`}
      className="press bg-surface rounded-card border-line hover:border-line-strong flex items-center gap-4 border p-3.5 transition-colors"
    >
      <ImagePlaceholder
        name={order.vendor_name}
        ratio="aspect-square"
        className="w-12 shrink-0 sm:w-14"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate font-semibold">{order.vendor_name}</p>
          <span className="shrink-0 font-semibold">
            <Money pesewas={order.total_pesewas} />
          </span>
        </div>
        <div className="mt-1.5">
          <Badge tone={stage.badge ?? 'neutral'}>{stage.label}</Badge>
        </div>
        <Meta order={order} />
      </div>
      <ChevronRightIcon className="text-faint size-5 shrink-0" />
    </Link>
  );
}

function Meta({ order }) {
  return (
    <p className="text-muted mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="text-ink font-semibold tabular-nums">#{orderLabel(order)}</span>
      <span className="text-faint">·</span>
      <span>{when(order.completed_at ?? order.submitted_at)}</span>
      <span className="text-faint">·</span>
      <span>
        {order.fulfilment_type === 'PICKUP'
          ? order.stage === 'COMPLETED'
            ? 'Collected'
            : 'You collect'
          : 'Partner delivery'}
      </span>
      <span className="text-faint">·</span>
      <span>
        {order.item_count} item{order.item_count === 1 ? '' : 's'}
      </span>
    </p>
  );
}

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
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
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
          description="Your account exists. Adding your student details is what lets you place an order, and it takes a minute."
          action={<ButtonLink href="/signup">Finish signing up</ButtonLink>}
        />
      </Card>
    </div>
  );
}
