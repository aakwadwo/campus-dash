#!/usr/bin/env node
/**
 * Clears every non-administrator account out of a Campus Dash project, with
 * everything that belongs to it, for a clean testing reset.
 *
 *   node --env-file-if-exists=.env.local scripts/purge-test-accounts.mjs --keep admin@example.com
 *   node --env-file-if-exists=.env.local scripts/purge-test-accounts.mjs --keep admin@example.com --execute
 *
 * DRY RUN BY DEFAULT. Without --execute nothing is written: the connection is
 * read-only and the script prints what would go.
 *
 * WITH --execute:
 *   1. One transaction, as the database owner acting AS the kept administrator,
 *      calls admin_purge_test_accounts(). That function reuses the audited
 *      admin_purge_test_history() for the append-only rows and is audited under
 *      the administrator's id. No trigger is disabled and no guard is bypassed.
 *   2. Still inside that transaction, every table the reset is responsible for
 *      is counted. Anything left over rolls the whole thing back.
 *   3. Only after COMMIT are the storage objects removed, through the Storage
 *      API. storage.objects refuses a SQL DELETE, and removing a file for an
 *      account that then survived would be worse than a file left to retry.
 */
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const keepIndex = args.indexOf('--keep');
const KEEP = keepIndex >= 0 ? (args[keepIndex + 1] ?? '').trim().toLowerCase() : '';
const DB_URL = process.env.SUPABASE_DB_URL;
const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REASON =
  'Clean testing reset: removing all pilot test accounts, stores, orders and money records';

const BUCKETS = ['vendor-images', 'partner-documents', 'scan-documents'];

// Must be zero afterwards. customer_profiles/partner_profiles/vendors are the
// capabilities; everything else is operational data.
const MUST_BE_EMPTY = [
  'customer_profiles',
  'partner_profiles',
  'vendors',
  'menu_items',
  'vendor_images',
  'vendor_order_counters',
  'orders',
  'order_items',
  'order_secrets',
  'order_scans',
  'order_events',
  'payments',
  'allocations',
  'payouts',
  'payout_destinations',
  'webhook_events',
  'idempotency_keys',
  'customer_rewards',
  'partner_ratings',
  'terms_acceptances',
];

if (!DB_URL || !KEEP) {
  console.error('Usage: --keep <administrator email> [--execute]; SUPABASE_DB_URL must be set.');
  process.exit(1);
}
if (EXECUTE && (!URL || !SERVICE_KEY)) {
  console.error('--execute also needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

async function tableCounts() {
  const sql = MUST_BE_EMPTY.map(
    (t) => `select '${t}' as t, count(*)::int as n from public.${t}`
  ).join(' union all ');
  return Object.fromEntries((await q(sql)).map((r) => [r.t, r.n]));
}

try {
  if (!EXECUTE) await db.query('set session characteristics as transaction read only');

  const host = new globalThis.URL(URL || 'http://unknown').host;
  console.log(`Target: ${host}  (${EXECUTE ? 'EXECUTE' : 'DRY RUN, read-only'})\n`);

  const keep = await q(
    `select u.id, u.email, pu.is_admin, pu.is_suspended
       from auth.users u join public.users pu on pu.id = u.id
      where lower(u.email) = $1`,
    [KEEP]
  );
  if (keep.length !== 1 || !keep[0].is_admin || keep[0].is_suspended) {
    throw new Error(`${KEEP} is not exactly one active administrator; refusing.`);
  }
  const admin = keep[0];

  const targets = await q(
    `select u.id, coalesce(u.email, u.phone) as login,
            exists(select 1 from public.customer_profiles c where c.user_id = u.id) as customer,
            exists(select 1 from public.partner_profiles p where p.user_id = u.id) as partner,
            exists(select 1 from public.vendors v where v.owner_user_id = u.id) as vendor
       from auth.users u left join public.users pu on pu.id = u.id
      where u.id <> $1 and coalesce(pu.is_admin, false) = false
      order by u.created_at`,
    [admin.id]
  );
  const otherAdmins = await q(`select id from public.users where is_admin and id <> $1`, [
    admin.id,
  ]);
  const ids = targets.map((t) => t.id);

  console.log(`Kept administrator: ${admin.email} (${admin.id})`);
  if (otherAdmins.length)
    console.log(`Other administrators, also kept: ${otherAdmins.map((a) => a.id).join(', ')}`);
  console.log(`\nAuth users to delete (${targets.length}):`);
  for (const t of targets) {
    const caps = ['customer', 'partner', 'vendor'].filter((c) => t[c]).join('+') || 'no capability';
    console.log(`  ${t.id}  ${t.login}  [${caps}]`);
  }
  if (ids.includes(admin.id)) throw new Error('the administrator is in the target list; refusing.');

  // The purge is scoped to accounts, so a store nobody owns cannot be reached
  // by it. Say so before doing anything rather than leave it behind.
  const ownerless = await q(`select id, name from public.vendors where owner_user_id is null`);
  if (ownerless.length) {
    console.log(
      `\nStores with no owner, which an account purge cannot remove (${ownerless.length}):`
    );
    for (const v of ownerless) console.log(`  ${v.id}  ${v.name}`);
    if (EXECUTE)
      throw new Error('ownerless stores exist; refusing to run a reset that cannot finish.');
  }

  const vendorIds = (
    await q(`select id from public.vendors where owner_user_id = any($1)`, [ids])
  ).map((r) => r.id);
  const prefixes = [...ids, ...vendorIds];
  const objects = await q(
    `select bucket_id, name from storage.objects
      where bucket_id = any($1) and split_part(name, '/', 1) = any($2::text[])
      order by 1, 2`,
    [BUCKETS, prefixes]
  );
  const unrelated = await q(
    `select bucket_id, name from storage.objects
      where not (bucket_id = any($1) and split_part(name, '/', 1) = any($2::text[]))`,
    [BUCKETS, prefixes]
  );

  const before = await tableCounts();
  console.log('\nRows now (the reset must leave each of these at 0):');
  for (const [t, n] of Object.entries(before)) console.log(`  ${t.padEnd(22)} ${n}`);
  console.log(`\nStorage objects owned by these accounts/stores (${objects.length}):`);
  for (const o of objects) console.log(`  ${o.bucket_id}/${o.name}`);
  console.log(`Storage objects NOT attributable to them, left alone (${unrelated.length}):`);
  for (const o of unrelated) console.log(`  ${o.bucket_id}/${o.name}`);

  if (!EXECUTE) {
    console.log('\nDry run only. Nothing was changed.');
    process.exit(0);
  }
  if (ids.length === 0) {
    console.log('\nNo test accounts to purge.');
    process.exit(0);
  }

  // ---- 1 & 2: the database, atomically -------------------------------------
  await db.query('begin');
  let result;
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: admin.id, role: 'authenticated' }),
    ]);
    [{ r: result }] = await q(`select public.admin_purge_test_accounts($1::uuid[], $2) as r`, [
      ids,
      REASON,
    ]);

    const after = await tableCounts();
    const [{ leftover }] = await q(
      `select count(*)::int as leftover from auth.users u left join public.users pu on pu.id = u.id
        where coalesce(pu.is_admin, false) = false`
    );
    const nonZero = Object.entries(after).filter(([, n]) => n !== 0);
    if (nonZero.length || leftover !== 0) {
      throw new Error(
        `rows remain after purge: ${JSON.stringify({ ...Object.fromEntries(nonZero), auth_users: leftover })}`
      );
    }
    await db.query('commit');
  } catch (error) {
    await db.query('rollback');
    throw new Error(`database purge rolled back, nothing changed: ${error.message}`);
  }
  console.log('\nDatabase purge committed. Counts removed by the function:');
  console.log(JSON.stringify(result.counts, null, 2));

  // ---- 3: storage, after commit ---------------------------------------------
  const paths = new Map(BUCKETS.map((b) => [b, new Set(result.storage_paths[b] ?? [])]));
  for (const o of objects) paths.get(o.bucket_id).add(o.name);

  const supabase = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });
  let failed = false;
  for (const [bucket, set] of paths) {
    const list = [...set];
    if (!list.length) continue;
    const { data, error } = await supabase.storage.from(bucket).remove(list);
    if (error) {
      failed = true;
      console.error(`  ${bucket}: FAILED ${error.message} — retry with the same command`);
    } else {
      console.log(
        `  ${bucket}: removed ${data.length} of ${list.length} named (${list.join(', ')})`
      );
    }
  }
  const [{ n: remaining }] = await q(
    `select count(*)::int as n from storage.objects where bucket_id = any($1) and split_part(name, '/', 1) = any($2::text[])`,
    [BUCKETS, prefixes]
  );
  console.log(`Storage objects still under the purged accounts/stores: ${remaining}`);
  if (failed || remaining) process.exitCode = 2;
} finally {
  await db.end();
}
