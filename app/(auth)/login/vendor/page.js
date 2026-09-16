import Link from 'next/link';
import { config } from '@/lib/config';
import { Suspense } from 'react';
import VendorLoginForm from './vendor-login-form';
import { safeNext } from '@/lib/auth/landing';
import { Card, TextLink, ArrowLeftIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';

export const metadata = { title: 'Vendor sign in' };

/**
 * Vendor sign-in.
 *
 * A separate screen from the customer one because the PROOF is separate — SMS
 * to the number that is the store's credential, versus a code to a school
 * address. Not because the people are separate: the same identity can hold both
 * capabilities, and where they land afterwards is derived from the database.
 */
export default async function VendorLoginPage({ searchParams }) {
  const params = await searchParams;
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
            <h1 className="text-display text-3xl font-semibold">Vendor sign in</h1>
            <p className="text-muted mx-auto mt-2.5 max-w-xs text-sm leading-relaxed">
              We&apos;ll text a code to the number your store is registered with.
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <Suspense>
              <VendorLoginForm next={next} />
            </Suspense>
          </Card>

          <p className="text-muted mt-6 text-center text-sm leading-relaxed">
            Don&apos;t have a store yet?{' '}
            <TextLink href="/vendor/signup" className="font-medium">
              Register one
            </TextLink>
          </p>

          {/* A developer's note, as on the other sign-in pages: meaningless to a
              store owner in production, and reads like something broke. */}
          {config.isProduction() ? null : (
            <p className="text-faint mt-4 text-center text-xs leading-relaxed">
              In development the code is printed to the server console by the fake SMS provider, and
              shown at <code className="font-mono">/dev/inbox</code>.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
