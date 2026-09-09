import Link from 'next/link';
import { getCapabilities } from '@/lib/auth/session';
import AreaSwitcher from './area-switcher';
import { BagIcon, ReceiptIcon, StoreIcon, UserIcon } from './ui';
import { CampusDashLogo } from './brand';

/**
 * The consumer chrome.
 *
 * ONE HEADER FOR SIGNED-IN AND SIGNED-OUT. The marketplace is browsable without
 * an account, so the header must not look like a wall: signed out it shows the
 * same navigation and a single "Sign in" rather than blocking the page. The
 * only thing that changes with a session is the right-hand side.
 *
 * On mobile the primary destinations move to a bottom bar — a top bar with four
 * targets on a 360px screen is a row of things nobody can hit. That is the
 * composition change the references make too, rather than shrinking the desktop
 * arrangement.
 *
 * Reads capabilities, never a client-declared role. `can_order` decides whether
 * "My orders" is offered at all, which keeps the nav honest about what this
 * account can actually do.
 */
export default async function SiteHeader({ active = null }) {
  const me = await getCapabilities();

  const links = [
    { href: '/order', label: 'Browse', icon: StoreIcon, key: 'browse' },
    ...(me.can_order
      ? [{ href: '/orders', label: 'My orders', icon: ReceiptIcon, key: 'orders' }]
      : []),
  ];

  return (
    <>
      <header className="border-line bg-canvas sticky top-0 z-40 border-b">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link
            href="/"
            className="press-sm flex min-h-11 shrink-0 items-center"
            aria-label="Campus Dash home"
          >
            <CampusDashLogo height={28} priority />
          </Link>

          {/* Desktop navigation. Hidden on mobile, where the bottom bar owns it. */}
          <nav className="hidden items-center gap-6 sm:flex" aria-label="Main">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active === link.key ? 'page' : undefined}
                className={`press-sm inline-flex min-h-11 items-center rounded px-1 text-sm transition-colors ${
                  active === link.key
                    ? 'text-ink font-semibold'
                    : 'text-muted hover:text-ink font-medium'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <div className="hidden md:block">
              <AreaSwitcher current="/order" />
            </div>
            {me.authenticated ? (
              <Link
                href="/account"
                aria-current={active === 'account' ? 'page' : undefined}
                className="press-sm hover:bg-surface-2 flex min-h-11 items-center gap-2 rounded-full pr-4 pl-1.5 text-sm font-semibold transition-colors"
              >
                <span className="bg-surface-2 text-muted grid size-7 place-items-center rounded-full">
                  <UserIcon className="size-4" />
                </span>
                <span className="hidden sm:inline">Account</span>
              </Link>
            ) : (
              // Sign UP is the primary action for a signed-out visitor, not
              // sign in: most people arriving here do not have an account yet,
              // and the sign-in page links back the other way. No admin link
              // anywhere — /admin is typed, not advertised.
              <div className="flex items-center gap-1.5">
                <Link
                  href="/login"
                  className="press-sm text-muted hover:text-ink hidden min-h-11 items-center rounded-full px-3 text-sm font-semibold transition-colors sm:inline-flex"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="press bg-brand-700 hover:bg-brand-800 inline-flex min-h-11 items-center rounded-full px-5 text-sm font-semibold text-white transition-colors"
                >
                  Sign up
                </Link>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Mobile primary navigation. Only worth showing when there is more than
          one destination — a bottom bar with a single item is a bar of nothing. */}
      {links.length > 1 ? (
        <nav
          aria-label="Main"
          className="border-line bg-canvas fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] sm:hidden"
        >
          <div className="mx-auto flex max-w-md">
            {links.map((link) => {
              const Icon = link.icon;
              const current = active === link.key;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={current ? 'page' : undefined}
                  className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors ${
                    current ? 'text-brand-700' : 'text-muted'
                  }`}
                >
                  <Icon className="size-[22px]" />
                  {link.label}
                </Link>
              );
            })}
            <Link
              href={me.authenticated ? '/account' : '/login'}
              aria-current={active === 'account' ? 'page' : undefined}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors ${
                active === 'account' ? 'text-brand-700' : 'text-muted'
              }`}
            >
              {me.authenticated ? (
                <UserIcon className="size-[22px]" />
              ) : (
                <BagIcon className="size-[22px]" />
              )}
              {me.authenticated ? 'Account' : 'Sign in'}
            </Link>
          </div>
        </nav>
      ) : null}
    </>
  );
}
