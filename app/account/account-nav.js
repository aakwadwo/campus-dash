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
 * Vertical on a desktop, a two-by-two grid on a phone. It used to be a strip
 * that scrolled sideways, which hid "Become a Vendor" off the edge of the
 * screen; a grid shows all four at once, each a full-size target, without
 * shrinking the text or burying the content under four stacked rows.
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
    // its content's. Kept so a long label can never push the page wider than
    // the screen.
    <nav aria-label="Account" className="min-w-0 lg:sticky lg:top-24">
      <ul className="grid grid-cols-2 gap-2 lg:flex lg:flex-col lg:gap-1">
        {items.map((item) => {
          const current = isCurrent(item);
          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`press-sm flex h-full min-h-12 flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-center text-sm font-semibold transition-colors lg:min-h-11 lg:flex-nowrap lg:justify-start lg:rounded-lg lg:border-0 lg:px-3.5 lg:py-0 lg:text-left lg:whitespace-nowrap ${
                  current
                    ? 'bg-surface-2 text-ink border-transparent'
                    : 'text-muted hover:bg-surface-2 hover:text-ink border-line'
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
