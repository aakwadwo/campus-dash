import Link from 'next/link';
import SiteHeader from '@/app/site-header';
import SiteFooter from '@/app/site-footer';
import { Container, ButtonLink, ChevronRightIcon } from '@/app/ui';

export const metadata = {
  title: 'What Campus Dash is building',
  description:
    'Campus Dash makes campus life easier by connecting students, vendors and the wider Academic City community through simple access to the things they need.',
  alternates: { canonical: '/about' },
  openGraph: {
    title: 'What Campus Dash is building',
    description:
      'Campus Dash makes campus life easier by connecting students, vendors and the wider Academic City community through simple access to the things they need.',
    url: '/about',
  },
};

/**
 * What Campus Dash is, said plainly.
 *
 * THE RISK WITH A PAGE LIKE THIS is that it floats. A student who lands here
 * wants to know what the thing does and whether it works where they live, and a
 * paragraph about connection answers neither. So every section below starts
 * from something concrete — an order, a store, a person walking across campus —
 * and the idea comes after it rather than instead of it.
 *
 * Food is the wedge. Convenience is the product. Connection is the philosophy.
 * That is the internal formulation and it is deliberately NOT printed here as a
 * slogan: it is a note to ourselves about sequencing, and a reader who has not
 * used the product would take it as a claim about what they are getting.
 */
export default function AboutPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />

      <main className="flex-1 pb-16">
        <Container size="wide" className="pt-10 pb-8 sm:pt-16 sm:pb-12">
          <h1 className="text-display max-w-3xl text-[2.25rem] leading-[1.08] font-semibold text-balance sm:text-5xl">
            Campus Dash makes campus life easier.
          </h1>
          <p className="text-muted mt-5 max-w-xl text-lg leading-relaxed">
            We connect students, the stores around Academic City and the people already walking
            between them, so getting what you need takes a few taps instead of an afternoon.
          </p>
          <div className="mt-8">
            <ButtonLink href="/order" size="lg" className="px-7">
              Browse food
            </ButtonLink>
          </div>
        </Container>

        {/* ------------------------------------------------------------------
            What it actually does today. Concrete first. */}
        <Container size="wide" className="border-line border-t pt-10 sm:pt-12">
          <h2 className="text-display text-2xl font-semibold sm:text-3xl">
            It starts with lunch, because lunch is the thing everybody needs
          </h2>
          <p className="text-muted mt-4 max-w-2xl leading-relaxed">
            Food is where we started. It is the errand every student on campus runs, several times a
            week, and it is the one where twenty minutes of walking and queuing is most obviously
            twenty minutes nobody wanted to spend. Order from a store around Academic City, and
            either collect it yourself or have a Campus Dash Partner bring it to where you already
            are.
          </p>
          <p className="text-muted mt-4 max-w-2xl leading-relaxed">
            Food is not the point, though. It is the first thing worth building properly. What we
            are actually building is the way a campus gets things to the people on it.
          </p>
        </Container>

        {/* ------------------------------------------------------------------
            The three sides, each described by what they get. */}
        <Container size="wide" className="border-line mt-10 border-t pt-10 sm:mt-12 sm:pt-12">
          <h2 className="text-display text-2xl font-semibold sm:text-3xl">
            Three sides, one campus
          </h2>

          <div className="mt-8 grid gap-10 sm:grid-cols-3 sm:gap-8">
            <section>
              <h3 className="font-semibold">If you are ordering</h3>
              <p className="text-muted mt-2 leading-relaxed">
                You see what is open right now and what it costs, all of it, before you pay. One
                payment covers everything. Then you get on with your day, and your order finds you.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">If you run a store</h3>
              <p className="text-muted mt-2 leading-relaxed">
                Every order arrives already paid for, with the items and a queue number, on a screen
                you can prop next to the hotplate. No phone calls, no chasing, no deciding whether
                somebody is good for it. You reach students who would not have walked to you today.
              </p>
            </section>

            <section>
              <h3 className="font-semibold">If you are a Campus Dash Partner</h3>
              <p className="text-muted mt-2 leading-relaxed">
                You are already crossing campus. A Partner picks up orders that fit around where
                they are going, earns on each one, and helps somebody they probably share a lecture
                hall with. You choose what you take and when you are available.
              </p>
            </section>
          </div>
        </Container>

        {/* ------------------------------------------------------------------
            The part that is genuinely a belief, and is labelled as one. */}
        <Container size="wide" className="border-line mt-10 border-t pt-10 sm:mt-12 sm:pt-12">
          <h2 className="text-display text-2xl font-semibold sm:text-3xl">
            A campus is small enough that this can be neighbourly
          </h2>
          <p className="text-muted mt-4 max-w-2xl leading-relaxed">
            Academic City is one campus with one community on it. The person bringing your order is
            a student here, not a stranger and not staff — which is why we call them a Partner and
            mean it. They are participating in something they also use.
          </p>
          <p className="text-muted mt-4 max-w-2xl leading-relaxed">
            That shapes what we build. We show first names in both directions and surnames in
            neither. A Partner sees a phone number while they are carrying your order and not
            afterwards. Stores see what to make and nothing about where it is going. None of that is
            a feature list; it is what treating everybody here as a neighbour looks like once it is
            written down as software.
          </p>
        </Container>

        {/* ------------------------------------------------------------------
            Honest about scope. A page like this earns trust by what it
            declines to claim. */}
        <Container size="wide" className="border-line mt-10 border-t pt-10 sm:mt-12 sm:pt-12">
          <h2 className="text-display text-2xl font-semibold sm:text-3xl">Where we are</h2>
          <p className="text-muted mt-4 max-w-2xl leading-relaxed">
            Campus Dash is running a pilot at Academic City with a small number of stores. Food
            first, then the other things a campus needs moved around it. We would rather do one
            campus properly than several badly.
          </p>

          <ul className="divide-line mt-8 divide-y">
            <li>
              <Link
                href="/partner/apply"
                className="press-sm flex min-h-16 items-center gap-4 py-5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">Become a Campus Dash Partner</span>
                  <span className="text-muted mt-1 block text-sm leading-relaxed">
                    Earn while you move around campus.
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
                    Reach more students from the counter you already have.
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
