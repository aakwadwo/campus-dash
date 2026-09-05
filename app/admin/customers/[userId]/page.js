import Link from 'next/link';
import { notFound } from 'next/navigation';
import { customerDetail } from '@/lib/admin';
import { requireAdmin } from '@/lib/auth/session';
import { Panel, Badge, Facts, Fact, Table, Row, Cell, Cedis, Empty, when } from '../../ui';
import AccountSuspension from '../../account-suspension';

export const dynamic = 'force-dynamic';

/**
 * One customer.
 *
 * WHAT THIS DELIBERATELY CANNOT DO: change anything. There is no form on this
 * page, because there is no admin function that edits a customer's identity —
 * name, student ID, class year and email are set by the person themselves at
 * onboarding, and `complete_customer_onboarding` writes against auth.uid().
 * An admin screen that appeared to edit them would either be a lie or would
 * require a new write path into somebody else's identity, which is exactly the
 * kind of thing that should not exist because a support screen felt incomplete.
 *
 * The student ID document is reported as present or absent. The path is not
 * returned by admin_customer_detail() at all.
 *
 * THE ONE EXCEPTION to "no forms here" is suspension, and it is not an edit to
 * the customer's identity: it flips `users.is_suspended`, which is an account
 * fact rather than a profile field, through an audited admin function that
 * re-checks is_admin() in the database.
 */
export default async function AdminCustomerPage({ params }) {
  const { userId } = await params;
  const me = await requireAdmin();

  // A malformed uuid makes the RPC raise rather than return; either way there
  // is no such customer, and 404 is the honest answer.
  const c = await customerDetail(userId).catch(() => null);
  if (!c) notFound();

  const orders = Array.isArray(c.recent_orders) ? c.recent_orders : [];

  return (
    <>
      <p className="text-muted mb-2 text-sm">
        <Link href="/admin/customers" className="underline underline-offset-4">
          Customers
        </Link>
      </p>

      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{c.full_name ?? c.phone}</h1>
        {c.is_suspended ? <Badge tone="bad">Suspended</Badge> : <Badge tone="good">Active</Badge>}
        {c.is_admin ? <Badge tone="warn">Admin</Badge> : null}
        {c.partner_status !== 'NOT_APPLIED' ? (
          <Link href={`/admin/partners/${c.user_id}`} className="text-brand-700 text-sm underline">
            Partner: {c.partner_status} →
          </Link>
        ) : null}
      </div>

      <Panel title="Identity" description="Set by the student at onboarding. Not editable here.">
        <Facts>
          <Fact label="Name" value={c.full_name} />
          <Fact label="Phone" value={<span className="font-mono">{c.phone}</span>} />
          <Fact label="Email" value={c.email} />
          <Fact
            label="Student ID number"
            value={<span className="font-mono">{c.student_id_number}</span>}
          />
          <Fact label="Class year" value={c.class_year} />
          <Fact
            label="Student ID photograph"
            value={
              c.has_student_id ? (
                <span className="text-brand-700">On file (private)</span>
              ) : (
                <span className="text-bad">Missing</span>
              )
            }
          />
          <Fact label="Onboarded" value={when(c.onboarded_at)} />
          <Fact label="Account created" value={when(c.created_at)} />
          <Fact
            label="Vendor staff at"
            value={c.vendor_names?.length ? c.vendor_names.join(', ') : 'not vendor staff'}
          />
          {c.partner_applied_at ? (
            <Fact label="Applied to be a Partner" value={when(c.partner_applied_at)} />
          ) : null}
        </Facts>
      </Panel>

      <Panel title="Activity">
        <Facts>
          <Fact label="Orders placed" value={c.order_count} />
          <Fact label="Completed" value={c.completed_count} />
          <Fact label="Paid in total" value={<Cedis pesewas={c.spent_pesewas} />} />
        </Facts>
      </Panel>

      <Panel
        title="Account status"
        description="Suspension applies to the person, not to one capability."
      >
        <AccountSuspension
          userId={c.user_id}
          name={c.full_name ?? c.phone}
          isSuspended={c.is_suspended}
          isSelf={c.user_id === me.user_id}
          capabilities={
            c.partner_status === 'APPROVED'
              ? 'ordering AND carrying deliveries'
              : 'ordering, and anything else this account can do'
          }
        />
      </Panel>

      <Panel title="Recent orders" description="Most recent twenty.">
        {orders.length === 0 ? (
          <Empty>This customer has not placed an order yet.</Empty>
        ) : (
          <Table head={['Order', 'Type', 'States', 'Total', 'Placed']} minWidth="40rem">
            {orders.map((o) => (
              <Row key={o.order_id}>
                <Cell>
                  <Link
                    href={`/admin/orders/${o.order_id}`}
                    className="text-brand-700 font-mono text-xs underline underline-offset-4"
                  >
                    {o.order_number}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={o.order_type === 'SCAN' ? 'warn' : 'neutral'}>{o.order_type}</Badge>
                </Cell>
                <Cell mono muted>
                  {o.order_status}/{o.payment_status}/{o.delivery_status}
                </Cell>
                <Cell numeric>
                  <Cedis pesewas={o.total_pesewas} />
                </Cell>
                <Cell muted>{when(o.created_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
