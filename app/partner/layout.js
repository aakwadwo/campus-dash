import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import AreaSwitcher from '@/app/area-switcher';
import { BikeIcon, UserIcon } from '@/app/ui';

export const metadata = { title: 'Partner · Campus Dash' };

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
            className="press-sm flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="bg-brand-500 text-ink grid size-8 place-items-center rounded-full">
              <BikeIcon className="size-4" />
            </span>
            <span>
              Campus Dash <span className="text-muted font-normal">Partner</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* A Partner is always also a Customer. Say so with a link. */}
            <div className="hidden sm:block">
              <AreaSwitcher current="/partner" />
            </div>
            <Link
              href="/account"
              className="press-sm hover:bg-surface-2 text-muted grid size-9 place-items-center rounded-full transition-colors"
              aria-label="Account"
            >
              <UserIcon className="size-[18px]" />
            </Link>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
