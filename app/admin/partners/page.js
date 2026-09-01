import { listPartnerApplications } from '@/lib/admin';
import { getPartnerDocumentUrl } from '@/lib/admin/documents';
import { Panel, Badge, Empty } from '../ui';
import PartnerReviewForm from './partner-review-form';

export const dynamic = 'force-dynamic';

const TONE = {
  PENDING_REVIEW: 'warn',
  APPROVED: 'good',
  REJECTED: 'bad',
  SUSPENDED: 'bad',
  NOT_APPLIED: 'neutral',
};

export default async function PartnersPage() {
  const applications = await listPartnerApplications();

  // Signed URLs are minted per render and live for two minutes. The bucket is
  // private with no policies, so this is the only way an image is ever exposed.
  const withDocuments = await Promise.all(
    applications.map(async (application) => ({
      ...application,
      studentIdUrl: await getPartnerDocumentUrl(application.student_id_image_path),
      faceUrl: await getPartnerDocumentUrl(application.face_image_path),
    }))
  );

  const pending = withDocuments.filter((a) => a.status === 'PENDING_REVIEW');
  const decided = withDocuments.filter((a) => a.status !== 'PENDING_REVIEW');

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Partner applications</h1>
      <p className="text-muted mb-6 text-sm">
        Approval is manual: compare the live face photograph against the student ID. Images are held
        in a private bucket and shown here through short-lived signed URLs.
      </p>

      <Panel title={`Waiting for review (${pending.length})`}>
        {pending.length ? (
          <div className="space-y-8">
            {pending.map((application) => (
              <Application key={application.user_id} application={application} />
            ))}
          </div>
        ) : (
          <Empty>Nothing waiting.</Empty>
        )}
      </Panel>

      <Panel title="Already decided">
        {decided.length ? (
          <div className="space-y-8">
            {decided.map((application) => (
              <Application key={application.user_id} application={application} />
            ))}
          </div>
        ) : (
          <Empty>No decisions yet.</Empty>
        )}
      </Panel>
    </>
  );
}

function Application({ application }) {
  return (
    <article className="border-t border-black/5 pt-5 first:border-0 first:pt-0">
      <header className="mb-3 flex flex-wrap items-baseline gap-3">
        <h3 className="font-semibold">{application.full_name ?? 'Unnamed'}</h3>
        <Badge tone={TONE[application.status]}>{application.status}</Badge>
        <span className="text-muted text-sm tabular-nums">{application.phone}</span>
        {application.student_id_number ? (
          <span className="text-muted text-sm">ID {application.student_id_number}</span>
        ) : null}
      </header>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Document
          label="Student ID"
          url={application.studentIdUrl}
          path={application.student_id_image_path}
        />
        <Document
          label="Live face photograph"
          url={application.faceUrl}
          path={application.face_image_path}
        />
      </div>

      {application.reviewed_at ? (
        <p className="text-muted mb-3 text-xs">
          Reviewed {new Date(application.reviewed_at).toLocaleString()}
          {application.reviewed_by_name ? ` by ${application.reviewed_by_name}` : ''}
          {application.review_notes ? ` — ${application.review_notes}` : ''}
        </p>
      ) : null}

      <PartnerReviewForm userId={application.user_id} current={application.status} />
    </article>
  );
}

function Document({ label, url, path }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium tracking-wide uppercase">{label}</p>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="max-h-64 rounded border border-black/10 object-contain"
        />
      ) : (
        <p className="text-muted rounded border border-dashed border-black/15 px-3 py-6 text-center text-xs">
          {path ? 'File missing from storage' : 'Not uploaded yet'}
        </p>
      )}
    </div>
  );
}
