import Link from 'next/link';
import { dashboard, dashboardTotals, orderBoard } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Cedis, Table, Row, Cell } from './ui';

export const dynamic = 'force-dynamic';

/**
 * The operating console.
 *
 * WHAT THIS PAGE USED TO BE: twenty-six tiles across four headed sections, most
 * of them zero, followed by a table of cron jobs. It reported the SYSTEM —
 * webhook counts, scheduler status, allocation internals — and left the
 * questions an operator actually has unanswered: how much have we sold, what
 * did we earn, who is waiting on us.
 *
 * It now answers those, in the order somebody asks them:
 *
 *   1. Is anybody waiting on me?      approvals, and only when there are some
 *   2. What is the business doing?    orders and money, as running totals
 *   3. What is happening right now?   active work
 *   4. What just happened?            the last few orders
 *
 * EVERY NUMBER IS COUNTED, from the ledger the payment architecture already
 * writes. Nothing here is estimated, projected or sampled, and nothing here
 * decides anything — this page is a read.
 */
export default async function AdminOverviewPage() {
  const [data, totals, recent] = await Promise.all([
    dashboard().catch(() => null),
    dashboardTotals().catch(() => null),
    orderBoard({ limit: 8 }).catch(() => null),
  ]);

  // Null means the database declined, not that the business is empty. Saying
  // "0 orders" when we actually failed to ask would be a lie an operator could
  // act on.
  if (!data) {
    return (
      <>
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Dashboard</h1>
        <Unavailable>
          The dashboard could not be loaded. This is not the same as there being no activity, so do
          not treat it as an empty day.
        </Unavailable>
      </>
    );
  }

  const ops = data.operations ?? {};
  const money = data.money ?? {};
  const people = data.people ?? {};
  const t = totals ?? {};

  const vendorsPending = Number(t.vendors_pending ?? 0);
  const partnersPending = Number(t.partners_pending ?? people.partners_pending ?? 0);
  const activeNow = Number(t.orders_active ?? 0);
  // Nothing has been paid for, so every money figure below is a true zero and
  // none of them is worth six tiles.
  const nothingSold = Number(t.orders_total ?? 0) === 0 && Number(t.total_sales ?? 0) === 0;

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="text-muted mt-1 text-sm">
        Everything Campus Dash has handled, and what is open.
      </p>

      {/* 1. WAITING ON YOU — rendered only when something is. An approvals
             panel that permanently reads "0 waiting" trains people to skip the
             top of the page, which is the one place that must not be skippable. */}
      {vendorsPending > 0 || partnersPending > 0 ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {vendorsPending > 0 ? (
            <Approval
              count={vendorsPending}
              noun={vendorsPending === 1 ? 'vendor' : 'vendors'}
              label="Pending vendor approvals"
              action="Review vendors"
              href="/admin/vendors?status=PENDING_APPROVAL"
            />
          ) : null}
          {partnersPending > 0 ? (
            <Approval
              count={partnersPending}
              noun={partnersPending === 1 ? 'Partner' : 'Partners'}
              label="Pending Partner approvals"
              action="Review Partners"
              href="/admin/partners?status=PENDING_REVIEW"
            />
          ) : null}
        </div>
      ) : null}

      {/* 2. THE BUSINESS. Six figures that add up the way somebody expects:
             what customers paid, then who it belongs to.

             NOT SHOWN BEFORE THERE IS ANYTHING TO SHOW. Six tiles all reading
             GH₵0.00 is worse than no tiles: it fills the most valuable part of
             the page with the appearance of information and teaches whoever
             reads it daily that this band is noise. Before the first paid order
             it says so in one line instead. */}
      <Section title="Money">
        {nothingSold ? (
          <p className="text-muted border-line rounded-card bg-surface border p-4 text-sm">
            No orders have been paid for yet, so there is nothing to report. Sales, revenue and what
            is owed to stores and Partners will appear here from the first order.
          </p>
        ) : (
          <>
            <div className="border-line rounded-card bg-surface divide-line grid divide-y border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Figure label="Total sales" value={<Cedis pesewas={t.total_sales} />} emphasis />
              <Figure
                label="Campus Dash revenue"
                value={<Cedis pesewas={money.platform_earned} />}
                hint="Service fees earned, before Paystack costs"
              />
              <Figure
                label="Orders processed"
                value={Number(t.orders_total ?? 0).toLocaleString('en-GB')}
                hint="Paid for"
              />
            </div>

            <div className="border-line rounded-card bg-surface divide-line mt-3 grid divide-y border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Figure
                label="Vendor sales"
                value={<Cedis pesewas={t.vendor_sales} />}
                hint="Routed to stores at the charge"
              />
              <Figure
                label="Partner earnings"
                value={<Cedis pesewas={t.partner_earnings} />}
                hint="Earned on completed deliveries"
              />
              <Figure
                label="Pending Partner payouts"
                value={<Cedis pesewas={t.partner_payouts_pending} />}
                hint="Raised, not yet sent"
                href="/admin/pilot"
              />
            </div>
          </>
        )}
      </Section>

      {/* 3. RIGHT NOW. Three numbers, not eight — the ones that mean somebody
             may have to do something in the next hour. */}
      <Section title="Right now">
        <div className="border-line rounded-card bg-surface divide-line grid divide-y border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Figure label="Active orders" value={activeNow} href="/admin/orders" />
          <Figure label="Orders today" value={Number(ops.orders_today ?? 0)} href="/admin/orders" />
          <Figure
            label="Needs a decision"
            value={Number(ops.needs_attention ?? 0)}
            tone={Number(ops.needs_attention) > 0 ? 'bad' : 'neutral'}
            href="/admin/orders?attention=DISPUTED"
          />
        </div>
      </Section>

      {/* 4. WHAT JUST HAPPENED. Eight rows, not a board — the board is a click
             away and this is only here to show the platform is alive. */}
      <Section
        title="Recent orders"
        action={
          <Link href="/admin/orders" className="text-brand-700 text-sm font-medium">
            All orders
          </Link>
        }
      >
        {recent === null ? (
          <Unavailable>Recent orders could not be loaded.</Unavailable>
        ) : recent.length === 0 ? (
          <Empty>No orders yet.</Empty>
        ) : (
          <Table head={['Order', 'Customer', 'Vendor', 'Amount', 'Status']} minWidth="38rem">
            {recent.map((order) => (
              <Row key={order.order_id}>
                <Cell>
                  <Link
                    href={`/admin/orders/${order.order_id}`}
                    className="text-brand-700 font-medium"
                  >
                    {order.order_number}
                  </Link>
                </Cell>
                <Cell muted>{order.customer_name ?? '-'}</Cell>
                <Cell muted>{order.vendor_name ?? '-'}</Cell>
                <Cell>
                  <Cedis pesewas={order.total_pesewas} />
                </Cell>
                <Cell>
                  <Badge tone={order.order_status === 'CANCELLED' ? 'bad' : 'neutral'}>
                    {String(order.order_status).toLowerCase().replace(/_/g, ' ')}
                  </Badge>
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
    </>
  );
}

/** A headed band. One rhythm for the whole page rather than per-section guesses. */
function Section({ title, action, children }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * One figure in a band.
 *
 * A cell in a shared bordered row rather than its own card: five cards in a
 * grid read as five unrelated things, and these are five views of one number.
 */
function Figure({ label, value, hint, tone = 'neutral', emphasis = false, href }) {
  const tones = { neutral: 'text-ink', good: 'text-good', warn: 'text-warn', bad: 'text-bad' };
  const body = (
    <>
      <p className="text-muted text-xs font-medium">{label}</p>
      <p
        className={`mt-1 font-semibold tabular-nums ${emphasis ? 'text-2xl' : 'text-xl'} ${tones[tone]}`}
      >
        {value}
      </p>
      {hint ? <p className="text-faint mt-1 text-xs leading-snug">{hint}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className="hover:bg-surface-2 block p-4 transition-colors">
      {body}
    </Link>
  ) : (
    <div className="p-4">{body}</div>
  );
}

/** Somebody is waiting. Says who, how many, and what to do about it. */
function Approval({ count, noun, label, action, href }) {
  return (
    <div className="border-brand-700/25 bg-brand-50 rounded-card flex items-center gap-4 border p-4">
      <span className="bg-brand-700 grid size-11 shrink-0 place-items-center rounded-full text-lg font-semibold text-white tabular-nums">
        {count}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-muted text-xs">
          {count} {noun} waiting on a decision
        </p>
      </div>
      <Link
        href={href}
        className="press border-line-strong bg-surface hover:bg-surface-2 ml-auto shrink-0 rounded-full border px-4 py-2 text-sm font-semibold whitespace-nowrap"
      >
        {action}
      </Link>
    </div>
  );
}
