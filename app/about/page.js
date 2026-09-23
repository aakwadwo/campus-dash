import Image from 'next/image';
import Link from 'next/link';
import SiteHeader from '@/app/site-header';
import SiteFooter from '@/app/site-footer';
import { listVendors } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import { CampusDashMark } from '@/app/brand';
import { Container, ButtonLink, ChevronRightIcon, Disclosure } from '@/app/ui';

export const metadata = {
  title: 'About',
  description:
    'Campus Dash is how Academic City orders from the stores on campus. Pay once, then collect it yourself or have a Campus Dash Partner bring it to you.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'About · Campus Dash',
    description:
      'Campus Dash is how Academic City orders from the stores on campus. Pay once, then collect it yourself or have a Campus Dash Partner bring it to you.',
    url: '/about',
  },
};

export const dynamic = 'force-dynamic';

/**
 * What Campus Dash is, what it does, and why it exists.
 *
 * SHORT STATEMENTS FIRST. Each idea is one line a person can take in while
 * scrolling; the reasoning behind it is one tap away rather than a paragraph
 * standing between them and the next idea.
 *
 * THE IMAGERY IS REAL OR ABSENT. There is no campaign photography in this
 * project, and a stock photo of smiling strangers would be a claim about
 * people who are not here. So the pictures are the stores' own photographs,
 * straight from the marketplace, and when there are none yet the page is type
 * and the runner. No testimonials, no statistics, no quotes: nothing on this
 * page is a claim Campus Dash cannot stand behind.
 */
const WHY = [
  {
    title: 'Because the walk and the queue are time nobody wanted to spend.',
    body: 'Lunch is the errand every student runs, several times a week, between lectures that do not wait. Campus Dash puts the stores around Academic City in one place, with what it has right now and what it costs, so the decision takes a minute and the walk is optional.',
  },
  {
    title: 'Because a campus is small enough to look after itself.',
    body: 'The person bringing your order is a student or member of staff here, which is why we call them a Partner and mean it. The stores are the ones you already know. Campus Dash is the part in the middle that makes it simple for all of them to find each other.',
  },
  {
    title: 'Because fair and clear beats clever.',
    body: 'You see the whole price before you pay, and you pay once. Stores get paid orders with a queue number, and keep the full price of their food. Partners choose what they carry and see a customer’s number only while they are carrying their order. First names in both directions, surnames in neither.',
  },
];

const SIDES = [
  {
    title: 'Students and staff',
    body: 'Everything open on campus, one payment, collected or brought to you.',
    href: '/order',
    cta: 'Browse',
  },
  {
    title: 'Stores',
    body: 'Paid orders on a screen by the counter. No calls, no chasing.',
    href: '/vendor/signup',
    cta: 'Sell on Campus Dash',
  },
  {
    title: 'Campus Dash Partners',
    body: 'Carry orders across a campus you are already crossing, and earn on each one.',
    href: '/partner/apply',
    cta: 'Become a Partner',
  },
];

export default async function AboutPage() {
  // The stores' own photographs, when there are any. A slow or failed read
  // costs the page its pictures, never the page.
  const vendors = await listVendors().catch(() => []);
  const photos = (vendors ?? [])
    .filter((v) => v.image_path)
    .slice(0, 6)
    .map((v) => ({ id: v.vendor_id, name: v.name, url: vendorImageUrl(v.image_path) }));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex-1 pb-16">
        {/* --------------------------------------------------------------
            The hero. The line stays; the philosophy sits under it. */}
        <section className="bg-navy relative isolate overflow-hidden">
          <CampusDashMark
            height={260}
            className="pointer-events-none absolute -right-16 -bottom-10 -z-10 opacity-20 sm:right-10 sm:opacity-90"
          />
          <Container size="wide" className="py-14 sm:py-24">
            <h1 className="text-display max-w-2xl text-[2.5rem] leading-[1.05] font-semibold text-balance text-white sm:text-6xl">
              Campus Food Brought to You
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-white/80">
              Campus Dash is how Academic City orders from the stores on campus. Pay once, then
              collect it yourself or have a Campus Dash Partner bring it to you.
            </p>
            <div className="mt-8">
              <ButtonLink href="/order" size="lg" className="px-7">
                Browse
              </ButtonLink>
            </div>
          </Container>
        </section>

        {/* --------------------------------------------------------------
            Real stores, if there are photographs of them yet. */}
        {photos.length >= 3 ? (
          <div className="-mt-px overflow-hidden">
            <ul className="flex gap-2 overflow-x-auto px-4 py-4 sm:justify-center sm:px-6">
              {photos.map((photo) => (
                <li key={photo.id} className="shrink-0">
                  <Image
                    src={photo.url}
                    alt={photo.name}
                    width={224}
                    height={144}
                    className="rounded-card bg-surface-2 h-28 w-40 object-cover sm:h-36 sm:w-56"
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* --------------------------------------------------------------
            What it does, plainly, then why in one line. */}
        <Container size="wide" className="pt-14 sm:pt-20">
          <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] sm:gap-16">
            <h2 className="text-display text-3xl font-semibold text-balance sm:text-4xl">
              What Campus Dash does
            </h2>
            <div className="text-muted space-y-4 text-lg leading-relaxed">
              <p>
                You choose a store, pay once, and either collect your order at the counter or have a
                Campus Dash Partner bring it to where you are on campus. The store only ever sees
                paid orders, and a four-digit code at each handoff makes sure the food reaches the
                right person.
              </p>
              <p>
                At stores that take them, your Meal Scan can pay for the food. You see every fee
                before you pay.
              </p>
              <p className="text-ink font-medium">
                It exists so a meal fits between lectures, stores reach the whole campus, and the
                students and staff who carry orders earn for helping.
              </p>
            </div>
          </div>
        </Container>

        {/* --------------------------------------------------------------
            Why. Short statements, the reasoning one tap away. */}
        <Container size="wide" className="pt-14 sm:pt-20">
          <h2 className="text-muted mb-2 text-sm font-semibold">Why it exists</h2>
          <div className="border-line border-t">
            {WHY.map((item) => (
              <Disclosure key={item.title} title={item.title}>
                <p className="text-muted max-w-2xl leading-relaxed">{item.body}</p>
              </Disclosure>
            ))}
          </div>
        </Container>

        {/* --------------------------------------------------------------
            The three sides, each with the one thing to do. */}
        <Container size="wide" className="pt-14 sm:pt-20">
          <h2 className="text-display text-2xl font-semibold sm:text-3xl">
            One campus, three sides
          </h2>
          <ul className="divide-line border-line mt-6 divide-y border-y">
            {SIDES.map((side) => (
              <li key={side.title}>
                <Link
                  href={side.href}
                  className="press-sm group flex min-h-20 items-center gap-4 py-5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{side.title}</span>
                    <span className="text-muted mt-1 block text-sm leading-relaxed">
                      {side.body}
                    </span>
                  </span>
                  <span className="text-brand-700 hidden shrink-0 text-sm font-semibold sm:inline">
                    {side.cta}
                  </span>
                  <ChevronRightIcon className="text-faint size-5 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-muted mt-8 text-sm">
            Campus Dash is running a pilot at Academic City University.
          </p>
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}
