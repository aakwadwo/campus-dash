import Link from 'next/link';

/**
 * The console's navigation: seven destinations, and nothing else.
 *
 * WHAT CAME OFF, AND WHERE IT WENT. None of it was deleted — every one of these
 * is still a working page, still reachable by URL, and every backend function
 * behind them is untouched. They came off the bar because an administrator
 * running a campus food service does not navigate by them:
 *
 *   Disputes      → an order state. The Orders board already sorts problems
 *                   first and the dashboard links to what needs a decision.
 *   Community     → a rewards report, not an operational destination.
 *   Payouts       → the payout RUN is a finance task, reached from Configuration
 *                   and surfaced on the dashboard as one number.
 *   Money/Finance → the same allocation figures the dashboard already states.
 *   System, Audit,
 *   Notifications → internals. A scheduler and a webhook log are things you go
 *                   looking for when something is wrong, not things you steer by.
 *
 * The test for the primary bar is "would somebody click this during a normal
 * shift". Seven things pass it.
 */
const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/vendors', label: 'Vendors' },
  { href: '/admin/partners', label: 'Partners' },
  { href: '/admin/locations', label: 'Locations' },
  { href: '/admin/pilot', label: 'Configuration' },
];

const LINK = 'text-muted hover:text-ink text-sm font-medium transition-colors';

export default function AdminNav() {
  return (
    <>
      {/* Desktop: seven words, no disclosure, nothing to open. */}
      <nav className="hidden items-center gap-5 lg:flex" aria-label="Admin">
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className={LINK}>
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Mobile and tablet: one control, so the header stays a single row at
          360px. `<details>` opens without JavaScript and is keyboard- and
          screen-reader-correct for free. */}
      <details className="group lg:hidden">
        <summary
          className="border-line text-muted flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-full border px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden"
          aria-label="Admin menu"
        >
          Menu
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3.5 transition-transform group-open:rotate-180"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div className="border-line bg-surface rounded-card absolute inset-x-4 z-50 mt-2 border p-2 shadow-lg">
          <ul>
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="text-ink hover:bg-surface-2 block rounded-lg px-3 py-2.5 text-sm font-medium"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </>
  );
}
