import Link from 'next/link';
import { config } from '@/lib/config';
import { redirect } from 'next/navigation';
import SignUpForm from './signup-form';
import { getCapabilities } from '@/lib/auth/session';
import { safeNext, landingFor } from '@/lib/auth/landing';
import { Card, ArrowLeftIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';

export const metadata = { title: 'Sign up · Campus Dash' };

/**
 * Customer sign-up.
 *
 * Reachable with no session at all — this is where an account comes from, so
 * requiring one would be circular. Somebody who already holds the CUSTOMER
 * capability is sent where they belong rather than shown a form that would
 * refuse them.
 */
export default async function SignUpPage({ searchParams }) {
  const params = await searchParams;
  const next = safeNext(params?.next) ?? '/order';

  const me = await getCapabilities();
  if (me.authenticated && me.can_order) redirect(landingFor(me));

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
        <div className="animate-fade-up mx-auto w-full max-w-sm py-6">
          <div className="mb-7 text-center">
            <CampusDashMark height={44} className="mx-auto mb-5" alt="Campus Dash" />
            <h1 className="text-display text-3xl font-semibold">Create your account</h1>
            <p className="text-muted mx-auto mt-2.5 max-w-xs text-sm leading-relaxed">
              For Academic City students. One account to order, to deliver, and to sell.
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <SignUpForm next={next} hasAccount={me.authenticated} />
          </Card>

          {/* A developer's note. It was shown to every visitor in production,
              where "Mailpit" means nothing and reads like something broke. */}
          {config.isProduction() ? null : (
            <p className="text-faint mt-5 text-center text-xs leading-relaxed">
              In development the verification email is delivered to Mailpit at{' '}
              <code className="font-mono">127.0.0.1:54324</code>.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
