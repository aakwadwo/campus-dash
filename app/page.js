import Link from 'next/link';
import SiteHeader from './site-header';
import SiteFooter from './site-footer';
import { listVendors } from '@/lib/customer';
import { ButtonLink, Container, ImagePlaceholder, ChevronRightIcon } from './ui';

export const metadata = {
  title: 'Campus Dash: order food around Academic City',
  description:
    'Order from vendors around Academic City. Collect it yourself, or have a student Partner bring it to you.',
};

export const dynamic = 'force-dynamic';

/**
 * The landing page.
 *
 * ONE ACTION. A student opening this on a phone between lectures wants food,
 * not an explanation of the product. So the mobile composition is: what this
 * is, one line of how, one button. Everything else is below it and quieter.
 *
 * The copy was cut hard in this pass. The previous version led with three
 * sentences before the first button; a food app that needs a paragraph to
 * explain itself has already lost the person who was hungry.
 *
 * WHAT IS DELIBERATELY ABSENT. No eyebrow label, no gradient, no illustration,
 * no statistics, no testimonials. Campus Dash has one campus and a handful of
 * stalls; the vendor strip below is real data from the same anon-readable query
 * the marketplace uses, and when the pilot is empty it simply does not render.
 */

const HOW_IT_WORKS = [
  ['Pick a vendor', 'Stalls around campus, with what they have right now.'],
  ['Collect or get it brought', 'Pick it up free, or send it to your block.'],
  ['Pay once', 'One payment covers the food, the delivery and our fee.'],
];

export default async function Home() {
  // Never let a slow or failing marketplace query take the landing page down.
  const vendors = await listVendors().catch(() => []);
  const open = (vendors ?? []).filter((v) => v.is_accepting_orders).slice(0, 4);

  return (
    <div className="min-h-dvh">
      <SiteHeader active="browse" />

      <main className="pb-16">
        {/* ----------------------------------------------------------------
            The whole pitch, above the fold on a 360px screen. */}
        <Container size="wide" className="pt-10 pb-8 sm:pt-20 sm:pb-14">
          {/* CENTRED ON A PHONE, LEFT-ALIGNED ON A LAPTOP. A 40px headline set
              flush left runs almost to both edges of a 360px screen, which
              reads as cramped however much padding sits outside it. Centring it
              inside a deliberately narrow measure gives the type room to
              breathe and lands the wrap in a sensible place; from `sm` up the
              original left-aligned composition returns unchanged. */}
          <h1 className="text-display mx-auto max-w-[19rem] text-center text-[2.5rem] font-semibold text-balance sm:mx-0 sm:max-w-3xl sm:text-left sm:text-6xl">
            Campus food brought to you.
          </h1>
          <p className="text-muted mx-auto mt-4 max-w-xs text-center text-base leading-relaxed text-balance sm:mx-0 sm:max-w-md sm:text-left sm:text-lg">
            Order from vendors around Academic City.
          </p>

          {/* `items-start` matters: in a flex column, children stretch to the
              full width by default, which is how a single CTA turns into a
              full-bleed button bar on a phone. The button is sized to its
              label instead. */}
          <div className="mt-7 flex flex-col items-center gap-4 sm:items-start">
            <ButtonLink href="/order" size="lg" className="px-7">
              Browse food
            </ButtonLink>

            {/* The scan route is secondary and reads as a link, not a rival
                button. It matters to the few people who arrive with a scan
                already in hand, and to nobody else. */}
            <Link
              href="/scan"
              className="text-muted hover:text-ink press-sm -ml-1 inline-flex min-h-11 items-center gap-1 rounded-full px-1 text-sm font-medium transition-colors"
            >
              Have a meal scan? Redeem it
              <ChevronRightIcon className="size-4" />
            </Link>
          </div>
        </Container>

        {/* ----------------------------------------------------------------
            Real stalls, or nothing at all. */}
        {open.length ? (
          <Container size="wide" className="border-line border-t pt-8 sm:pt-9">
            <div className="mb-4 flex items-end justify-between gap-4">
              <h2 className="text-lg font-semibold tracking-tight sm:text-2xl">Open right now</h2>
              <Link
                href="/order"
                className="text-muted hover:text-ink press-sm inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full text-sm font-semibold transition-colors"
              >
                See all
                <ChevronRightIcon className="size-4" />
              </Link>
            </div>
            <ul className="stagger grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
              {open.map((vendor) => (
                <li key={vendor.id}>
                  <Link href={`/order/${vendor.id}`} className="press block rounded-[16px]">
                    <ImagePlaceholder name={vendor.name} />
                    <p className="mt-2.5 px-0.5 leading-snug font-semibold break-words">
                      {vendor.name}
                    </p>
                    <p className="text-good mt-1 flex items-center gap-1.5 px-0.5 text-sm font-medium">
                      <span className="bg-good size-1.5 rounded-full" />
                      Open
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </Container>
        ) : null}

        {/* ----------------------------------------------------------------
            How it works: three short lines, not three cards with icons in
            circles. One sentence each is the whole budget. */}
        <Container size="wide" className="border-line mt-8 border-t pt-8 sm:mt-11 sm:pt-9">
          <h2 className="text-lg font-semibold tracking-tight sm:text-2xl">How it works</h2>
          <ol className="mt-5 grid gap-x-10 gap-y-5 sm:grid-cols-3">
            {HOW_IT_WORKS.map(([title, body], index) => (
              <li key={title} className="flex gap-3.5 sm:block">
                <span className="text-brand-700 shrink-0 text-sm font-semibold tabular-nums sm:mb-1.5 sm:block">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-muted mt-1 text-sm leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Container>

        {/* ----------------------------------------------------------------
            The two secondary audiences, as quiet rows. Signposts, not
            pitches. */}
        <Container size="wide" className="border-line mt-8 border-t pt-2 sm:mt-11 sm:pt-3">
          <ul className="divide-line divide-y">
            <li>
              <Link
                href="/partner/apply"
                className="press-sm group flex min-h-16 items-center gap-4 py-5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Deliver with Campus Dash</span>
                  <span className="text-muted mt-1 block text-sm leading-relaxed">
                    Students bring orders across campus and are paid per delivery.
                  </span>
                </span>
                <ChevronRightIcon className="text-faint size-5 shrink-0" />
              </Link>
            </li>
            <li>
              <Link href="/vendor" className="press-sm flex min-h-16 items-center gap-4 py-5">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Sell on Campus Dash</span>
                  <span className="text-muted mt-1 block text-sm leading-relaxed">
                    Already a vendor? Sign in to your order board.
                  </span>
                </span>
                <ChevronRightIcon className="text-faint size-5 shrink-0" />
              </Link>
            </li>
          </ul>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
