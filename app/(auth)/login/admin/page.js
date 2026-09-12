import Link from 'next/link';
import { safeNext } from '@/lib/auth/landing';
import AdminLoginForm from './admin-login-form';

export const metadata = { title: 'Administrator sign-in · Campus Dash' };

/**
 * Deliberately not linked from the landing page. It is not a secret — the
 * security is the password and the is_admin check behind it — but the public
 * page has three audiences and this is not one of them.
 */
export default async function AdminLoginPage({ searchParams }) {
  const params = await searchParams;
  // Where the guard was headed before it found no session. Only ever honoured
  // as a path on this application — see safeNext.
  const next = safeNext(params?.next);
  // Arrived back from the reset form, which signs the recovery session out on
  // purpose: the new password still has to be proved here.
  const justReset = params?.reset === 'done';

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Administrator</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        Operational access uses a password, not an SMS code, so it still works when the messaging
        channel is the thing that is broken.
      </p>

      {justReset ? (
        <p
          role="status"
          className="rounded-card border-good/30 bg-good/10 mt-6 border p-3.5 text-sm leading-relaxed"
        >
          Your password has been changed. Sign in with it below.
        </p>
      ) : null}

      <AdminLoginForm next={next} />

      <p className="text-muted mt-4 text-sm">
        <Link href="/login/admin/forgot" className="underline underline-offset-4">
          Forgot your password?
        </Link>
      </p>

      <p className="text-muted mt-8 text-xs leading-relaxed">
        Ordering and Partner accounts sign in with a code sent to their school address.{' '}
        <Link href="/login" className="underline underline-offset-4">
          go to the student sign-in
        </Link>
        .
      </p>
    </main>
  );
}
