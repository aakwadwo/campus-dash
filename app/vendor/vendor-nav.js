'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClockIcon, ReceiptIcon, StoreIcon, BagIcon } from '@/app/ui';

/**
 * The store's four destinations.
 *
 * Orders is the job; History is the record of it; Menu is what can be sold
 * today; Store is everything else about the business, sign-out included. Every
 * label is the name of what is behind it.
 *
 * A bottom bar on a phone — the shape of every app a store owner already uses,
 * and the only place four targets fit a thumb on a 360px screen — and a row of
 * tabs under the header from `sm` up.
 */
function itemsFor(vendorId) {
  return [
    {
      href: `/vendor/${vendorId}`,
      label: 'Orders',
      icon: ReceiptIcon,
      match: (p) => p === `/vendor/${vendorId}` || p.startsWith(`/vendor/${vendorId}/orders`),
    },
    {
      href: '/vendor/history',
      label: 'History',
      icon: ClockIcon,
      match: (p) => p.startsWith('/vendor/history'),
    },
    {
      href: '/vendor/menu',
      label: 'Menu',
      icon: BagIcon,
      match: (p) => p.startsWith('/vendor/menu'),
    },
    {
      href: '/vendor/profile',
      label: 'Store',
      icon: StoreIcon,
      match: (p) => p.startsWith('/vendor/profile'),
    },
  ];
}

export function VendorTabs({ vendorId }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Store" className="hidden sm:block">
      <ul className="-mb-px flex gap-1">
        {itemsFor(vendorId).map((item) => {
          const current = item.match(pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`press-sm flex min-h-11 items-center border-b-2 px-3 text-sm font-semibold transition-colors ${
                  current
                    ? 'border-brand-700 text-ink'
                    : 'text-muted hover:text-ink border-transparent'
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function VendorBottomBar({ vendorId }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Store"
      className="border-line bg-canvas fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="mx-auto flex max-w-md">
        {itemsFor(vendorId).map((item) => {
          const Icon = item.icon;
          const current = item.match(pathname);
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`press-sm flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors ${
                  current ? 'text-brand-700' : 'text-muted'
                }`}
              >
                <Icon className="size-[22px]" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
