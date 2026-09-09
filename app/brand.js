import Image from 'next/image';

/**
 * ============================================================================
 * The Campus Dash mark
 * ============================================================================
 *
 * THE LOGO IS `info/logo2.PNG` — the running Partner with the navy pack and the
 * orange speed trail. It is the identity, and nothing here redraws it. The
 * assets under `public/brand/` are generated from that one file:
 *
 *   runner-48/96/192.png   the mark at its natural ratio, transparent margin
 *                          trimmed, for the header and the auth screens
 *   icon-32/48/180/512.png a SQUARE variation on the brand off-white, for the
 *                          browser tab and the home-screen icon
 *   favicon.ico            the same square at 16/32/48
 *
 * The square is the one permitted variation: a wide transparent runner dropped
 * into a 16px tab is a smudge on whatever colour the browser happens to paint
 * behind it, and a defined ground is not.
 *
 * The wordmark is set in type rather than shipped as pixels — CAMPUS in navy,
 * DASH in orange, exactly as the supplied lockup — so it stays sharp at every
 * size, costs nothing to load, and is selectable and readable by a screen
 * reader as the words it is.
 */

const ORANGE_DEEP = '#E64A19';
const NAVY = '#0D1B2A';

/** Natural ratio of the trimmed source: 1292 × 1113. */
const RUNNER_RATIO = 1292 / 1113;

/**
 * The running Partner, from logo2.
 *
 * Sized by HEIGHT, because that is what has to line up with a row of text. The
 * width follows from the source's own ratio, so nothing is ever squashed.
 */
export function CampusDashMark({ height = 28, className = '', priority = false, alt = '' }) {
  const width = Math.round(height * RUNNER_RATIO);
  return (
    <Image
      src="/brand/runner-192.png"
      alt={alt}
      width={width}
      height={height}
      priority={priority}
      className={className}
      // BOTH dimensions, explicitly. Tailwind's preflight sets `height: auto`
      // on every img, which overrides one of the two Next was given and makes
      // it warn that the ratio is no longer guaranteed. The width is derived
      // from the source's own ratio just above, so pinning both is exactly what
      // was intended.
      style={{ width: `${width}px`, height: `${height}px` }}
      // Decorative inside the lockup, where the wordmark already says the name.
      aria-hidden={alt === '' ? true : undefined}
    />
  );
}

/**
 * CAMPUS in navy, DASH in orange — the supplied lockup's whole idea.
 *
 * The colours are literal rather than tokens on purpose: this is the brand
 * mark, and it must not pick up whatever text colour it happens to sit in.
 */
export function CampusDashWordmark({ className = '' }) {
  return (
    <span
      className={`text-[17px] leading-none font-bold tracking-[-0.02em] whitespace-nowrap ${className}`}
    >
      <span style={{ color: NAVY }}>Campus</span>
      <span style={{ color: ORANGE_DEEP }}> Dash</span>
    </span>
  );
}

/** The lockup: the runner, then the words. What the header and footer use. */
export function CampusDashLogo({ className = '', height = 28, priority = false }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <CampusDashMark height={height} priority={priority} />
      <CampusDashWordmark />
    </span>
  );
}

export const BRAND_COLORS = { orange: '#FF5722', orangeDeep: ORANGE_DEEP, navy: NAVY };
