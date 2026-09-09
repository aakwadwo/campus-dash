import { Suspense } from 'react';
import Link from 'next/link';
import LoginForm from './login-form';
import { safeNext } from '@/lib/auth/landing';
import { Card, TextLink, ArrowLeftIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';

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
            <CampusDashMark height={44} className="mx-auto mb-5" alt="Campus Dash" />
            <h1 className="text-display text-3xl font-semibold">Sign in</h1>
            <p className="text-muted mx-auto mt-2.5 max-w-xs text-sm leading-relaxed">
              We&apos;ll email a code to your school address. One account orders, delivers, and
              sells.
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <Suspense>
              <LoginForm next={next} />
            </Suspense>
          </Card>

          <p className="text-muted mt-6 text-center text-sm leading-relaxed">
            New here?{' '}
            <TextLink href="/signup" className="font-medium">
              Create an account
            </TextLink>
          </p>

          {/*
            Vendors sign in by phone, because a store owner has a number and may
            well not have a school address. Administrators are not linked from
            anywhere public — /admin is typed, not advertised. That is not the
            security control (is_admin() in every admin function is); there is
            simply no reason to put the door on the map.
          */}
          <p className="text-muted mt-3 text-center text-sm leading-relaxed">
            Run a store?{' '}
            <TextLink href="/login/vendor" className="font-medium">
              Sign in with your phone
            </TextLink>
          </p>

          <p className="text-faint mt-5 text-center text-xs leading-relaxed">
            In development the verification email is delivered to Mailpit at{' '}
            <code className="font-mono">127.0.0.1:54324</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
