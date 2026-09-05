import Link from 'next/link';
import AdminLoginForm from './admin-login-form';

export const metadata = { title: 'Administrator sign-in · Campus Dash' };

/**
 * Deliberately not linked from the landing page. It is not a secret — the
 * security is the password and the is_admin check behind it — but the public
 * page has three audiences and this is not one of them.
 */
export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Administrator</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        Operational access uses a password, not an SMS code, so it still works when the messaging
        channel is the thing that is broken.
      </p>

      <AdminLoginForm />

      <p className="text-muted mt-8 text-xs leading-relaxed">
        Ordering, vendor and Partner accounts sign in by phone instead.{' '}
        <Link href="/login" className="underline underline-offset-4">
          go to the phone sign-in
        </Link>
        .
      </p>
    </main>
  );
}
