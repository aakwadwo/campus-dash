'use client';

import { useEffect, useRef } from 'react';

/**
 * Watches a small status endpoint while a screen is waiting on somebody else.
 *
 * WHY NOT router.refresh() ON A TIMER. That re-renders the whole page on the
 * server every tick — sign-in, capabilities, the order, its items — to learn
 * that nothing happened, which is what most ticks learn. This asks a four-field
 * question instead and only lets the page re-render when the answer moves.
 *
 * WHAT A PHONE NEEDS FROM IT:
 *
 *   * One request at a time. The next check is scheduled when the last one
 *     settles, so a slow cellular response can never stack a queue behind it.
 *   * Nothing while the screen is hidden. A phone in a pocket or a backgrounded
 *     tab costs no data and no battery.
 *   * An immediate check the moment the screen is visible again, because that is
 *     exactly when somebody looks at it — unlocking the phone on the counter —
 *     and a timer the browser throttled in the background would otherwise leave
 *     them looking at stale state for a full interval.
 *
 * `signatureOf` turns a status into a comparable string. `initial` is the
 * signature of what the server rendered; `onChange(status)` fires once, the
 * first time the endpoint disagrees with it, and watching stops there. The
 * caller refreshes, and a re-render with a new `initial` starts a fresh watch.
 */
export function useStatusWatch({ url, enabled, initial, signatureOf, onChange, intervalMs }) {
  // Held in refs so a parent re-rendering with new function identities does not
  // restart the loop; only the url, the switch and the baseline do.
  const onChangeRef = useRef(onChange);
  const signatureRef = useRef(signatureOf);
  useEffect(() => {
    onChangeRef.current = onChange;
    signatureRef.current = signatureOf;
  });

  useEffect(() => {
    if (!enabled || !url) return undefined;

    let stopped = false;
    let timer = null;
    let inFlight = null;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(check, intervalMs);
    };

    async function check() {
      if (stopped || inFlight || document.hidden) return;
      inFlight = new AbortController();
      try {
        const response = await fetch(url, { cache: 'no-store', signal: inFlight.signal });
        if (response.ok) {
          const status = await response.json();
          if (!stopped && signatureRef.current(status) !== initial) {
            stopped = true;
            onChangeRef.current(status);
            return;
          }
        }
      } catch {
        // Offline, a dropped cellular connection, or an abort: try next tick.
      } finally {
        inFlight = null;
      }
      schedule();
    }

    function onVisibility() {
      if (document.hidden) {
        clearTimeout(timer);
      } else {
        check();
      }
    }

    document.addEventListener('visibilitychange', onVisibility);
    schedule();

    return () => {
      stopped = true;
      clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [url, enabled, initial, intervalMs]);
}
