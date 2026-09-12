import Link from 'next/link';
import ForgotPasswordForm from './forgot-form';

export const metadata = { title: 'Reset your password · Campus Dash' };

/**
 * Step one of administrator recovery.
 *
 * Reachable from /login/admin and nowhere else, for the same reason that page
 * is not linked publicly: the security is the is_admin check behind it, but
 * there is no reason to put the door on the map.
 */
export default async function AdminForgotPasswordPage({ searchParams }) {
  const expired = (await searchParams)?.link === 'expired';

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Reset your password</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        We&rsquo;ll email a link to the address you sign in with. It sets a new password and nothing
        else — following it does not sign you in.
      </p>

      {expired ? (
        <p
          role="alert"
          className="rounded-card border-amber/30 bg-amber/10 mt-6 border p-3.5 text-sm leading-relaxed"
        >
          That link has expired or has already been used. Ask for another one below.
        </p>
      ) : null}

      <ForgotPasswordForm />

      <p className="text-muted mt-8 text-xs leading-relaxed">
        Remembered it?{' '}
        <Link href="/login/admin" className="underline underline-offset-4">
          back to administrator sign-in
        </Link>
        .
      </p>
    </main>
  );
}
