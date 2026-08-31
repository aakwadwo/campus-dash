import pg from 'pg';

// Money is integer pesewas everywhere, including in results. node-postgres
// parses int8 as a string by default, which would silently turn every amount
// into text and make arithmetic in assertions wrong.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const HOST = process.env.TEST_PGHOST || '127.0.0.1';
const PORT = Number(process.env.TEST_PGPORT || 54322);
const DATABASE = 'postgres';

/**
 * Two identities, and the difference matters.
 *
 * `postgres` is the superuser: migrations, scheduled jobs, and anything the
 * service-role key would do. RLS does not apply to it.
 *
 * `authenticator` is the role PostgREST itself logs in as before switching to
 * `authenticated` or `anon` for a request. Running client-facing tests through
 * it means they hit exactly the grants and policies a real browser request
 * would — including session_user, which SET ROLE does not change and which
 * is_service_or_admin() relies on.
 */
const servicePool = new pg.Pool({
  host: HOST,
  port: PORT,
  database: DATABASE,
  user: 'postgres',
  password: 'postgres',
  max: 6,
});

const clientPool = new pg.Pool({
  host: HOST,
  port: PORT,
  database: DATABASE,
  user: 'authenticator',
  password: 'postgres',
  max: 10,
});

export async function closePools() {
  await Promise.all([servicePool.end(), clientPool.end()]);
}

/** Runs as the database superuser. Bypasses RLS. */
export async function asService(fn) {
  const client = await servicePool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function claimsFor(userId, role = 'authenticated') {
  return JSON.stringify(userId ? { sub: userId, role } : { role });
}

/**
 * Runs inside a transaction as a signed-in user, exactly as PostgREST would set
 * things up. Always rolls back, so tests do not leak state into one another.
 */
export async function asUser(userId, fn, { role = 'authenticated', commit = false } = {}) {
  const client = await clientPool.connect();
  try {
    await client.query('begin');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      claimsFor(userId, role),
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query(commit ? 'commit' : 'rollback');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function asAnon(fn) {
  return asUser(null, fn, { role: 'anon' });
}

/**
 * A connection pinned to one user OUTSIDE any transaction, so each statement
 * autocommits. Required for the concurrency tests: two Partners racing must
 * actually commit against each other, not block on one another's open
 * transaction.
 */
export async function dedicatedClient(userId, role = 'authenticated') {
  const client = new pg.Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user: 'authenticator',
    password: 'postgres',
  });
  await client.connect();
  await client.query('select set_config($1, $2, false)', [
    'request.jwt.claims',
    claimsFor(userId, role),
  ]);
  await client.query(`set role ${role}`);
  return client;
}

/**
 * Clears transactional state between tests while leaving the seeded catalogue
 * (users, vendors, menus, locations) intact.
 */
export async function resetTransactionalState() {
  await asService(async (c) => {
    await c.query(`
      truncate table
        public.order_events, public.order_secrets, public.order_items,
        public.allocations, public.payouts, public.settlement_runs,
        public.payments, public.orders,
        public.webhook_events, public.idempotency_keys
      restart identity cascade
    `);
    // admin_actions is append-only: its trigger blocks DELETE, but TRUNCATE is
    // a different operation and is how we keep test runs independent.
    await c.query('truncate table public.admin_actions restart identity cascade');
    // Restore the seeded Partner states. Tests suspend and approve Partners, and
    // without this those changes leak into later tests as order-dependent flakes.
    await c.query(`
      update public.partner_profiles
         set status = 'APPROVED', is_available = true,
             reviewed_at = now(), reviewed_by = '00000000-0000-4000-8000-000000000001'
       where user_id in (
         '00000000-0000-4000-8000-000000000031',
         '00000000-0000-4000-8000-000000000032'
       )
    `);
    await c.query(`
      update public.partner_profiles
         set status = 'PENDING_REVIEW', is_available = false,
             reviewed_at = null, reviewed_by = null, documents_purge_after = null
       where user_id = '00000000-0000-4000-8000-000000000033'
    `);
    await c.query(`
      update public.pricing_config
         set service_fee_pesewas = 200, delivery_fee_pesewas = 500,
             partner_share_of_delivery_bps = 10000,
             vendor_response_seconds = 60, partner_search_seconds = 600
       where id
    `);
    await c.query(`
      update public.menu_items set price_pesewas = 3500
       where id = '30000000-0000-4000-8000-000000000001'
    `);
    await c.query(`update public.vendors set status = 'ACTIVE', is_accepting_orders = true`);
    await c.query(`update public.users set is_suspended = false`);
    // Restore seeded display names: tests rename accounts and commit.
    await c.query(`
      update public.users u set full_name = v.name
        from (values
          ('00000000-0000-4000-8000-000000000001','Dev Admin'),
          ('00000000-0000-4000-8000-000000000011','Muni Owner (test)'),
          ('00000000-0000-4000-8000-000000000012','Grill Owner (test)'),
          ('00000000-0000-4000-8000-000000000021','Ama Test-Customer'),
          ('00000000-0000-4000-8000-000000000022','Kwesi Test-Customer'),
          ('00000000-0000-4000-8000-000000000023','Efua Test-Customer'),
          ('00000000-0000-4000-8000-000000000031','Yaw Test-Partner'),
          ('00000000-0000-4000-8000-000000000032','Adjoa Test-Partner'),
          ('00000000-0000-4000-8000-000000000033','Kofi Test-Applicant')
        ) as v(id, name)
       where u.id = v.id::uuid
    `);
    // Remove accounts created by the auth provisioning tests.
    await c.query(`delete from auth.users where phone like '23320999%'`);
  });
}

/** Seeded actors. See supabase/seed.sql — all fictional development data. */
export const ACTORS = {
  admin: '00000000-0000-4000-8000-000000000001',
  vendor1Staff: '00000000-0000-4000-8000-000000000011',
  vendor2Staff: '00000000-0000-4000-8000-000000000012',
  customerAma: '00000000-0000-4000-8000-000000000021',
  customerKwesi: '00000000-0000-4000-8000-000000000022',
  customerEfua: '00000000-0000-4000-8000-000000000023',
  partnerYaw: '00000000-0000-4000-8000-000000000031',
  partnerAdjoa: '00000000-0000-4000-8000-000000000032',
  applicantKofi: '00000000-0000-4000-8000-000000000033',
};

export const VENDORS = {
  one: '20000000-0000-4000-8000-000000000001',
  two: '20000000-0000-4000-8000-000000000002',
};

export const MENU = {
  jollof: '30000000-0000-4000-8000-000000000001', // 3500
  waakye: '30000000-0000-4000-8000-000000000002', // 3000
  water: '30000000-0000-4000-8000-000000000004', // 300
  kelewele: '30000000-0000-4000-8000-000000000005', // unavailable
  shawarma: '30000000-0000-4000-8000-000000000011', // vendor two
};

export const LOCATIONS = {
  room204: '10000000-0000-4000-8000-000000000121',
  room101: '10000000-0000-4000-8000-000000000111',
  blockA: '10000000-0000-4000-8000-000000000010',
  floor2: '10000000-0000-4000-8000-000000000012', // not deliverable
};
