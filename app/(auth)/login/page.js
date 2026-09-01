import { Suspense } from 'react';
import Link from 'next/link';
import LoginForm from './login-form';
import { safeNext } from '@/lib/auth/landing';

export const metadata = { title: 'Sign in · Campus Dash' };

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;

  // Empty, not '/account'. A bare visit to /login has no destination in mind, so
  // the destination is derived from capabilities after the code is verified.
  // Only a guard that redirected somebody here supplies one.
  const next = safeNext(params?.next) ?? '';

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        We&apos;ll text you a code. One account works for both ordering and delivering.
      </p>

      <Suspense>
        <LoginForm next={next} />
      </Suspense>

      <p className="text-muted mt-8 text-xs leading-relaxed">
        In development the code is printed to the Next.js server console by the fake SMS provider,
        and shown at <code>/dev/inbox</code>.
      </p>

      <p className="text-muted mt-3 text-xs leading-relaxed">
        Administrators sign in with{' '}
        <Link href="/login/admin" className="underline underline-offset-4">
          an email and password
        </Link>{' '}
        instead — operational access must not depend on an SMS arriving.
      </p>
    </main>
  );
}
