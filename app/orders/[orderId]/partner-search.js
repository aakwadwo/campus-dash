'use client';

import { useEffect, useState } from 'react';

/**
 * "Finding a Campus Dash Partner", with the real deadline under it.
 *
 * THE CLOCK IS THE SERVER'S, and every part of this component exists to keep it
 * that way while still ticking once a second without asking the server again.
 *
 * How. The server hands back two things on the same render:
 * `seconds_until_partner_search_expires` and `server_now`. Those two give the
 * deadline as an instant on the SERVER's clock; comparing `server_now` with the
 * browser's `Date.now()` gives the device's SKEW; and the deadline expressed in
 * local milliseconds is the sum. All of that is arithmetic on props, so it is
 * done during render rather than in an effect — the only state here is "what
 * time is it now", and the only thing that writes it is a timer callback.
 *
 * What that buys, and each of these was a real way a naive countdown goes wrong:
 *
 *   * A PHONE WITH A WRONG CLOCK shows the right number. Phones are routinely
 *     minutes out, and a countdown built from the device's own idea of "now"
 *     against a server deadline can start at the wrong figure or at zero.
 *   * A REFRESH does not restart it. The remaining time comes from the server
 *     on every render, so reloading re-anchors rather than resetting.
 *   * A BACKGROUNDED TAB catches up instead of drifting. Browsers throttle
 *     timers in background tabs, so a counter that decremented a variable once
 *     a second would be minutes behind after a pocket. The remaining time is
 *     RECOMPUTED from the deadline every tick and on `visibilitychange`, so a
 *     missed tick costs nothing and coming back is always correct.
 *   * IT COSTS NO REQUESTS. The page's own status poll is what notices a
 *     Partner has been found; this only draws the number in between. A
 *     countdown is not a reason to talk to a server once a second.
 *
 * At zero it stops and says so, and does NOT declare the search failed: whether
 * it actually expired is the server's to say, and the poll brings back
 * NO_PARTNER once the sweep has run. A screen announcing failure on its own
 * clock would be announcing it early.
 */
export default function PartnerSearch({ secondsRemaining, serverNow, searching = true }) {
  // WHAT TIME IT IS, locally. Written by a timer and by the visibility handler,
  // never during render.
  const [now, setNow] = useState(() => Date.now());

  // HOW FAR THIS DEVICE'S CLOCK IS FROM THE SERVER'S, measured once. A lazy
  // initialiser is the right home for it: reading a clock is impure and must
  // not happen during a render, and the skew is a property of the device rather
  // than of this order — it does not need re-measuring when the order polls.
  const [skew] = useState(() => (serverNow ? Date.now() - new Date(serverNow).getTime() : 0));

  const known = secondsRemaining != null;

  // Derived from props and that one measurement, so every poll re-anchors the
  // deadline while the skew stays put. Pure: no clock is read here.
  const serverNowMs = serverNow ? new Date(serverNow).getTime() : null;
  const deadline =
    known && serverNowMs != null ? serverNowMs + skew + secondsRemaining * 1000 : null;
  const remaining = deadline == null ? null : Math.max(0, Math.round((deadline - now) / 1000));

  useEffect(() => {
    if (!searching || deadline == null) return undefined;

    const tick = () => setNow(Date.now());
    const timer = setInterval(tick, 1000);
    // Coming back from a backgrounded tab is exactly when the number is most
    // stale and most looked at.
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [searching, deadline]);

  if (!searching) return null;

  return (
    <div className="bg-brand-50 rounded-panel px-5 py-4">
      <p className="text-ink flex items-center gap-2.5 font-semibold">
        <SearchPulse />
        Finding a Campus Dash Partner
      </p>
      <p className="text-muted mt-1.5 text-sm leading-relaxed">
        Your order is being taken care of. We are looking for someone to bring it to you.
      </p>
      {remaining == null ? null : remaining > 0 ? (
        // aria-live is deliberately off: a number changing every second would
        // be read out every second by a screen reader, which is unusable.
        <p className="text-muted mt-2.5 text-sm tabular-nums" aria-live="off">
          Still looking · <span className="text-ink font-semibold">{format(remaining)}</span> left
        </p>
      ) : (
        <p className="text-muted mt-2.5 text-sm" aria-live="polite">
          Taking longer than usual. Checking where things stand…
        </p>
      )}
    </div>
  );
}

function format(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * The one looping animation in the product, and it is load-bearing: it is the
 * difference between "we are looking for somebody" and "this page has frozen",
 * on the one screen where a customer is waiting on other people with nothing
 * else to read. Stilled entirely under prefers-reduced-motion by the global
 * rule in globals.css.
 */
function SearchPulse() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-brand-600 animate-search-dot size-1.5 rounded-full"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}
