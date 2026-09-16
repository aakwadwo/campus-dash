import Link from 'next/link';
import { customers as listCustomers, customerSummary } from '@/lib/admin';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Stat,
  StatGrid,
  Cedis,
  when,
} from '../ui';

export const dynamic = 'force-dynamic';

/**
 * Customers, as a population rather than a list.
 *
 * WHAT THIS SCREEN IS FOR. An operator running a pilot has questions — how many
 * staff are using it, whether anybody from the 2027 cohort has come back, how
 * much of the volume is Partner orders — and the previous version answered none
 * of them: a search box and a flat table of everyone, truncated at two hundred.
 *
 * EVERY FILTER NARROWS THE QUERY, not the array. Fetching everyone and
 * filtering in the page is slow, carries people the operator did not ask about,
 * and is silently wrong the moment the row limit bites. The counts come from
 * their own aggregate for the same reason: a count is not a shorter list.
 *
 * FILTERS ARE IN THE URL, so a useful view is a link somebody can send. They
 * are also why this page has no client JavaScript at all — every control is a
 * link or a GET form.
 *
 * A CUSTOMER IS A CAPABILITY, not an account type. Everyone holding a
 * customer_profiles row is here, including accounts that also own a store or
 * carry deliveries, because they genuinely are customers as well.
 */
export default async function AdminCustomersPage({ searchParams }) {
  const params = (await searchParams) ?? {};
  const text = (key) =>
    typeof params[key] === 'string' && params[key].trim() ? params[key].trim() : null;

  const filters = {
    search: text('q'),
    affiliation: ['STUDENT', 'STAFF'].includes(text('who')) ? text('who') : null,
    graduationYear: /^\d{4}$/.test(text('year') ?? '') ? Number(text('year')) : null,
    gender: ['MALE', 'FEMALE'].includes(text('gender')) ? text('gender') : null,
    minOrders: /^\d+$/.test(text('orders') ?? '') ? Number(text('orders')) : null,
    active: text('active') === 'yes' ? true : text('active') === 'no' ? false : null,
    fulfilment: ['PICKUP', 'DELIVERY'].includes(text('how')) ? text('how') : null,
  };

  const [rows, summary] = await Promise.all([
    listCustomers(filters).catch(() => null),
    // The summary deliberately ignores the search box and the order filters: it
    // describes the COHORT being looked at, and a text search is a way of
    // finding one person rather than of defining a group.
    customerSummary({
      affiliation: filters.affiliation,
      graduationYear: filters.graduationYear,
      gender: filters.gender,
    }).catch(() => null),
  ]);

  const on = (key, value) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && v) next.set(k, v);
    }
    // A filter that is already on is a filter this link turns off, so every
    // chip is its own undo.
    if (next.get(key) === String(value)) next.delete(key);
    else next.set(key, String(value));
    const query = next.toString();
    return query ? `/admin/customers?${query}` : '/admin/customers';
  };

  const filtered = Object.values(filters).some((v) => v !== null);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Customers</h1>
      <p className="text-muted mb-6 text-sm">
        Everyone who has completed sign-up. Identity documents stay private, so open a record to
        review one.
      </p>

      {summary ? (
        <StatGrid>
          <Stat label="Customers" value={summary.customers} />
          <Stat
            label="Students / staff"
            value={`${summary.students} / ${summary.staff}`}
            hint="Staff order and can be Partners too"
          />
          <Stat
            label="Ordered in 30 days"
            value={summary.active_30d}
            hint={`${summary.never_ordered} have never ordered`}
          />
          <Stat
            label="Collected / brought"
            value={`${summary.pickup_orders} / ${summary.partner_orders}`}
            hint="Paid orders by fulfilment"
          />
        </StatGrid>
      ) : null}

      {/* --- Filters ------------------------------------------------------ */}
      <Panel title="Narrow it down">
        <form
          method="get"
          action="/admin/customers"
          className="mb-4 flex flex-wrap items-end gap-3"
        >
          {/* The chips below are links, so the search box has to carry them or
              searching would silently drop the filters somebody had set. */}
          {Object.entries(params)
            .filter(([k, v]) => k !== 'q' && typeof v === 'string' && v)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
          <label className="block">
            <span className="text-muted text-xs font-semibold uppercase">Search</span>
            <input
              name="q"
              defaultValue={filters.search ?? ''}
              placeholder="Name, email, phone or student ID"
              className="border-line-strong mt-1 block w-72 rounded border px-3 py-1.5 text-sm"
            />
          </label>
          <button
            type="submit"
            className="bg-brand-700 rounded px-4 py-1.5 text-sm font-semibold text-white"
          >
            Search
          </button>
          {filtered ? (
            <Link href="/admin/customers" className="text-muted py-1.5 text-sm underline">
              Clear everything
            </Link>
          ) : null}
        </form>

        <div className="space-y-2.5">
          <FilterRow label="Who">
            <Chip href={on('who', 'STUDENT')} active={filters.affiliation === 'STUDENT'}>
              Students
            </Chip>
            <Chip href={on('who', 'STAFF')} active={filters.affiliation === 'STAFF'}>
              Staff
            </Chip>
          </FilterRow>

          <FilterRow label="Gender">
            <Chip href={on('gender', 'MALE')} active={filters.gender === 'MALE'}>
              Male
            </Chip>
            <Chip href={on('gender', 'FEMALE')} active={filters.gender === 'FEMALE'}>
              Female
            </Chip>
          </FilterRow>

          {/* THE YEARS THAT EXIST, from the data rather than a hard-coded range:
              a cohort nobody is in is a filter that always returns nothing. */}
          {summary?.by_graduation_year?.length ? (
            <FilterRow label="Graduating">
              {summary.by_graduation_year.map((cohort) => (
                <Chip
                  key={cohort.year}
                  href={on('year', cohort.year)}
                  active={filters.graduationYear === cohort.year}
                >
                  {cohort.year} · {cohort.customers}
                </Chip>
              ))}
            </FilterRow>
          ) : null}

          <FilterRow label="Activity">
            <Chip href={on('active', 'yes')} active={filters.active === true}>
              Ordered in 30 days
            </Chip>
            <Chip href={on('active', 'no')} active={filters.active === false}>
              Gone quiet
            </Chip>
            <Chip href={on('orders', '1')} active={filters.minOrders === 1}>
              Has ever ordered
            </Chip>
          </FilterRow>

          <FilterRow label="How they get it">
            <Chip href={on('how', 'PICKUP')} active={filters.fulfilment === 'PICKUP'}>
              Collects
            </Chip>
            <Chip href={on('how', 'DELIVERY')} active={filters.fulfilment === 'DELIVERY'}>
              Uses a Partner
            </Chip>
          </FilterRow>
        </div>
      </Panel>

      <Panel title="Customers" description={rows ? `${rows.length} shown` : undefined}>
        {rows === null ? (
          <Unavailable>The customer list could not be loaded.</Unavailable>
        ) : rows.length === 0 ? (
          <Empty>{filtered ? 'Nobody matches those filters.' : 'Nobody has signed up yet.'}</Empty>
        ) : (
          <Table
            head={[
              'Name',
              'Who',
              'Contact',
              'Orders',
              'Spent',
              'Collect / Partner',
              'Last order',
              'State',
            ]}
            minWidth="62rem"
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
                  {c.partner_status !== 'NOT_APPLIED' || c.is_admin ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {c.is_admin ? <Badge tone="warn">Admin</Badge> : null}
                      {c.partner_status !== 'NOT_APPLIED' ? (
                        <Badge tone={c.partner_status === 'APPROVED' ? 'good' : 'neutral'}>
                          Partner: {c.partner_status}
                        </Badge>
                      ) : null}
                    </span>
                  ) : null}
                </Cell>
                <Cell muted>
                  {c.affiliation === 'STAFF'
                    ? 'Staff'
                    : c.graduation_year
                      ? `Student · ${c.graduation_year}`
                      : 'Student'}
                  {c.gender ? (
                    <span className="text-faint block text-xs">
                      {c.gender === 'MALE' ? 'Male' : 'Female'}
                    </span>
                  ) : null}
                </Cell>
                <Cell muted>
                  {c.email ?? '-'}
                  <span className="text-faint block font-mono text-xs">{c.phone}</span>
                </Cell>
                <Cell numeric>{c.order_count}</Cell>
                <Cell numeric>
                  <Cedis pesewas={c.spent_pesewas} />
                </Cell>
                <Cell numeric>
                  {c.pickup_count} / {c.partner_count}
                </Cell>
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

function FilterRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted w-32 shrink-0 text-xs font-semibold uppercase">{label}</span>
      {children}
    </div>
  );
}

/** A filter chip. A link, so the view is shareable and the page needs no JS. */
function Chip({ href, active, children }) {
  return (
    <Link
      href={href}
      aria-pressed={active}
      className={`press-sm inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold transition-colors ${
        active
          ? 'bg-brand-700 text-white'
          : 'bg-surface-2 text-muted hover:text-ink hover:bg-surface-3'
      }`}
    >
      {children}
    </Link>
  );
}
