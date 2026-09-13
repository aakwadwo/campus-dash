'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MenuDisclosure from '@/app/menu-disclosure';

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

/** Dashboard is exact; every other section owns its sub-pages. */
function isCurrent(pathname, href) {
  return href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
}

export default function AdminNav() {
  const pathname = usePathname();
  const current = NAV.find((item) => isCurrent(pathname, item.href));

  return (
    <>
      {/* Desktop: seven words, the current one marked, nothing to open. */}
      <nav className="hidden items-center gap-1 lg:flex" aria-label="Admin">
        {NAV.map((item) => {
          const active = isCurrent(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`press-sm inline-flex min-h-10 items-center rounded-full px-3 text-sm font-medium transition-colors ${
                active ? 'bg-surface-2 text-ink font-semibold' : 'text-muted hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Mobile and tablet: one control that names the section you are in, so
          the header answers "where am I" without opening anything. It closes
          itself when a destination is chosen. */}
      <MenuDisclosure
        className="lg:hidden"
        label={current?.label ?? 'Menu'}
        ariaLabel="Admin sections"
        items={NAV.map((item) => ({ ...item, current: isCurrent(pathname, item.href) }))}
      />
    </>
  );
}
