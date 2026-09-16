'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import MenuDisclosure from '@/app/menu-disclosure';

/**
 * The console's navigation: nine destinations, and nothing else.
 *
 * THE TEST FOR THE BAR is "would somebody open this during a normal shift".
 *
 * WHAT WAS DELETED, AND WHY IT WAS NOT ENOUGH TO UNLINK IT. Disputes, Community,
 * Money, Finance, System, Notifications and Audit were taken off this bar in an
 * earlier pass because nobody steers by them — and then left in the codebase,
 * unlinked but still routable, still rendering, and in the case of Money and
 * Finance still two more views of figures the dashboard already states.
 *
 * An unlinked page is worse than a deleted one. It rots: nobody opens it, so
 * nobody notices when a read model behind it goes stale, and it is exactly
 * where a schema change survives unnoticed. They are gone now.
 *
 * THE BACKEND IS UNTOUCHED, and that distinction is the important one.
 * `admin_actions` is still written to by every administrative override,
 * `admin_list_actions()` still exists, and `tests/audit.test.js` still holds
 * the whole audit trail to account. REMOVING A PAGE IS NOT REMOVING A RECORD —
 * the security infrastructure is the thing that matters, and a screen that
 * nobody reads was never it.
 *
 * WHAT CAME BACK ON. Money (the settlement runs) is a real weekly task now that
 * Partners are settled by hand, and Categories are the vocabulary the whole
 * marketplace is filed under.
 */
const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/vendors', label: 'Vendors' },
  { href: '/admin/partners', label: 'Partners' },
  { href: '/admin/categories', label: 'Categories' },
  { href: '/admin/locations', label: 'Locations' },
  { href: '/admin/settlements', label: 'Money' },
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
