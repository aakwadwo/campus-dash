import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getMyApplication } from '@/lib/partner';
import ApplyForm, { ContinueOrdering } from './apply-form';
import BackButton from '@/app/back-button';

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
    title: 'Application received',
    body: 'Someone at Campus Dash will read it and let you know. It is reviewed by hand, so it is not instant.',
  },
  REJECTED: {
    title: 'Application not approved',
    body: 'You can apply again with a clearer photo of your student ID. Your student details stay on your account.',
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
  if (!me.can_order) redirect('/signup?next=%2Fpartner%2Fapply');

  const application = await getMyApplication();
  const state = DECIDED[application?.status];

  // REJECTED reopens the form underneath the explanation; PENDING_REVIEW and
  // SUSPENDED do not, because re-applying is not the next step in either.
  const showForm = !application || application.status === 'REJECTED';

  return (
    <main className="mx-auto max-w-2xl px-4 pt-4 pb-16">
      <BackButton fallback="/account" className="mb-3" />
      <h1 className="text-2xl font-semibold tracking-tight">
        {state ? state.title : 'Become a Partner'}
      </h1>

      {state ? (
        <>
          <p className="text-muted mt-2 text-sm leading-relaxed">{state.body}</p>
          {application.review_notes ? (
            <p className="rounded-card bg-surface border-line mt-3 border p-3 text-sm">
              {application.review_notes}
            </p>
          ) : null}
          <div className="mt-6">
            <ContinueOrdering />
          </div>
        </>
      ) : (
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Bring orders across campus and earn on each one. It is added to the account you already
          have, so all we need is a photo of your ID.
        </p>
      )}

      {showForm ? <ApplyForm /> : null}
    </main>
  );
}
