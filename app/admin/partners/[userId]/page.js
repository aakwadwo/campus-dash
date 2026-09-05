import Link from 'next/link';
import { notFound } from 'next/navigation';
import { partnerDetail } from '@/lib/admin';
import { requireAdmin } from '@/lib/auth/session';
import { Panel, Badge, Facts, Fact, Table, Row, Cell, Cedis, Empty, when } from '../../ui';
import AccountSuspension from '../../account-suspension';
import PurgeDocumentsForm from './purge-documents-form';

export const dynamic = 'force-dynamic';

const TONE = {
  PENDING_REVIEW: 'warn',
  APPROVED: 'good',
  REJECTED: 'bad',
  SUSPENDED: 'bad',
  NOT_APPLIED: 'neutral',
};

/**
 * One Partner — what they have actually done.
 *
 * The review queue at /admin/partners is where approval happens, because that
 * is where the ID and the face photograph are shown side by side and a decision
 * is made. This page is the other half: activity, earnings and liabilities for
 * somebody already in the system.
 *
 * Document paths are not returned by admin_partner_detail(); only whether each
 * one exists. Reviewing the images stays on the queue screen, through the
 * existing signed-URL mechanism.
 */
export default async function AdminPartnerPage({ params }) {
  const { userId } = await params;
  const me = await requireAdmin();

  const p = await partnerDetail(userId).catch(() => null);
  if (!p) notFound();

  const deliveries = Array.isArray(p.recent_deliveries) ? p.recent_deliveries : [];

  return (
    <>
      <p className="text-muted mb-2 text-sm">
        <Link href="/admin/partners" className="underline underline-offset-4">
          Partners
        </Link>
      </p>

      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{p.full_name ?? p.phone}</h1>
        <Badge tone={TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
        {p.is_suspended ? <Badge tone="bad">Account suspended</Badge> : null}
        <Badge tone={p.is_available ? 'good' : 'neutral'}>
          {p.is_available ? 'Online' : 'Offline'}
        </Badge>
        <Link href={`/admin/customers/${p.user_id}`} className="text-brand-700 text-sm underline">
          Customer record →
        </Link>
      </div>

      {p.active_order_id ? (
        <p className="bg-warn-bg text-warn mb-6 rounded px-4 py-3 text-sm">
          Currently carrying{' '}
          <Link
            href={`/admin/orders/${p.active_order_id}`}
            className="font-mono underline underline-offset-4"
          >
            {p.active_order_number}
          </Link>
          . A Partner carries one delivery at a time.
        </p>
      ) : null}

      <Panel title="Verification" description="Images are reviewed on the applications screen.">
        <Facts>
          <Fact label="Status" value={p.status} />
          <Fact label="Applied" value={when(p.applied_at)} />
          <Fact label="Reviewed" value={when(p.reviewed_at)} />
          <Fact label="Reviewed by" value={p.reviewed_by_name} />
          {p.review_notes ? <Fact label="Review notes" value={p.review_notes} /> : null}
          <Fact
            label="Live face photograph"
            value={
              p.has_face_image ? (
                <span className="text-brand-700">On file (private)</span>
              ) : (
                <span className="text-bad">Missing</span>
              )
            }
          />
          <Fact
            label="Student ID photograph"
            value={
              p.has_student_id ? (
                <span className="text-brand-700">On file (private)</span>
              ) : (
                <span className="text-bad">Missing</span>
              )
            }
          />
        </Facts>
      </Panel>

      <Panel title="Identity">
        <Facts>
          <Fact label="Name" value={p.full_name} />
          <Fact label="Phone" value={<span className="font-mono">{p.phone}</span>} />
          <Fact label="Email" value={p.email} />
          <Fact
            label="Student ID number"
            value={<span className="font-mono">{p.student_id_number}</span>}
          />
          <Fact label="Class year" value={p.class_year} />
        </Facts>
      </Panel>

      <Panel
        title="Money"
        description="Earned is everything ever allocated; owed is what has not been settled."
      >
        <Facts>
          <Fact label="Deliveries completed" value={p.deliveries_completed} />
          <Fact label="Deliveries failed" value={p.deliveries_failed} />
          <Fact label="Earned in total" value={<Cedis pesewas={p.earned_pesewas} />} />
          <Fact label="Currently owed" value={<Cedis pesewas={p.owed_pesewas} />} />
          <Fact label="Paid out" value={<Cedis pesewas={p.paid_pesewas} />} />
        </Facts>
      </Panel>

      {/* TWO DIFFERENT DECISIONS, kept apart on purpose. Suspending the ACCOUNT
          removes every capability the person holds, ordering included; the
          review queue's SUSPENDED decision withdraws only the Partner
          capability and leaves them able to buy lunch. Merging the two would
          make one of them impossible to express. */}
      <Panel
        title="Account status"
        description="Suspension applies to the person, not to the Partner capability alone. To withdraw only the Partner capability, use the review decision on the applications screen."
      >
        <AccountSuspension
          userId={p.user_id}
          name={p.full_name ?? p.phone}
          isSuspended={p.is_suspended}
          isSelf={p.user_id === me.user_id}
          capabilities="ordering AND carrying deliveries"
        />
      </Panel>

      <Panel
        title="Verification documents"
        description="Deletion is permanent. Retention policy lives in docs/PARTNER.md."
      >
        <PurgeDocumentsForm
          userId={p.user_id}
          name={p.full_name ?? p.phone}
          hasFaceImage={p.has_face_image}
        />
      </Panel>

      <Panel title="Recent deliveries" description="Most recent twenty.">
        {deliveries.length === 0 ? (
          <Empty>No deliveries yet.</Empty>
        ) : (
          <Table head={['Order', 'Type', 'Delivery', 'Earned', 'Delivered']} minWidth="40rem">
            {deliveries.map((d) => (
              <Row key={d.order_id}>
                <Cell>
                  <Link
                    href={`/admin/orders/${d.order_id}`}
                    className="text-brand-700 font-mono text-xs underline underline-offset-4"
                  >
                    {d.order_number}
                  </Link>
                </Cell>
                <Cell>
                  <Badge tone={d.order_type === 'SCAN' ? 'warn' : 'neutral'}>{d.order_type}</Badge>
                </Cell>
                <Cell mono muted>
                  {d.delivery_status}
                </Cell>
                <Cell numeric>
                  <Cedis pesewas={d.earnings_pesewas} />
                </Cell>
                <Cell muted>{when(d.delivered_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
