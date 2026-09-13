'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The account sidebar.
 *
 * FOUR DESTINATIONS, NEVER A ROLE PICKER. Campus Dash has one identity with
 * capabilities on it, and the product should not make anybody learn that. So
 * this is a list of places — where your orders are, where your deliveries are,
 * where your details are — and not a switch that changes who you are.
 *
 * Vertical on a desktop, a horizontal scroller on a phone. That is the shape
 * the apps people already use take, and a stack of four full-width rows above
 * the actual content on a 360px screen buries the thing they came for.
 *
 * The list is built on the SERVER from my_capabilities(), so an entry can never
 * appear for something the destination would bounce this account out of. This
 * component only decides which one is current.
 */
export default function AccountNav({ items }) {
  const pathname = usePathname();

  const isCurrent = (item) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href);

  return (
    // min-w-0: this nav is a grid item, and a grid item's minimum width is
    // its content's. The tab strip is a nowrap row wider than a phone, so
    // without it the column grew past the viewport and the whole of /account
    // scrolled sideways. Now the strip scrolls inside itself instead.
    <nav aria-label="Account" className="min-w-0 lg:sticky lg:top-24">
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
        {items.map((item) => {
          const current = isCurrent(item);
          return (
            <li key={item.href} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`press-sm flex min-h-11 items-center gap-2.5 rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors lg:rounded-lg lg:px-3.5 ${
                  current ? 'bg-surface-2 text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink'
                }`}
              >
                {item.label}
                {item.note ? (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      item.tone === 'warn' ? 'bg-warn-bg text-warn' : 'bg-surface-3 text-muted'
                    }`}
                  >
                    {item.note}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
