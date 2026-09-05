import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { currentTerms } from '@/lib/terms';
import { safeNext } from '@/lib/auth/landing';
import OnboardingForm from './onboarding-form';
import SiteHeader from '@/app/site-header';
import { Container } from '@/app/ui';

export const metadata = { title: 'Student details · Campus Dash' };
export const dynamic = 'force-dynamic';

/**
 * Student onboarding.
 *
 * The account already exists — a phone number was verified to reach this page.
 * What is being added here is the CUSTOMER capability, and the copy says so:
 * nobody is creating a second account, and an administrator or vendor who
 * arrives here is adding ordering to the account they already have rather than
 * converting it into something else.
 */
export default async function OnboardingPage({ searchParams }) {
  const me = await requireUser('/onboarding');
  const params = await searchParams;
  const next = safeNext(params?.next) ?? '/order';

  // Already a customer: there is nothing to do here. Sending them on rather
  // than showing a filled-in form avoids the "did that work?" second submission.
  if (me.can_order) redirect(next);

  const terms = await currentTerms('CUSTOMER');

  return (
    <div className="min-h-dvh">
      <SiteHeader />
      <main className="pb-24 sm:pb-16">
        <Container size="narrow" className="pt-8 sm:pt-12">
          <h1 className="text-display text-3xl font-semibold sm:text-4xl">Your student details</h1>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            You are signed in as <span className="tabular-nums">{me.phone}</span>. Campus Dash is
            for Academic City students, so we need a few details before you can place an order. This
            adds ordering to the account you already have. It does not create a second one.
          </p>

          {terms ? (
            <OnboardingForm terms={terms} next={next} defaultName={me.full_name ?? ''} />
          ) : (
            <div className="rounded-card bg-warn-bg text-warn mt-6 p-4 text-sm">
              <p className="font-semibold">Onboarding is unavailable.</p>
              <p className="mt-1">
                No customer terms have been published for this environment, and we will not grant an
                account access to ordering without a recorded agreement. An administrator needs to
                publish the customer terms.
              </p>
            </div>
          )}

          <p className="text-muted mt-8 text-center text-xs">
            Just browsing?{' '}
            <Link href="/order" className="text-brand-700 underline underline-offset-4">
              Look around first
            </Link>
            .
          </p>
        </Container>
      </main>
    </div>
  );
}
