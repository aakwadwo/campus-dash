import { getCapabilities } from '@/lib/auth/session';
import { listVendors, listCategories, listSearchableItems } from '@/lib/customer';
import { vendorImageUrl } from '@/lib/verification/documents';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import VendorSearch from './vendor-search';
import ContactLine from '../contact-line';
import { Container, Callout, ChevronRightIcon, TextLink } from '../ui';

export const metadata = {
  title: 'Browse',
  description:
    'Every store open on campus right now, with what they have and what it costs. Collect it yourself or have a Campus Dash Partner bring it.',
  alternates: { canonical: '/order' },
  openGraph: {
    title: 'Browse · Campus Dash',
    description: 'Every store open on campus right now, with what they have and what it costs.',
    url: '/order',
  },
};
export const dynamic = 'force-dynamic';

/**
 * The marketplace. Open to everyone; ordering is not.
 *
 * Browsing needs no account — vendors and menu items are readable by `anon`
 * under their own RLS policies, so this page hits exactly the same queries
 * signed out as it does signed in. What an account (and student onboarding)
 * buys is the ability to place an order, and that is enforced in
 * submit_order_for(), not by hiding the menu.
 *
 * THE GATE IS AN INVITATION, NOT A WALL, and it sits below the vendors rather
 * than above them. A visitor who has not seen anything worth buying has no
 * reason to make an account, so leading with the sign-in prompt was asking for
 * commitment before showing the goods.
 *
 * ONE SEARCH BOX, over the stores and everything they sell. Filtering happens
 * in the browser over what is already rendered; with a campus-sized catalogue a
 * client filter is the right tool, and the item list is read through the same
 * anon RLS policy the store pages use.
 */
export default async function VendorListPage() {
  const [me, rows, categories, items] = await Promise.all([
    getCapabilities(),
    listVendors(),
    listCategories(),
    listSearchableItems().catch(() => []),
  ]);

  // The public URL is resolved here. A client component has no business reading
  // configuration, and a server component cannot hand it a function.
  const vendors = rows.map((v) => ({ ...v, image_url: vendorImageUrl(v.image_path) }));

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader active="browse" />

      <main className="flex-1 pb-24 sm:pb-0">
        <Container size="wide" className="pt-8 sm:pt-12">
          {/* ONE LIST OF STORES. "Use a meal scan" used to sit here as a
              second way to browse, which meant a student had to decide how
              they were paying before they had decided what to eat — and one
              who did not know the feature existed never found it. A store that
              takes a Meal Scan says so on its own page. */}
          <h1 className="text-display mb-5 text-2xl font-semibold sm:text-4xl">Browse</h1>

          <VendorSearch vendors={vendors} categories={categories} items={items} />

          {vendors.length === 0 ? (
            <p className="text-muted py-16 text-center">No stores yet. Check back soon.</p>
          ) : null}

          {/* The gate, after the goods. Two different states, because "sign in"
              and "finish your student details" are different problems and
              telling someone the wrong one wastes their time. */}
          <OrderingGate me={me} className="mt-12" />

          <ContactLine className="mt-10" />
        </Container>
      </main>

      <SiteFooter />
    </div>
  );
}

export function OrderingGate({ me, className = '' }) {
  if (me.can_order) return null;

  const { href, label, body } = !me.authenticated
    ? {
        href: '/signup?next=%2Forder',
        label: 'Create an account',
        body: 'Ordering needs a Campus Dash account, made with your school email.',
      }
    : {
        href: '/signup?next=%2Forder',
        label: 'Finish signing up',
        body: 'Finish signing up and you can order.',
      };

  return (
    <Callout className={className}>
      <p className="leading-relaxed">{body}</p>
      <TextLink href={href} className="mt-1 inline-flex min-h-11 items-center gap-1">
        {label}
        <ChevronRightIcon className="size-4" />
      </TextLink>
    </Callout>
  );
}
