import { redirect } from 'next/navigation';
import VendorSignUpForm from './signup-form';
import { getCapabilities } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { listCategories, getMyApplication } from '@/lib/vendor';
import { Card, TextLink } from '@/app/ui';
import { CampusDashMark } from '@/app/brand';
import BackButton from '@/app/back-button';

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
  let account = null;
  if (me.authenticated) {
    if (me.vendor_ids?.length) redirect('/vendor');
    const application = await getMyApplication();
    if (application && application.status !== 'REJECTED') redirect('/vendor/application');
    rejectionReason = application?.rejection_reason ?? null;
    account = await accountFacts();
  }

  const categories = await listCategories();

  return (
    <main className="flex min-h-dvh flex-col px-5 py-6 sm:py-10">
      <BackButton fallback="/" />

      <div className="flex flex-1 flex-col justify-center">
        <div className="animate-fade-up mx-auto w-full max-w-md py-6">
          <div className="mb-7 text-center">
            <CampusDashMark height={44} className="mx-auto mb-5" alt="Campus Dash" />
            <h1 className="text-display text-3xl font-semibold">
              {rejectionReason ? 'Resubmit your store' : 'Sell on Campus Dash'}
            </h1>
            <p className="text-muted mx-auto mt-2.5 max-w-sm text-sm leading-relaxed">
              {account
                ? 'Added to the account you already have. Campus Dash reviews every store.'
                : 'Tell us about your store. Campus Dash reviews every one.'}
            </p>
          </div>

          <Card className="p-5 sm:p-6">
            <VendorSignUpForm
              account={account}
              categories={categories}
              resubmitting={Boolean(rejectionReason)}
              rejectionReason={rejectionReason}
            />
          </Card>

          {account ? null : (
            <p className="text-muted mt-6 text-center text-sm leading-relaxed">
              Already registered?{' '}
              <TextLink href="/login/vendor" className="font-medium">
                Sign in
              </TextLink>
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * What the signed-in account already knows, so the form does not ask again.
 *
 * The phone is shown the way Ghanaians write it (0XXXXXXXXX). A code is always
 * sent to whichever number the applicant ends up on, changed or not: the number
 * on a customer profile was typed at sign-up and never proven, and it is about
 * to become how a store signs in.
 */
async function accountFacts() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('users')
    .select('full_name, phone')
    .eq('id', user.id)
    .maybeSingle();

  // STUDENT OR STAFF IS ALREADY ON THE CUSTOMER PROFILE, so the store form
  // does not ask it again. Null for an account with no customer profile.
  const { data: customer } = await supabase
    .from('customer_profiles')
    .select('affiliation')
    .eq('user_id', user.id)
    .maybeSingle();

  const phone = profile?.phone ?? null;
  return {
    name: profile?.full_name ?? null,
    phone: phone ? phone.replace(/^\+233/, '0') : '',
    isStudent: customer?.affiliation ? (customer.affiliation === 'STUDENT' ? 'yes' : 'no') : null,
  };
}
