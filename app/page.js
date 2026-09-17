import Link from 'next/link';
import SiteHeader from './site-header';
import SiteFooter from './site-footer';
import { listVendors } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import { redirectVendorOnlyAccount } from '@/lib/auth/session';
import {
  ButtonLink,
  Container,
  VendorCard,
  ChevronRightIcon,
  StoreIcon,
  BikeIcon,
  ReceiptIcon,
} from './ui';

export const metadata = {
  // THE TAB TITLE FOR `/`. The root layout's `title.template` deliberately does
  // NOT apply here: a template decorates titles from CHILD segments, and
  // app/page.js shares the root segment with app/layout.js. So this string is
  // rendered verbatim, with no ` · Campus Dash` suffix — which is why it and
  // the layout's `title.default` have to say the same thing.
  title: 'Campus Dash | Food & More at Academic City',
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
 * stores; the vendor strip below is real data from the same anon-readable query
 * the marketplace uses, and when the pilot is empty it simply does not render.
 */

/**
 * Three steps, each with the icon it already had a name for.
 *
 * THE ICONS ARE FROM THE KIT, not drawn for this page: the store is the one on
 * every vendor card, the runner is the one the Partner screens use, the receipt
 * is the one on the price breakdown. A person who has seen the rest of the
 * product has seen all three, which is the only thing an icon here is for.
 * Nothing moves, nothing is in a coloured circle, and the numbers still carry
 * the ordering — the mark is beside the step, not instead of it.
 */
const HOW_IT_WORKS = [
  [StoreIcon, 'Pick a vendor', 'Stores around campus, with what they have right now.'],
  [BikeIcon, 'Collect it, or have it brought', 'Pick it up free, or send it to your block.'],
  [ReceiptIcon, 'Pay once', 'One payment covers the food, the Partner and our fee.'],
];

export default async function Home() {
  // A vendor who is not a customer is sent to their store. Everyone else,
  // signed in or out, gets the homepage. See vendorOnlyHome() in landing.js.
  await redirectVendorOnlyAccount();

  // Never let a slow or failing marketplace query take the landing page down.
  const vendors = await listVendors().catch(() => []);
  // THE REAL PHOTOGRAPH, not a placeholder. storefront_vendors() has returned
  // image_path all along and /order has rendered it all along; the landing page
  // — the one screen a person sees before deciding whether this is worth an
  // account — was the only place still drawing initials in a coloured box.
  const open = (vendors ?? [])
    .filter((v) => v.is_accepting_orders)
    .slice(0, 4)
    .map((v) => ({ ...v, image_url: vendorImageUrl(v.image_path) }));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader active="browse" />

      <main className="flex-1 pb-16">
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
            Real stores, or nothing at all. */}
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
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
              {open.map((vendor) => (
                <li key={vendor.vendor_id}>
                  {/* The same card the marketplace uses, so a photograph loads,
                      falls back and crops identically in both places rather
                      than in two hand-written variants that drift. */}
                  <VendorCard
                    vendor={vendor}
                    href={`/order/${vendor.vendor_id}`}
                    imageUrl={vendor.image_url}
                    meta={
                      vendor.menu_count ? (
                        <span>
                          {vendor.menu_count} {vendor.menu_count === 1 ? 'item' : 'items'}
                        </span>
                      ) : null
                    }
                  />
                </li>
              ))}
            </ul>
          </Container>
        ) : null}

        {/* ----------------------------------------------------------------
            How it works: three short lines with a mark each, not three cards
            with icons in circles. One sentence each is still the whole
            budget. */}
        <Container size="wide" className="border-line mt-8 border-t pt-8 sm:mt-11 sm:pt-9">
          <h2 className="text-lg font-semibold tracking-tight sm:text-2xl">How it works</h2>
          <ol className="mt-5 grid gap-x-10 gap-y-5 sm:grid-cols-3">
            {HOW_IT_WORKS.map(([Icon, title, body], index) => (
              <li key={title} className="flex gap-3.5 sm:block">
                {/* The number and the mark read as one thing: same colour, same
                    line, and on a phone they sit in the gutter the text is
                    already indented past. */}
                <span className="text-brand-700 flex shrink-0 flex-col items-center gap-2 sm:mb-2 sm:flex-row sm:gap-2.5">
                  <Icon className="size-5" />
                  <span className="text-sm font-semibold tabular-nums">
                    {String(index + 1).padStart(2, '0')}
                  </span>
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
                  <span className="block font-semibold">Become a Campus Dash Partner</span>
                  <span className="text-muted mt-1 block text-sm leading-relaxed">
                    Help other students get what they need across campus, and earn on every order.
                  </span>
                </span>
                <ChevronRightIcon className="text-faint size-5 shrink-0" />
              </Link>
            </li>
            <li>
              <Link
                href="/vendor/signup"
                className="press-sm flex min-h-16 items-center gap-4 py-5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Sell on Campus Dash</span>
                  <span className="text-muted mt-1 block text-sm leading-relaxed">
                    Register your store. We text a code to your phone, and you are in. No email
                    needed.
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
