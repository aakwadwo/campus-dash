import { createClient } from '@/lib/supabase/server';
import { Panel, Badge, Empty } from '../ui';
import LocationForms from './location-forms';

export const dynamic = 'force-dynamic';

/** Flattens the tree depth-first so the table reads like the campus does. */
function buildTree(rows) {
  const byParent = new Map();
  rows.forEach((row) => {
    const key = row.parent_id ?? 'root';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  });

  const out = [];
  const walk = (parentKey, depth) => {
    const children = byParent.get(parentKey) ?? [];
    children
      .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
      .forEach((node) => {
        out.push({ ...node, depth });
        walk(node.id, depth + 1);
      });
  };
  walk('root', 0);
  return out;
}

export default async function LocationsPage() {
  const supabase = await createClient();
  const { data: rows } = await supabase.from('locations').select('*');
  const tree = buildTree(rows ?? []);

  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Campus locations</h1>
      <p className="text-muted mb-6 text-sm">
        No maps and no GPS. This tree is the entire location model: a customer picks a destination
        from it, and a Partner sees the block-level zone before accepting.
      </p>

      <Panel
        title="The tree"
        description="Only rows marked deliverable can be chosen as a destination."
      >
        {tree.length ? (
          <table className="w-full text-sm">
            <thead className="text-muted text-left text-xs uppercase">
              <tr>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Kind</th>
                <th className="pb-2 font-medium">Deliverable</th>
                <th className="pb-2 font-medium">Walk</th>
                <th className="pb-2 font-medium">Active</th>
              </tr>
            </thead>
            <tbody>
              {tree.map((node) => (
                <tr key={node.id} className="border-t border-black/5">
                  <td className="py-2" style={{ paddingLeft: `${node.depth * 1.25}rem` }}>
                    {node.depth > 0 ? <span className="text-muted">└ </span> : null}
                    {node.name}
                  </td>
                  <td className="text-muted py-2 text-xs">{node.kind}</td>
                  <td className="py-2">
                    {node.is_deliverable ? <Badge tone="good">yes</Badge> : <Badge>no</Badge>}
                  </td>
                  <td className="text-muted py-2 tabular-nums">
                    {node.walk_minutes == null ? '—' : `${node.walk_minutes} min`}
                  </td>
                  <td className="py-2">
                    {node.is_active ? (
                      <Badge tone="good">active</Badge>
                    ) : (
                      <Badge tone="bad">inactive</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No locations yet. Start with a CAMPUS.</Empty>
        )}
      </Panel>

      <LocationForms locations={tree} />
    </>
  );
}
