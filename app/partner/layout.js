import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import AreaSwitcher from '@/app/area-switcher';
import { UserIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';

/**
 * NEVER INDEXED. Everything under this route needs a session, so a crawler
 * would only ever reach a sign-in bounce — but the URLs themselves say things
 * (who is carrying what), and robots.txt is a request rather than a rule. This is the layer a
 * crawler that already has the URL actually honours.
 */
export const metadata = {
  // An object, not a string: a plain string here would stop the root
  // template reaching every page below, and their tabs would lose the name.
  title: { default: 'Partner', template: '%s · Campus Dash' },
  robots: { index: false, follow: false },
};

/**
 * Any signed-in user can reach the Partner area — that is how someone applies.
 * What they can DO is decided per page, and ultimately by the database.
 *
 * The chrome matches the consumer header rather than inventing a second one: a
 * Partner is always also a Customer, and two visually unrelated headers on one
 * account is how a single product starts feeling like three.
 */
export default async function PartnerLayout({ children }) {
  await requireUser('/partner');
  return (
    <div className="min-h-dvh">
      <header className="border-line bg-canvas sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-16 w-full max-w-2xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/partner"
            className="press-sm -ml-1 flex min-h-11 items-center gap-2 rounded-full pr-2 pl-1 font-semibold tracking-tight"
          >
            <CampusDashMark height={26} />
            <span className="text-[15px]">
              <span className="hidden min-[400px]:inline">Campus Dash </span>
              <span className="text-muted font-normal">Partner</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* A Partner is always also a Customer. Say so with a link. */}
            <AreaSwitcher current="/partner" />
            <Link
              href="/account"
              className="press-sm hover:bg-surface-2 text-muted grid size-11 place-items-center rounded-full transition-colors"
              aria-label="Account"
            >
              <UserIcon className="size-5" />
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
