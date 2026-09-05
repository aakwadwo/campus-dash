import Link from 'next/link';
import { getCapabilities } from '@/lib/auth/session';
import { listVendors } from '@/lib/customer';
import SiteHeader from '../site-header';
import SiteFooter from '../site-footer';
import VendorSearch from './vendor-search';
import {
  Container,
  Callout,
  EmptyState,
  ScanIcon,
  StoreIcon,
  ChevronRightIcon,
  TextLink,
} from '../ui';

export const metadata = { title: 'Browse vendors · Campus Dash' };
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
 * Filtering happens in the browser over the list already rendered. There is no
 * vendor search RPC and inventing one to make the page feel richer would be
 * building backend for a screenshot; with a campus-sized catalogue a client
 * filter is also simply the right tool.
 */
export default async function VendorListPage() {
  const me = await getCapabilities();
  const vendors = await listVendors();

  const open = vendors.filter((v) => v.is_accepting_orders);
  const closed = vendors.filter((v) => !v.is_accepting_orders);

  return (
    <div className="min-h-dvh">
      <SiteHeader active="browse" />

      <main className="pb-24 sm:pb-0">
        <Container size="wide" className="pt-8 sm:pt-12">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h1 className="text-display text-2xl font-semibold sm:text-4xl">Browse food</h1>
            {me.can_order ? (
              <Link
                href="/orders"
                className="text-muted hover:text-ink press-sm hidden shrink-0 items-center gap-1 rounded-full text-sm font-semibold transition-colors sm:inline-flex"
              >
                My orders
                <ChevronRightIcon className="size-4" />
              </Link>
            ) : null}
          </div>

          {/* The scan route, deliberately quiet. It is not a vendor and it
              answers a different question from "what is open?", so it gets one
              compact row rather than a highlighted panel that competes with the
              food. Somebody arriving with a scan already knows what they want. */}
          <Link
            href="/scan"
            className="press-sm border-line mt-3 flex min-h-12 items-center gap-2 border-b pb-4 text-sm font-medium"
          >
            <ScanIcon className="text-brand-700 size-[18px] shrink-0" />
            <span>Have a meal scan? Redeem it</span>
            <ChevronRightIcon className="text-faint ml-auto size-4 shrink-0" />
          </Link>

          <VendorSearch open={open} closed={closed} />

          {vendors.length === 0 ? (
            <EmptyState
              icon={<StoreIcon className="size-6" />}
              title="No vendors yet"
              description="Campus Dash is still signing up stalls around Academic City. Check back shortly."
            />
          ) : null}

          {/* The gate, after the goods. Two different states, because "sign in"
              and "finish your student details" are different problems and
              telling someone the wrong one wastes their time. */}
          <OrderingGate me={me} className="mt-12" />
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
        href: '/login?next=%2Forder',
        label: 'Sign in',
        body: 'Browse as much as you like. To place an order you need a Campus Dash account.',
      }
    : {
        href: '/onboarding?next=%2Forder',
        label: 'Add your student details',
        body: 'Campus Dash is for Academic City students. Add your student details to this account and you can order.',
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
