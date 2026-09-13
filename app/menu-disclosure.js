'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * A button that opens a short list of destinations.
 *
 * Built on <details> so it opens without JavaScript and is keyboard-correct for
 * free, with the three things <details> does not do on its own: it closes when
 * a destination is chosen, when somebody taps outside it, and on Escape. The
 * admin menu used to stay open over the next page after you had navigated,
 * which made every visit look like the page had loaded behind a stuck menu.
 *
 * Every entry says where it goes. `description` is for the few menus where the
 * label alone does not answer "what will I find there".
 */
export default function MenuDisclosure({
  label,
  ariaLabel,
  items,
  align = 'right',
  icon = null,
  className = '',
}) {
  const ref = useRef(null);
  const pathname = usePathname();

  // A navigation happened: whatever was open belongs to the previous page.
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname]);

  useEffect(() => {
    function close(event) {
      const node = ref.current;
      if (!node?.open) return;
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type !== 'keydown' && node.contains(event.target)) return;
      node.open = false;
    }
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);

  return (
    <details ref={ref} className={`group relative ${className}`}>
      <summary
        aria-label={ariaLabel}
        className="border-line-strong text-ink hover:bg-surface-2 press-sm group-open:bg-surface-2 flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-full border px-3.5 text-sm font-semibold transition-colors select-none [&::-webkit-details-marker]:hidden"
      >
        {icon}
        {label}
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-muted size-3.5 transition-transform group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div
        className={`border-line bg-surface rounded-card shadow-float animate-fade absolute top-full z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] border p-1.5 ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        <ul>
          {items.map((item) => {
            const current = item.current ?? pathname === item.href;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    if (ref.current) ref.current.open = false;
                  }}
                  className={`press-sm flex min-h-11 flex-col justify-center rounded-lg px-3 py-2 transition-colors ${
                    current ? 'bg-surface-2' : 'hover:bg-surface-2'
                  }`}
                >
                  <span className="text-sm font-semibold">{item.label}</span>
                  {item.description ? (
                    <span className="text-muted text-xs leading-relaxed">{item.description}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}
