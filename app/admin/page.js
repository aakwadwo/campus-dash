import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { scheduledJobStatus } from '@/lib/admin';
import { Panel, Badge, Empty } from './ui';

export const dynamic = 'force-dynamic';

export default async function AdminOverview() {
  const supabase = await createClient();

  const [{ data: vendors }, { data: locations }, { data: partners }, jobs] = await Promise.all([
    supabase.from('vendors').select('id, name, status, is_accepting_orders'),
    supabase.from('locations').select('id, is_active, is_deliverable'),
    supabase.from('partner_profiles').select('user_id, status'),
    scheduledJobStatus().catch(() => []),
  ]);

  const pending = (partners ?? []).filter((p) => p.status === 'PENDING_REVIEW').length;
  const live = (vendors ?? []).filter((v) => v.status === 'ACTIVE' && v.is_accepting_orders).length;

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Overview</h1>

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <Stat label="Vendors" value={vendors?.length ?? 0} detail={`${live} open for orders`} />
        <Stat
          label="Locations"
          value={locations?.filter((l) => l.is_active).length ?? 0}
          detail={`${locations?.filter((l) => l.is_deliverable && l.is_active).length ?? 0} deliverable`}
        />
        <Stat
          label="Partner applications"
          value={pending}
          detail={pending ? 'waiting for review' : 'nothing waiting'}
          highlight={pending > 0}
        />
      </div>

      <Panel
        title="Scheduled jobs"
        description="A scheduler that silently stops looks like an application bug."
      >
        {jobs?.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Job</th>
                <th className="pb-2 font-medium">Schedule</th>
                <th className="pb-2 font-medium">Last run</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.jobname} className="border-t border-black/5">
                  <td className="py-2 font-mono text-xs">{job.jobname}</td>
                  <td className="py-2 tabular-nums">{job.schedule}</td>
                  <td className="text-muted py-2 tabular-nums">
                    {job.last_run ? new Date(job.last_run).toLocaleTimeString() : 'never'}
                  </td>
                  <td className="py-2">
                    <Badge
                      tone={
                        job.last_status === 'succeeded' ? 'good' : job.last_status ? 'bad' : 'warn'
                      }
                    >
                      {job.last_status ?? 'not yet run'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No scheduled jobs registered.</Empty>
        )}
      </Panel>

      <Panel title="What this module does not do yet">
        <ul className="text-muted list-inside list-disc space-y-1 text-sm">
          <li>The live order board and order overrides arrive with the vendor module.</li>
          <li>Partner document uploads arrive in Phase 8; approval here reads whatever exists.</li>
          <li>Settlement and payout screens arrive in Phase 11.</li>
        </ul>
      </Panel>
    </>
  );
}

function Stat({ label, value, detail, highlight }) {
  return (
    <div
      className={`rounded-lg bg-white px-5 py-4 ring-1 ${highlight ? 'ring-brand-500/40' : 'ring-black/5'}`}
    >
      <p className="text-muted text-xs font-medium tracking-wide uppercase">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p>
      <p className="text-muted mt-1 text-sm">{detail}</p>
    </div>
  );
}
