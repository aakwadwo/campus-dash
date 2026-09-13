'use client';

import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * A thin bar across the top of the screen while the next page is on its way.
 *
 * WHY IT EXISTS. Almost every screen here is rendered on the server per
 * request, and the guarded ones deliberately have no loading.js (a streaming
 * boundary would turn their auth redirects into client-side ones). So between
 * a tap and the next page there was nothing: the old page just sat there, and
 * on a campus connection a second of nothing reads as a tap that missed —
 * which is when people tap again.
 *
 * HOW. A click on a same-origin link that will actually navigate starts the
 * bar; the URL changing stops it. No router patching, no dependency. Modified
 * clicks, new tabs, downloads, hash jumps and links to the page already open
 * are ignored, and a safety timer clears it if a navigation is abandoned.
 */
export default function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const url = `${pathname}?${searchParams}`;
  // The URL the bar was started FROM. Once the address moves on, the bar is no
  // longer for this page and simply stops rendering — no effect has to notice.
  const [startedOn, setStartedOn] = useState(null);
  const active = startedOn !== null && startedOn === url;

  useEffect(() => {
    function onClick(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const next = new URL(anchor.href, window.location.href);
      if (next.origin !== window.location.origin) return;
      const current = new URL(window.location.href);
      if (next.pathname === current.pathname && next.search === current.search) return;

      setStartedOn(url);
    }

    // CAPTURE PHASE. next/link calls preventDefault() in its own handler, which
    // React runs at the root before a bubbling listener on document would see
    // the event — so listening late would mistake every Link for a cancelled
    // click.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [url]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => setStartedOn(null), 12000);
    return () => clearTimeout(timer);
  }, [active]);

  if (!active) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden"
    >
      <div className="nav-progress bg-brand-500 h-full w-full" />
    </div>
  );
}
