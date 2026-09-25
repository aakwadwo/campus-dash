import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { vendorStoreId } from '@/lib/auth/landing';
import AreaSwitcher from '@/app/area-switcher';
import { UserIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';
import { VendorTabs, VendorBottomBar } from './vendor-nav';

/**
 * NEVER INDEXED. Everything under this route needs a session, so a crawler
 * would only ever reach a sign-in bounce — but the URLs themselves say things
 * (which store an order belongs to), and robots.txt is a request rather than a rule. This is the layer a
 * crawler that already has the URL actually honours.
 */
export const metadata = {
  // An object, not a string: a plain string here would stop the root
  // template reaching every page below, and their tabs would lose the name.
  title: { default: 'Vendor', template: '%s · Campus Dash' },
  robots: { index: false, follow: false },
};

/**
 * Guards the SESSION here, and membership one level down.
 *
 * This layout used to call requireVendorStaff(), which bounced anyone with no
 * store straight to landingFor() — for an administrator, /admin. That read as
 * "/vendor shows the admin dashboard" and cost an afternoon of looking for a
 * routing bug that did not exist.
 *
 * Membership is checked where it can be explained: the index lists the stores
 * you staff and says so when there are none, and every child route re-checks in
 * the database. /vendor/<someone else's id> still 404s, because getMyVendors()
 * and vendor_order_detail() both re-derive is_vendor_staff() server-side. This
 * layout was never the boundary — RLS and the SECURITY DEFINER functions are.
 *
 * THE NAVIGATION is only drawn for an account that has a store. An applicant
 * has one screen, their application, and four tabs leading to pages that would
 * each redirect back to it are four ways to feel lost.
 *
 * THE ACCOUNT ICON is only drawn for an account that has somewhere to go with
 * it. A vendor-only account is redirected OUT of /account, so the icon used to
 * be a link that led straight back here — and it was the only road to sign-out.
 * Store owners now sign out from the Store tab.
 */
export default async function VendorLayout({ children }) {
  const me = await requireUser('/vendor');
  // An ACTIVE store, or a SUSPENDED one, which its owner still runs.
  const vendorId = vendorStoreId(me);
  // The account area admits anybody who orders or delivers; everyone else is
  // sent back here from it (see the account layout).
  const hasAccountArea = Boolean(me.can_order || me.is_partner);

  return (
    <div className={`min-h-dvh ${vendorId ? 'pb-20 sm:pb-0' : ''}`}>
      <header className="border-line bg-canvas sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
          <Link
            href={vendorId ? `/vendor/${vendorId}` : '/vendor'}
            className="press-sm -ml-1 flex min-h-11 items-center gap-2 rounded-full pr-2 pl-1 font-semibold tracking-tight"
          >
            <CampusDashMark height={26} />
            <span className="text-[15px]">
              <span className="hidden min-[400px]:inline">Campus Dash </span>
              <span className="text-muted font-normal">Vendor</span>
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {/* Owning a store does not consume the account. Someone who also
                orders or delivers reaches those areas from here. */}
            <AreaSwitcher current="/vendor" />
            {hasAccountArea ? (
              <Link
                href="/account"
                className="press-sm hover:bg-surface-2 text-muted grid size-11 place-items-center rounded-full transition-colors"
                aria-label="Account"
              >
                <UserIcon className="size-5" />
              </Link>
            ) : null}
          </div>
        </div>
        {vendorId ? (
          <div className="mx-auto hidden w-full max-w-3xl px-4 sm:block sm:px-6">
            <VendorTabs vendorId={vendorId} />
          </div>
        ) : null}
      </header>
      {children}
      {vendorId ? <VendorBottomBar vendorId={vendorId} /> : null}
    </div>
  );
}
