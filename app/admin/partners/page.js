import Link from 'next/link';
import { listPartnerApplications, partners as listPartners } from '@/lib/admin';
import { getPartnerDocumentUrl } from '@/lib/admin/documents';
import { Panel, Badge, Empty, Unavailable, Table, Row, Cell, Cedis, when } from '../ui';
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
  const [applications, roster] = await Promise.all([
    listPartnerApplications(),
    listPartners().catch(() => null),
  ]);

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

      {/* THE ROSTER, above the queue. The queue answers "who is waiting for me";
          this answers "who is actually out there delivering", which is the
          question an operator has on every day that is not a review day. */}
      <Panel title="All Partners" description={roster ? `${roster.length} accounts` : undefined}>
        {roster === null ? (
          <Unavailable>The Partner roster could not be loaded.</Unavailable>
        ) : roster.length === 0 ? (
          <Empty>Nobody has applied to be a Partner yet.</Empty>
        ) : (
          <Table
            head={[
              'Name',
              'Phone',
              'Class',
              'Status',
              'Available',
              'Deliveries',
              'Owed',
              'Applied',
            ]}
            minWidth="52rem"
          >
            {roster.map((p) => (
              <Row key={p.user_id}>
                <Cell>
                  <Link
                    href={`/admin/partners/${p.user_id}`}
                    className="text-brand-700 underline underline-offset-4"
                  >
                    {p.full_name ?? '-'}
                  </Link>
                </Cell>
                <Cell mono>{p.phone}</Cell>
                <Cell muted>{p.class_year ?? '-'}</Cell>
                <Cell>
                  <Badge tone={TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                  {p.is_suspended ? <Badge tone="bad">account suspended</Badge> : null}
                </Cell>
                <Cell>{p.is_available ? 'online' : 'offline'}</Cell>
                <Cell numeric>{p.deliveries}</Cell>
                <Cell numeric>
                  <Cedis pesewas={p.owed_pesewas} />
                </Cell>
                <Cell muted>{when(p.applied_at)}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Panel>

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
    <article className="border-line border-t pt-5 first:border-0 first:pt-0">
      <header className="mb-3 flex flex-wrap items-baseline gap-3">
        <h3 className="font-semibold">{application.full_name ?? 'Unnamed'}</h3>
        <Badge tone={TONE[application.status]}>{application.status}</Badge>
        <span className="text-muted text-sm tabular-nums">{application.phone}</span>
        {application.student_id_number ? (
          <span className="text-muted text-sm">ID {application.student_id_number}</span>
        ) : null}
        {/* Declared by the applicant, never verified — which is exactly why the
            reviewer needs to see them next to the photographs. */}
        {application.class_year ? (
          <span className="text-muted text-sm">{application.class_year}</span>
        ) : null}
        {application.email ? <span className="text-muted text-sm">{application.email}</span> : null}
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
          {application.review_notes ? `: ${application.review_notes}` : ''}
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
        <img src={url} alt={label} className="border-line max-h-64 rounded border object-contain" />
      ) : (
        <p className="text-muted border-line-strong rounded border border-dashed px-3 py-6 text-center text-xs">
          {path ? 'File missing from storage' : 'Not uploaded yet'}
        </p>
      )}
    </div>
  );
}
