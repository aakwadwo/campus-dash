import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';

export const metadata = { title: 'Partner · Campus Dash' };

/**
 * Any signed-in user can reach the Partner area — that is how someone applies.
 * What they can DO is decided per page, and ultimately by the database.
 */
export default async function PartnerLayout({ children }) {
  await requireUser('/partner');
  return (
    <div className="bg-canvas min-h-dvh">
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-md items-center gap-4 px-4 py-3 text-sm">
          <Link href="/partner" className="font-semibold tracking-tight">
            Campus Dash <span className="text-muted font-normal">Partner</span>
          </Link>
          <Link href="/account" className="text-muted ml-auto">
            Account
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
