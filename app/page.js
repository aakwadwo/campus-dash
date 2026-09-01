import Link from 'next/link';

export const metadata = {
  title: 'Campus Dash',
  description:
    'Get what you need from trusted vendors around Academic City. Collect it yourself, or have a verified student Partner bring it to you.',
};

/**
 * The public landing page.
 *
 * Three audiences, two of them primary. Customers and vendors get the two
 * buttons; Partners get a quieter route further down, because recruiting
 * Partners is a smaller and more deliberate act than taking an order.
 *
 * The wording stays broader than food on purpose. Food is where Campus Dash
 * starts, not what it is — describing it as a food app now would make every
 * later category look like a bolt-on.
 */

const HOW_IT_WORKS = [
  {
    title: 'Choose a vendor',
    body: 'Approved vendors around Academic City, with what they actually have available right now.',
  },
  {
    title: 'Collect it, or have it brought',
    body: 'Pick it up yourself for no delivery fee, or send it to a campus room, block or common area.',
  },
  {
    title: 'Pay once, in the app',
    body: 'One payment covers the vendor, the delivery and the Campus Dash fee. Prices are set by the vendor.',
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh">
      <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
        <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">
          Academic City University
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Campus Dash</h1>
        <p className="mt-4 max-w-xl text-lg leading-relaxed text-balance">
          Get what you need from trusted vendors around campus. Collect it yourself, or have a
          verified student Partner bring it to you.
        </p>

        {/* The two primary paths. Everything else on this page is secondary.
            Customer is the filled one because it is the larger audience by far;
            Vendor is the same shape in outline, which reads as equal in rank
            without competing for the eye. Neither is a black slab. */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/order"
            className="bg-brand-500 hover:bg-brand-600 text-ink grow rounded-xl px-6 py-4 text-center text-base font-semibold transition-colors"
          >
            Customer
            <span className="mt-0.5 block text-sm font-normal opacity-75">
              Browse vendors and order
            </span>
          </Link>
          <Link
            href="/vendor"
            className="text-ink hover:border-brand-600 hover:bg-brand-50 grow rounded-xl border border-black/12 bg-white px-6 py-4 text-center text-base font-semibold transition-colors"
          >
            Vendor
            <span className="text-muted mt-0.5 block text-sm font-normal">
              Receive and manage orders
            </span>
          </Link>
        </div>

        <section className="mt-16">
          <h2 className="text-sm font-semibold tracking-wide uppercase">How it works</h2>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {HOW_IT_WORKS.map((step, index) => (
              <li key={step.title} className="rounded-xl bg-white p-5 ring-1 ring-black/5">
                <span className="bg-brand-500 text-ink grid size-7 place-items-center rounded-full text-xs font-semibold">
                  {index + 1}
                </span>
                <h3 className="mt-3 font-semibold">{step.title}</h3>
                <p className="text-muted mt-1.5 text-sm leading-relaxed">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Partner recruitment — the secondary pathway. */}
        <section className="border-brand-600/60 bg-brand-50/60 mt-12 rounded-xl border p-6">
          <h2 className="text-lg font-semibold">Want to deliver with Campus Dash?</h2>
          <p className="text-muted mt-1.5 max-w-lg text-sm leading-relaxed">
            Campus Dash Partners are Academic City students who bring orders to a campus destination
            and are paid for each delivery. You choose when you are available, and you carry one
            delivery at a time.
          </p>
          <Link
            href="/partner/apply"
            className="text-brand-700 mt-4 inline-block text-sm font-semibold underline underline-offset-4"
          >
            Join us as a Partner
          </Link>
        </section>
      </main>

      <footer className="border-t border-black/10">
        <div className="text-muted mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-6 text-sm">
          <span>Campus Dash · Academic City University, Ghana</span>
          <Link href="/terms" className="ml-auto underline underline-offset-4">
            Terms
          </Link>
          <Link href="/login" className="underline underline-offset-4">
            Sign in
          </Link>
        </div>
      </footer>
    </div>
  );
}
