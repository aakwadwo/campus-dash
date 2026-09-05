import { Suspense } from 'react';
import Link from 'next/link';
import LoginForm from './login-form';
import { safeNext } from '@/lib/auth/landing';
import { Card, TextLink, ArrowLeftIcon } from '@/app/ui';

export const metadata = { title: 'Sign in · Campus Dash' };

/**
 * Sign-in.
 *
 * A single centred card on a plain ground — this is the most focused screen in
 * the product and everything that is not the form is a distraction. The route
 * back to browsing stays visible at the top, because arriving here by accident
 * should cost one tap, not a back-button hunt: the marketplace is open to
 * everyone and nobody should feel walled in.
 */
export default async function LoginPage({ searchParams }) {
  const params = await searchParams;

  // Empty, not '/account'. A bare visit to /login has no destination in mind, so
  // the destination is derived from capabilities after the code is verified.
  // Only a guard that redirected somebody here supplies one.
  const next = safeNext(params?.next) ?? '';

  return (
    <main className="flex min-h-dvh flex-col px-5 py-6 sm:py-10">
      <Link
        href="/order"
        className="text-muted hover:text-ink press-sm -ml-1 inline-flex w-fit items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-sm font-medium transition-colors"
      >
        <ArrowLeftIcon className="size-4" />
        Keep browsing
      </Link>

      <div className="flex flex-1 flex-col justify-center">
        <div className="animate-fade-up mx-auto w-full max-w-sm">
          <div className="mb-8 text-center">
            <span className="bg-brand-500 text-ink mx-auto mb-5 grid size-12 place-items-center rounded-full text-base font-bold">
              CD
            </span>
            <h1 className="text-display text-3xl font-semibold">Sign in</h1>
            <p className="text-muted mx-auto mt-2.5 max-w-xs text-sm leading-relaxed">
              We&apos;ll text you a code. One account works for both ordering and delivering.
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <Suspense>
              <LoginForm next={next} />
            </Suspense>
          </Card>

          <p className="text-muted mt-6 text-center text-xs leading-relaxed">
            Administrators sign in with{' '}
            <TextLink href="/login/admin" className="font-medium">
              an email and password
            </TextLink>{' '}
            instead, because operational access must not depend on an SMS arriving.
          </p>

          <p className="text-faint mt-4 text-center text-xs leading-relaxed">
            In development the code is printed to the server console by the fake SMS provider, and
            shown at <code className="font-mono">/dev/inbox</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
