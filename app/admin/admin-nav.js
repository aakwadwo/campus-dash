import Link from 'next/link';

/**
 * The console's navigation.
 *
 * SIXTEEN FLAT LINKS WAS THE PROBLEM. They were one `flex-wrap` row, which on a
 * laptop was a wall of similar-looking words and on a phone wrapped to four or
 * five lines — a header taller than the content under it, and nothing in it
 * ranked. Everything was equally loud, so nothing was findable.
 *
 * Six primary destinations now, chosen by how often an operator needs them on a
 * bad morning, and the rest behind "More". NOTHING WAS REMOVED — every screen
 * that was reachable is still reachable, and the two that went are the two that
 * were never separate screens: "Scan orders" was `/admin/orders?type=SCAN`, and
 * that page already carries All / Food / Scan filter chips.
 *
 * `<details>` rather than a popover component: it opens without JavaScript, it
 * is keyboard- and screen-reader-correct for free, and on a phone it pushes the
 * page down instead of floating over the thing you were reading.
 */
const PRIMARY = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/disputes', label: 'Disputes' },
  { href: '/admin/vendors', label: 'Vendors' },
  { href: '/admin/partners', label: 'Partners' },
  { href: '/admin/finance', label: 'Money' },
];

/** Grouped by the question being asked, so "More" is a menu and not a pile. */
const MORE = [
  {
    heading: 'People',
    items: [
      { href: '/admin/customers', label: 'Customers' },
      { href: '/admin/community', label: 'Community' },
    ],
  },
  {
    heading: 'Money',
    items: [
      { href: '/admin/payments', label: 'Payments' },
      { href: '/admin/settlements', label: 'Payouts' },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { href: '/admin/locations', label: 'Locations' },
      { href: '/admin/notifications', label: 'Notifications' },
      { href: '/admin/pilot', label: 'Configuration' },
    ],
  },
  {
    heading: 'Records',
    items: [
      { href: '/admin/audit', label: 'Audit' },
      { href: '/admin/system', label: 'System' },
    ],
  },
];

const LINK = 'text-muted hover:text-brand-700 text-sm font-medium transition-colors';

function Chevron() {
  return (
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
  );
}

/** The grouped overflow, shared by the desktop "More" and the mobile "Menu". */
function MoreGroups({ onDark = false }) {
  return (
    <div className={onDark ? 'grid grid-cols-2 gap-x-4 gap-y-4' : 'space-y-3'}>
      {MORE.map((group) => (
        <div key={group.heading}>
          <p className="text-faint text-[11px] font-semibold tracking-wide uppercase">
            {group.heading}
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {group.items.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className={`${LINK} block`}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function AdminNav() {
  return (
    <>
      {/* Desktop: six words and one disclosure. */}
      <nav className="hidden items-center gap-5 md:flex" aria-label="Admin">
        {PRIMARY.map((item) => (
          <Link key={item.href} href={item.href} className={LINK}>
            {item.label}
          </Link>
        ))}

        <details className="group relative">
          <summary
            className={`${LINK} flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden`}
          >
            More
            <Chevron />
          </summary>
          <div className="border-line bg-surface rounded-card absolute right-0 z-50 mt-2 w-64 border p-4 shadow-lg">
            <MoreGroups onDark />
          </div>
        </details>
      </nav>

      {/* Mobile: one control. The header stays a single row at 360px, which is
          what it was failing to do. */}
      <details className="group md:hidden">
        <summary
          className="border-line text-muted flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-full border px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden"
          aria-label="Admin menu"
        >
          Menu
          <Chevron />
        </summary>
        <div className="border-line bg-surface rounded-card absolute inset-x-4 z-50 mt-2 border p-4 shadow-lg">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
            {PRIMARY.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="text-ink block text-sm font-semibold">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <hr className="border-line my-4" />
          <MoreGroups onDark />
        </div>
      </details>
    </>
  );
}
