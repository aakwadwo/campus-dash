import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getMyApplication } from '@/lib/partner';
import { getMyCustomerProfile } from '@/lib/customer';
import ApplyForm, { ContinueOrdering } from './apply-form';

export const dynamic = 'force-dynamic';

/**
 * Become a Partner, or see where an existing application stands.
 *
 * BECOME, not "create a Partner account". PARTNER ⇒ CUSTOMER is a foreign key
 * in the database, so reaching this form at all means the account already has a
 * student profile — and the form reuses it rather than asking again. There is
 * no second login, no second email and no second identity anywhere in here.
 */
const DECIDED = {
  PENDING_REVIEW: {
    title: 'Application submitted',
    body: "We'll review it and let you know when a decision is made. Reviewing is done by hand, so it is not instant.",
  },
  REJECTED: {
    title: 'Application not approved',
    body: 'You can apply again with a new live photo. Your student details stay on your account.',
  },
  SUSPENDED: {
    title: 'Partner access suspended',
    body: 'Contact Campus Dash support. Applying again will not lift a suspension.',
  },
};

export default async function PartnerApplyPage() {
  const me = await requireUser('/partner/apply');

  // PARTNER ⇒ CUSTOMER. partner_apply() raises without a customer profile, so
  // the honest thing is to send them to acquire one rather than render a form
  // the database will refuse. `next` brings them back here afterwards.
  if (!me.can_order) redirect('/onboarding?next=%2Fpartner%2Fapply');

  const [application, profile] = await Promise.all([getMyApplication(), getMyCustomerProfile()]);
  const state = DECIDED[application?.status];

  // REJECTED reopens the form underneath the explanation; PENDING_REVIEW and
  // SUSPENDED do not, because re-applying is not the next step in either.
  const showForm = !application || application.status === 'REJECTED';

  return (
    <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {state ? state.title : 'Become a Partner'}
      </h1>

      {state ? (
        <>
          <p className="text-muted mt-2 text-sm leading-relaxed">{state.body}</p>
          {application.review_notes ? (
            <p className="rounded-card bg-surface ring-line mt-3 p-3 text-sm ring-1">
              {application.review_notes}
            </p>
          ) : null}
          <div className="mt-6">
            <ContinueOrdering />
          </div>
        </>
      ) : (
        <p className="text-muted mt-2 text-sm leading-relaxed">
          You already have a Campus Dash account, and this adds delivering to it: same login, same
          details, same order history. All we need is a live photo so an admin can compare your face
          with your student ID.
        </p>
      )}

      {showForm ? <ApplyForm profile={profile} /> : null}

      {!state ? (
        <p className="text-muted mt-8 text-center text-xs">
          Not now?{' '}
          <Link href="/order" className="text-brand-700 underline underline-offset-4">
            Back to ordering
          </Link>
        </p>
      ) : null}
    </main>
  );
}
