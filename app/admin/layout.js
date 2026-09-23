import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { signOut } from '@/app/(auth)/login/actions';
import AreaSwitcher from '@/app/area-switcher';
import AdminNav from './admin-nav';

/**
 * NEVER INDEXED. Everything under this route needs a session, so a crawler
 * would only ever reach a sign-in bounce — but the URLs themselves say things
 * (that an admin console is here, and where), and robots.txt is a request rather than a rule. This is the layer a
 * crawler that already has the URL actually honours.
 */
export const metadata = {
  // An object, not a string: a plain string here would stop the root
  // template reaching every page below, and their tabs would lose the name.
  title: { default: 'Admin', template: '%s · Campus Dash' },
  robots: { index: false, follow: false, nocache: true },
};

/**
 * requireAdmin() runs on every admin page through this layout. It is a
 * convenience, not the boundary: each admin function re-checks is_admin() in
 * the database, so bypassing this reaches screens that can do nothing.
 */
export default async function AdminLayout({ children }) {
  const me = await requireAdmin();

  return (
    <div className="min-h-dvh">
      {/* The mobile menu panel is `absolute` and anchors to this header, which
          is already a positioned element by virtue of being sticky — so it
          travels with the bar instead of drifting on scroll. */}
      <header className="border-line bg-canvas sticky top-0 z-40 border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 py-3 sm:px-6">
          <Link href="/admin" className="shrink-0 font-semibold tracking-tight">
            Campus Dash <span className="text-muted hidden font-normal sm:inline">admin</span>
          </Link>

          <div className="ml-auto flex items-center gap-3 sm:gap-5">
            <AdminNav />
            {/* Admin is a capability, not an account type. If this account also
                orders, owns a store or carries deliveries, those areas are
                one click away rather than lost behind the landing precedence. */}
            <div className="hidden lg:block">
              <AreaSwitcher current="/admin" />
            </div>
            <form action={signOut} className="shrink-0">
              <button
                type="submit"
                className="text-muted hover:text-bad text-sm font-medium whitespace-nowrap"
              >
                <span className="hidden sm:inline">Sign out ({me.full_name ?? me.phone})</span>
                <span className="sm:hidden">Sign out</span>
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
