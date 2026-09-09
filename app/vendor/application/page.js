import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { getMyApplication } from '@/lib/vendor';
import { Badge, ButtonLink, Callout, Card, Facts, Fact, PageHeader } from '@/app/ui';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your application · Campus Dash' };

/**
 * Where a store application stands.
 *
 * This is the whole vendor experience before approval, and deliberately so: a
 * PENDING store has no order board because it has no orders, and showing an
 * empty dashboard would read as a broken one. A REJECTED store gets the reason,
 * because a rejection you cannot read is a dead end rather than a decision.
 */
export default async function VendorApplicationPage() {
  await requireUser('/vendor/application');
  const application = await getMyApplication();

  if (!application) redirect('/vendor/signup');
  if (application.status === 'ACTIVE') redirect(`/vendor/${application.vendor_id}`);

  const rejected = application.status === 'REJECTED';
  const suspended = application.status === 'SUSPENDED';

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-8">
      <PageHeader
        eyebrow="Vendor"
        title={application.name}
        description={
          rejected
            ? 'This application was not approved. You can correct it and send it back.'
            : suspended
              ? 'This store has been suspended by Campus Dash.'
              : 'Your application is with an administrator.'
        }
      />

      <Card className="mt-6 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Status</span>
          <Badge tone={rejected || suspended ? 'bad' : 'warn'}>
            {rejected ? 'Not approved' : suspended ? 'Suspended' : 'Awaiting approval'}
          </Badge>
        </div>

        {rejected && application.rejection_reason ? (
          <Callout tone="bad" className="mt-4">
            {application.rejection_reason}
          </Callout>
        ) : null}

        {!rejected && !suspended ? (
          <Callout tone="brand" className="mt-4">
            We&apos;ll text you the moment a decision is made. Nothing else is needed from you right
            now.
          </Callout>
        ) : null}

        <Facts className="mt-5">
          <Fact label="Category" value={application.category_name ?? '—'} />
          <Fact label="Applicant" value={application.applicant_name ?? '—'} />
          <Fact
            label="Student"
            value={
              application.owner_is_student === null
                ? '—'
                : application.owner_is_student
                  ? 'Yes'
                  : 'No'
            }
          />
          <Fact label="What you sell" value={application.description ?? '—'} />
        </Facts>

        {rejected ? (
          <div className="mt-6">
            <ButtonLink href="/vendor/signup" size="lg" block>
              Correct and resubmit
            </ButtonLink>
          </div>
        ) : null}
      </Card>

      {suspended ? (
        <p className="text-muted mt-5 text-sm leading-relaxed">
          Contact Campus Dash support. A suspension is a decision an administrator has to reverse;
          there is nothing to resubmit.
        </p>
      ) : null}
    </main>
  );
}
