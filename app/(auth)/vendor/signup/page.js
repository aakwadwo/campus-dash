import Link from 'next/link';
import { redirect } from 'next/navigation';
import VendorSignUpForm from './signup-form';
import { getCapabilities } from '@/lib/auth/session';
import { listCategories, getMyApplication } from '@/lib/vendor';
import { Card, TextLink, ArrowLeftIcon } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';

export const metadata = { title: 'Register your store' };

/**
 * Vendor registration.
 *
 * Open with no session — this is where a vendor account comes from. Somebody
 * who already has a store is sent to whichever screen matches its state: the
 * dashboard if it is live, the status page if it is waiting. A REJECTED
 * applicant is the one case that lands back HERE, with the reason on screen,
 * because for them this form is the fix.
 */
export default async function VendorSignUpPage() {
  const me = await getCapabilities();

  let rejectionReason = null;
  if (me.authenticated) {
    if (me.vendor_ids?.length) redirect('/vendor');
    const application = await getMyApplication();
    if (application && application.status !== 'REJECTED') redirect('/vendor/application');
    rejectionReason = application?.rejection_reason ?? null;
  }

  const categories = await listCategories();

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
        <div className="animate-fade-up mx-auto w-full max-w-md py-6">
          <div className="mb-7 text-center">
            <CampusDashMark height={44} className="mx-auto mb-5" alt="Campus Dash" />
            <h1 className="text-display text-3xl font-semibold">
              {rejectionReason ? 'Resubmit your store' : 'Sell on Campus Dash'}
            </h1>
            <p className="text-muted mx-auto mt-2.5 max-w-sm text-sm leading-relaxed">
              Tell us about your store. We&apos;ll text a code to confirm your number, then an
              administrator reviews the application.
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <VendorSignUpForm
              categories={categories}
              resubmitting={Boolean(rejectionReason)}
              rejectionReason={rejectionReason}
            />
          </Card>

          <p className="text-muted mt-6 text-center text-sm leading-relaxed">
            Already registered?{' '}
            <TextLink href="/login/vendor" className="font-medium">
              Sign in
            </TextLink>
          </p>
        </div>
      </div>
    </main>
  );
}
