import Link from 'next/link';
import { customers as listCustomers } from '@/lib/admin';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, when } from '../ui';

export const dynamic = 'force-dynamic';

/**
 * Customers.
 *
 * A CUSTOMER IS A CAPABILITY, not an account type — this lists everyone holding
 * a customer_profiles row, which is exactly what "can place an order" means.
 * An account that also staffs a stall or carries deliveries appears here too,
 * because it genuinely is a customer as well.
 *
 * The student ID IMAGE is not on this page and its path is never returned by
 * the query behind it. Looking at somebody's ID is a deliberate act on their
 * own record, not something that happens while scanning a list.
 */
export default async function AdminCustomersPage({ searchParams }) {
  const params = (await searchParams) ?? {};
  const search = typeof params.q === 'string' && params.q.trim() ? params.q.trim() : null;

  const rows = await listCustomers({ search, limit: 200 }).catch(() => null);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Customers</h1>
      <p className="text-muted mb-5 text-sm">
        Everyone who has completed student onboarding. Identity documents stay private, so open a
        record to review one.
      </p>

      <form method="get" action="/admin/customers" className="mb-6 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-muted text-xs font-semibold uppercase">Search</span>
          <input
            name="q"
            defaultValue={search ?? ''}
            placeholder="Name, phone, email or student ID"
            className="border-line-strong mt-1 block w-72 rounded border px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="bg-brand-500 text-ink rounded px-4 py-1.5 text-sm font-semibold"
        >
          Search
        </button>
        {search ? (
          <Link href="/admin/customers" className="text-muted py-1.5 text-sm underline">
            Clear
          </Link>
        ) : null}
      </form>

      <Panel title="Customers" description={rows ? `${rows.length} shown` : undefined}>
        {rows === null ? (
          <Unavailable>The customer list could not be loaded.</Unavailable>
        ) : rows.length === 0 ? (
          <Empty>
            {search ? 'Nobody matches that search.' : 'No students have completed onboarding yet.'}
          </Empty>
        ) : (
          <Table
            head={['Name', 'Phone', 'Student ID', 'Class', 'Also', 'Orders', 'Last order', 'State']}
            minWidth="56rem"
          >
            {rows.map((c) => (
              <Row key={c.user_id}>
                <Cell>
                  <Link
                    href={`/admin/customers/${c.user_id}`}
                    className="text-brand-700 underline underline-offset-4"
                  >
                    {c.full_name ?? '-'}
                  </Link>
                </Cell>
                <Cell mono>{c.phone}</Cell>
                <Cell mono>{c.student_id_number}</Cell>
                <Cell muted>{c.class_year}</Cell>
                <Cell>
                  <span className="flex flex-wrap gap-1">
                    {c.is_admin ? <Badge tone="warn">Admin</Badge> : null}
                    {c.partner_status !== 'NOT_APPLIED' ? (
                      <Badge tone={c.partner_status === 'APPROVED' ? 'good' : 'neutral'}>
                        Partner: {c.partner_status}
                      </Badge>
                    ) : null}
                  </span>
                </Cell>
                <Cell numeric>{c.order_count}</Cell>
                <Cell muted>{when(c.last_order_at)}</Cell>
                <Cell>
                  {c.is_suspended ? (
                    <Badge tone="bad">Suspended</Badge>
                  ) : (
                    <Badge tone="good">Active</Badge>
                  )}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>
    </>
  );
}
