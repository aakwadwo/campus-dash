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
        public.webhook_events, public.idempotency_keys,
        public.notification_events
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
             reviewed_at = now(), reviewed_by = '00000000-0000-4000-8000-000000000001',
             student_id_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/student-id.jpg',
             face_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/face.jpg',
             review_notes = null, documents_purge_after = null
       where user_id in (
         '00000000-0000-4000-8000-000000000031',
         '00000000-0000-4000-8000-000000000032',
         '00000000-0000-4000-8000-000000000034'
       )
    `);
    await c.query(`
      update public.partner_profiles
         set status = 'PENDING_REVIEW', is_available = false,
             reviewed_at = null, reviewed_by = null, documents_purge_after = null,
             review_notes = null,
             student_id_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/student-id.jpg',
             face_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/face.jpg'
       where user_id in (
         '00000000-0000-4000-8000-000000000033',
         '00000000-0000-4000-8000-000000000035'
       )
    `);
    // Applications created by tests, and any profile for a non-seeded user.
    await c.query(`
      delete from public.partner_profiles
       where user_id not in (
         '00000000-0000-4000-8000-000000000031',
         '00000000-0000-4000-8000-000000000032',
         '00000000-0000-4000-8000-000000000033',
         '00000000-0000-4000-8000-000000000034',
         '00000000-0000-4000-8000-000000000035'
       )
    `);
    // Student ID numbers are unique across approved Partners; tests set them.
    await c.query(`
      update public.users u set student_id_number = v.sid
        from (values
          ('00000000-0000-4000-8000-000000000031','TEST-STU-0031'),
          ('00000000-0000-4000-8000-000000000032','TEST-STU-0032'),
          ('00000000-0000-4000-8000-000000000033','TEST-STU-0033'),
          ('00000000-0000-4000-8000-000000000034','TEST-STU-0034'),
          ('00000000-0000-4000-8000-000000000035','TEST-STU-0035')
        ) as v(id, sid)
       where u.id = v.id::uuid
    `);
    await c.query(`
      update public.users set student_id_number = null
       where id in (
         '00000000-0000-4000-8000-000000000021',
         '00000000-0000-4000-8000-000000000022',
         '00000000-0000-4000-8000-000000000023',
         '00000000-0000-4000-8000-000000000024'
       )
    `);
    await c.query(`
      update public.pricing_config
         set service_fee_pesewas = 200, delivery_fee_pesewas = 500,
             partner_share_of_delivery_bps = 10000,
             vendor_response_seconds = 60, partner_search_seconds = 600
       where id
    `);
    // Restore the seeded CATALOGUE, not just its flags. Admin tests rename,
    // disable, reprice and delete these rows; without a real restore, damage
    // from one test file silently breaks the next one. Learned the hard way:
    // a cleanup matching on name once deleted a seeded vendor a test had
    // renamed into its own match pattern.
    await c.query(`
      delete from public.vendors
       where id not in (
         '20000000-0000-4000-8000-000000000001',
         '20000000-0000-4000-8000-000000000002'
       )
    `);
    await c.query(`
      insert into public.vendors (id, name, phone, status, is_accepting_orders, location_id, walk_minutes_to_campus)
      values
        ('20000000-0000-4000-8000-000000000001', 'Test Kitchen One', '+233200000011', 'ACTIVE', true,
         '10000000-0000-4000-8000-000000000030', 4),
        ('20000000-0000-4000-8000-000000000002', 'Test Grill Two', '+233200000012', 'ACTIVE', true,
         '10000000-0000-4000-8000-000000000040', 6)
      on conflict (id) do update
         set name = excluded.name, phone = excluded.phone, status = excluded.status,
             is_accepting_orders = excluded.is_accepting_orders,
             location_id = excluded.location_id,
             walk_minutes_to_campus = excluded.walk_minutes_to_campus
    `);
    await c.query(`
      insert into public.vendor_users (vendor_id, user_id) values
        ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011'),
        ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012')
      on conflict do nothing
    `);
    await c.query(`
      delete from public.vendor_users
       where (vendor_id, user_id) not in (
         ('20000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000011'::uuid),
         ('20000000-0000-4000-8000-000000000002'::uuid, '00000000-0000-4000-8000-000000000012'::uuid)
       )
    `);
    await c.query(`
      insert into public.menu_items (id, vendor_id, name, description, price_pesewas, is_available, sort_order)
      values
        ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Jollof Rice with Chicken', 'Jollof rice, grilled chicken, shito', 3500, true, 1),
        ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Waakye Special', 'Waakye, egg, gari, stew', 3000, true, 2),
        ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Fried Rice with Beef', 'Fried rice and beef', 4000, true, 3),
        ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'Bottled Water', '500ml', 300, true, 4),
        ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', 'Kelewele', 'Spiced fried plantain', 1500, false, 5),
        ('30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000002', 'Chicken Shawarma', 'Chicken, salad, garlic sauce', 2500, true, 1),
        ('30000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002', 'Beef Burger', 'Beef patty, cheese, fries', 4500, true, 2),
        ('30000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000002', 'Meat Pie', 'Baked daily', 1000, true, 3),
        ('30000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000002', 'Soft Drink', 'Assorted 350ml', 800, true, 4)
      on conflict (id) do update
         set vendor_id = excluded.vendor_id, name = excluded.name,
             description = excluded.description, price_pesewas = excluded.price_pesewas,
             is_available = excluded.is_available, sort_order = excluded.sort_order
    `);
    await c.query(`
      delete from public.menu_items
       where vendor_id in ('20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002')
         and id not in (
           '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
           '30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000004',
           '30000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000011',
           '30000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000013',
           '30000000-0000-4000-8000-000000000014'
         )
    `);
    // Locations: drop anything a test created, then restore the seeded rows'
    // full state. is_deliverable in particular is toggled by admin tests, and
    // restoring only is_active leaves the next file ordering to a floor.
    await c.query(`
      delete from public.locations
       where id::text not like '10000000-0000-4000-8000-%'
    `);
    await c.query(`
      update public.locations l
         set name = v.name, is_deliverable = v.deliverable,
             walk_minutes = v.walk, is_active = true
        from (values
          ('10000000-0000-4000-8000-000000000001','Academic City',     false, 0),
          ('10000000-0000-4000-8000-000000000010','Hostel Block A',    false, 5),
          ('10000000-0000-4000-8000-000000000020','Hostel Block B',    false, 7),
          ('10000000-0000-4000-8000-000000000030','Academic Block',    false, 3),
          ('10000000-0000-4000-8000-000000000040','Sports Complex',    false, 9),
          ('10000000-0000-4000-8000-000000000011','Floor 1',           false, null),
          ('10000000-0000-4000-8000-000000000012','Floor 2',           false, null),
          ('10000000-0000-4000-8000-000000000021','Floor 1',           false, null),
          ('10000000-0000-4000-8000-000000000031','Ground Floor',      false, null),
          ('10000000-0000-4000-8000-000000000111','Room 101',          true,  null),
          ('10000000-0000-4000-8000-000000000112','Room 102',          true,  null),
          ('10000000-0000-4000-8000-000000000121','Room 204',          true,  null),
          ('10000000-0000-4000-8000-000000000122','Room 205',          true,  null),
          ('10000000-0000-4000-8000-000000000211','Room 110',          true,  null),
          ('10000000-0000-4000-8000-000000000311','Library Entrance',  true,  null),
          ('10000000-0000-4000-8000-000000000411','Main Field',        true,  null)
        ) as v(id, name, deliverable, walk)
       where l.id = v.id::uuid
    `);
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
          ('00000000-0000-4000-8000-000000000033','Kofi Test-Applicant'),
          ('00000000-0000-4000-8000-000000000034','Esi Test-Partner'),
          ('00000000-0000-4000-8000-000000000035','Kojo Test-Applicant'),
          ('00000000-0000-4000-8000-000000000024','Abena Test-Customer')
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
  partnerEsi: '00000000-0000-4000-8000-000000000034',
  applicantKojo: '00000000-0000-4000-8000-000000000035',
  customerAbena: '00000000-0000-4000-8000-000000000024',
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
