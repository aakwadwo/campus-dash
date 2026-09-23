import Link from 'next/link';
import { listPartnerApplications, partnerActivity } from '@/lib/admin';
import { getPartnerDocumentUrls } from '@/lib/admin/documents';
import {
  Panel,
  Badge,
  Empty,
  Unavailable,
  Table,
  Row,
  Cell,
  Cedis,
  Stat,
  StatGrid,
  when,
} from '../ui';
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
    // MEASURED, not inferred. Online time is summed from partner_sessions rows
    // clipped to the window — a session that began last night counts only
    // today's share of itself against today. Deriving it from page visits would
    // measure whether somebody looked at their phone.
    partnerActivity().catch(() => null),
  ]);

  const online = (roster ?? []).filter((p) => p.is_online).length;
  const onDelivery = (roster ?? []).filter((p) => Number(p.active_deliveries) > 0).length;
  const owed = (roster ?? []).reduce((sum, p) => sum + Number(p.owed_pesewas ?? 0), 0);

  // Signed URLs are minted per render and live for two minutes. The bucket is
  // private with no policies, so this is the only way an image is ever exposed.
  // All of them in one storage request.
  const urls = await getPartnerDocumentUrls(
    applications.flatMap((a) => [a.student_id_image_path, a.face_image_path])
  );
  const withDocuments = applications.map((application) => ({
    ...application,
    studentIdUrl: urls.get(application.student_id_image_path) ?? null,
    faceUrl: urls.get(application.face_image_path) ?? null,
  }));

  const pending = withDocuments.filter((a) => a.status === 'PENDING_REVIEW');
  const decided = withDocuments.filter((a) => a.status !== 'PENDING_REVIEW');

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Partner applications</h1>
      <p className="text-muted mb-6 text-sm">
        Approval is manual. Check the student ID against the name and level on the account. The
        applicant already holds a verified @acity.edu.gh address, so identity is established before
        this screen. Images live in a private bucket and are shown through short-lived signed URLs.
      </p>

      {/* SUPPLY, RIGHT NOW. The question an operator has on every day that is
          not a review day: is there anybody out there. */}
      {roster ? (
        <StatGrid>
          <Stat label="Online now" value={online} hint={`${roster.length} approved`} />
          <Stat label="On a delivery" value={onDelivery} />
          <Stat label="Owed to Partners" value={<Cedis pesewas={owed} />} hint="Unsettled" />
        </StatGrid>
      ) : null}

      {/* THE ROSTER, above the queue. The queue answers "who is waiting for
          me"; this answers "who is actually out there", which is the operational
          question. */}
      <Panel
        title="Partner activity"
        description={roster ? `${roster.length} accounts` : undefined}
      >
        {roster === null ? (
          <Unavailable>The Partner roster could not be loaded.</Unavailable>
        ) : roster.length === 0 ? (
          <Empty>Nobody has applied to be a Partner yet.</Empty>
        ) : (
          <Table
            head={[
              'Name',
              'Now',
              'Today',
              'This week',
              'Last online',
              'Last offline',
              'Deliveries',
              'Owed',
            ]}
            minWidth="58rem"
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
                  <span className="text-faint block font-mono text-xs">{p.phone}</span>
                  {p.status !== 'APPROVED' || p.is_suspended ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      <Badge tone={TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                      {p.is_suspended ? <Badge tone="bad">suspended</Badge> : null}
                    </span>
                  ) : null}
                </Cell>
                <Cell>
                  {p.is_online ? (
                    <>
                      <Badge tone="good">Online</Badge>
                      {/* HOW LONG THIS SESSION HAS BEEN OPEN, which is the
                          difference between somebody who just came on and
                          somebody who has been available all afternoon. */}
                      <span className="text-faint mt-1 block text-xs tabular-nums">
                        {duration(p.current_session_seconds)}
                      </span>
                    </>
                  ) : (
                    <Badge>Offline</Badge>
                  )}
                  {Number(p.active_deliveries) > 0 ? (
                    <span className="text-brand-800 mt-1 block text-xs font-semibold">
                      Carrying {p.active_deliveries}
                    </span>
                  ) : null}
                </Cell>
                <Cell numeric>{duration(p.online_seconds_today)}</Cell>
                <Cell numeric>{duration(p.online_seconds_this_week)}</Cell>
                <Cell muted>{when(p.last_online_at)}</Cell>
                <Cell muted>{when(p.last_offline_at)}</Cell>
                <Cell numeric>{p.deliveries_completed}</Cell>
                <Cell numeric>
                  <Cedis pesewas={p.owed_pesewas} />
                </Cell>
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
        {application.level ? (
          <span className="text-muted text-sm">Level {application.level}</span>
        ) : null}
        {application.email ? <span className="text-muted text-sm">{application.email}</span> : null}
      </header>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <Document
          label="Student ID"
          url={application.studentIdUrl}
          path={application.student_id_image_path}
        />
        {/* Only on applications made before Campus Dash stopped asking for one.
            Kept so a past decision can still be audited against what it was
            made on; new applications have nothing here. */}
        {application.face_image_path ? (
          <Document
            label="Face photograph (earlier application)"
            url={application.faceUrl}
            path={application.face_image_path}
          />
        ) : null}
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

/**
 * Seconds as something a person reads at a glance.
 *
 * "3h 12m", not "11520s" and not "3.2 hours". An operator scanning a column of
 * these is comparing them, so the unit has to be obvious without arithmetic.
 */
function duration(seconds) {
  const total = Number(seconds ?? 0);
  if (!Number.isFinite(total) || total <= 0) return '—';

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}
