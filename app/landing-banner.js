import Link from 'next/link';
import { CampusDashMark } from './brand';
import { ChevronRightIcon } from './ui';

/**
 * THE BANNER ON THE LANDING PAGE, AND EVERYTHING ABOUT IT IS IN THIS OBJECT.
 *
 * TEMPORARY. It exists so the slot is designed and working; the campaign that
 * eventually fills it has not been decided. To replace it, change the fields
 * below. Nothing else in the page needs to move.
 *
 *   tag     a short label in the pill, or null for none
 *   title   one line, two at most on a phone
 *   body    one short sentence, or null
 *   cta     the button: { label, href }
 *   image   a photo in /public (e.g. '/banner/stores.jpg'), or null. With a
 *           photo the card becomes the photo with a dark wash over its left
 *           side, the way inspo/banner.jpeg is composed. Without one it is the
 *           navy ground with the runner, which is what ships today because the
 *           project has no campaign photography yet.
 *   imageAlt  what the photo shows, for a screen reader
 *
 * Set BANNER to null to remove the banner entirely.
 */
export const BANNER = {
  tag: 'For stores',
  title: 'Sell to all of campus',
  body: 'Paid orders, straight to your counter.',
  cta: { label: 'Register your store', href: '/vendor/signup' },
  image: null,
  imageAlt: '',
};

export default function LandingBanner({ banner = BANNER }) {
  if (!banner) return null;

  return (
    <Link
      href={banner.cta.href}
      className="press rounded-panel bg-navy relative isolate flex min-h-44 overflow-hidden sm:min-h-56"
    >
      {banner.image ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={banner.image}
            alt={banner.imageAlt ?? ''}
            className="absolute inset-0 -z-10 size-full object-cover"
          />
          {/* A wash over the words, so white type stays readable whatever the
              photo is. Left to right, as in the inspiration. */}
          <span
            aria-hidden
            className="from-navy via-navy/80 absolute inset-0 -z-10 bg-gradient-to-r to-transparent"
          />
        </>
      ) : (
        // No photo yet: the runner, large and quiet, off the right edge.
        <CampusDashMark
          height={180}
          className="pointer-events-none absolute -right-6 -bottom-8 -z-10 opacity-90 sm:right-10 sm:-bottom-2"
        />
      )}

      <div className="flex max-w-[16rem] flex-col justify-center gap-2 px-5 py-6 sm:max-w-md sm:px-8">
        {banner.tag ? (
          <span className="bg-brand-700 w-fit rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide text-white uppercase">
            {banner.tag}
          </span>
        ) : null}
        <p className="text-display text-2xl leading-tight font-semibold text-balance text-white sm:text-4xl">
          {banner.title}
        </p>
        {banner.body ? <p className="text-sm text-white/80 sm:text-base">{banner.body}</p> : null}
        <span className="bg-surface text-ink mt-2 inline-flex h-10 w-fit items-center gap-1 rounded-full pr-3 pl-4 text-sm font-semibold">
          {banner.cta.label}
          <ChevronRightIcon className="size-4" />
        </span>
      </div>
    </Link>
  );
}
