import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { getMyApplication } from '@/lib/partner';
import ApplyForm from './apply-form';

export const dynamic = 'force-dynamic';

/**
 * Apply, or see where an existing application stands.
 *
 * This page used to render the blank form unconditionally, which is what an
 * applicant saw every time they came back — landingFor() sends PENDING_REVIEW
 * accounts here, so the screen that was meant to say "we have your application"
 * instead invited them to submit it again.
 */
const DECIDED = {
  PENDING_REVIEW: {
    title: 'Application submitted',
    body: "We'll review it and let you know when a decision is made. Reviewing is done by hand, so it is not instant.",
  },
  REJECTED: {
    title: 'Application not approved',
    body: 'You can apply again with a clearer student ID photograph and a new live photo.',
  },
  SUSPENDED: {
    title: 'Partner access suspended',
    body: 'Contact Campus Dash support. Applying again will not lift a suspension.',
  },
};

export default async function PartnerApplyPage() {
  await requireUser('/partner/apply');
  const application = await getMyApplication();
  const state = DECIDED[application?.status];

  // REJECTED reopens the form underneath the explanation; PENDING_REVIEW and
  // SUSPENDED do not, because re-applying is not the next step in either.
  const showForm = !application || application.status === 'REJECTED';

  return (
    <main className="mx-auto max-w-md px-4 pt-6 pb-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {state ? state.title : 'Apply to be a Partner'}
      </h1>

      {state ? (
        <>
          <p className="text-muted mt-2 text-sm leading-relaxed">{state.body}</p>
          {application.review_notes ? (
            <p className="mt-3 rounded-lg bg-white p-3 text-sm ring-1 ring-black/5">
              {application.review_notes}
            </p>
          ) : null}
          <ContinueAsCustomer />
        </>
      ) : (
        <p className="text-muted mt-2 text-sm leading-relaxed">
          An admin compares your face with your student ID by hand. That is why the selfie has to be
          taken here and now, with your camera.
        </p>
      )}

      {showForm ? <ApplyForm /> : null}
    </main>
  );
}

/**
 * A Partner is also a customer on the SAME account — capabilities are additive
 * in my_capabilities(), so there is no second identity to create and nothing to
 * switch. Waiting for a decision should not mean being unable to order lunch.
 */
export function ContinueAsCustomer() {
  return (
    <div className="mt-6 rounded-lg bg-white p-4 ring-1 ring-black/5">
      <p className="text-sm">
        You can keep ordering while you wait — the same account does both.
      </p>
      <Link href="/order" className="text-brand-700 mt-2 inline-block text-sm font-medium">
        Continue to ordering →
      </Link>
    </div>
  );
}
