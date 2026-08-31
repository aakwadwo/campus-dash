import { listAdminActions } from '@/lib/admin';
import { Panel, Empty } from '../ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const actions = await listAdminActions(200);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="text-muted mb-6 text-sm">
        Append-only. Not even a superuser can rewrite or delete a row here — a trigger blocks UPDATE
        and DELETE regardless of privilege.
      </p>

      <Panel title={`Most recent ${actions.length} actions`}>
        {actions.length ? (
          <ul className="divide-y divide-black/5 text-sm">
            {actions.map((action) => (
              <li key={action.id} className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-xs font-semibold">{action.action}</span>
                  <span className="text-muted text-xs">
                    {action.target_type}
                    {action.target_id ? ` · ${action.target_id.slice(0, 8)}` : ''}
                  </span>
                  <span className="text-muted ml-auto text-xs tabular-nums">
                    {new Date(action.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="mt-1">{action.reason}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No administrative actions recorded yet.</Empty>
        )}
      </Panel>
    </>
  );
}
