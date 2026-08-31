import Link from 'next/link';
import { requireAdmin } from '@/lib/auth/session';
import { signOut } from '@/app/(auth)/login/actions';

export const metadata = { title: 'Admin · Campus Dash' };

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/pilot', label: 'Pilot' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/money', label: 'Money' },
  { href: '/admin/settlements', label: 'Settlements' },
  { href: '/admin/vendors', label: 'Vendors' },
  { href: '/admin/locations', label: 'Locations' },
  { href: '/admin/partners', label: 'Partners' },
  { href: '/admin/audit', label: 'Audit' },
];

/**
 * requireAdmin() runs on every admin page through this layout. It is a
 * convenience, not the boundary: each admin function re-checks is_admin() in
 * the database, so bypassing this reaches screens that can do nothing.
 */
export default async function AdminLayout({ children }) {
  const me = await requireAdmin();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <Link href="/admin" className="font-semibold tracking-tight">
            Campus Dash <span className="text-muted font-normal">admin</span>
          </Link>
          <nav className="flex flex-wrap gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-brand-700">
                {item.label}
              </Link>
            ))}
          </nav>
          <form action={signOut} className="ml-auto">
            <button type="submit" className="text-muted text-sm hover:text-red-700">
              Sign out ({me.full_name ?? me.phone})
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
