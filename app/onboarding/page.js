import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { currentTerms } from '@/lib/terms';
import { safeNext } from '@/lib/auth/landing';
import OnboardingForm from './onboarding-form';

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
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Your student details</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed">
        You are signed in as <span className="tabular-nums">{me.phone}</span>. Campus Dash is for
        Academic City students, so we need a few details before you can place an order. This adds
        ordering to the account you already have — it does not create a second one.
      </p>

      {terms ? (
        <OnboardingForm terms={terms} next={next} defaultName={me.full_name ?? ''} />
      ) : (
        <div className="mt-6 rounded-lg bg-amber-50 p-4 text-sm text-amber-900">
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
    </main>
  );
}
