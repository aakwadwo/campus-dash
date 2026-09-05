import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import AreaSwitcher from '@/app/area-switcher';
import { StoreIcon, UserIcon } from '@/app/ui';

export const metadata = { title: 'Vendor · Campus Dash' };

/**
 * Guards the SESSION here, and membership one level down.
 *
 * This layout used to call requireVendorStaff(), which bounced anyone with no
 * stall straight to landingFor() — for an administrator, /admin. That read as
 * "/vendor shows the admin dashboard" and cost an afternoon of looking for a
 * routing bug that did not exist.
 *
 * Membership is checked where it can be explained: the index lists the stalls
 * you staff and says so when there are none, and every child route re-checks in
 * the database. /vendor/<someone else's id> still 404s, because getMyVendors()
 * and vendor_order_detail() both re-derive is_vendor_staff() server-side. This
 * layout was never the boundary — RLS and the SECURITY DEFINER functions are.
 */
export default async function VendorLayout({ children }) {
  await requireUser('/vendor');
  return (
    <div className="min-h-dvh">
      <header className="border-line bg-canvas sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
          <Link
            href="/vendor"
            className="press-sm flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="bg-brand-500 text-ink grid size-8 place-items-center rounded-full">
              <StoreIcon className="size-4" />
            </span>
            <span>
              Campus Dash <span className="text-muted font-normal">Vendor</span>
            </span>
          </Link>
          {/* Staffing a stall does not consume the account. Someone who also
              orders or delivers reaches those areas from here, not from memory. */}
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div className="hidden sm:block">
              <AreaSwitcher current="/vendor" />
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
