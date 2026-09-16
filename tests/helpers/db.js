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
        public.payout_destinations,
        public.payments, public.orders, public.partner_ratings,
        -- The daily queue counters. Without this a test asserting "the first
        -- order today is 001" reads whatever the previous file left behind.
        public.vendor_order_counters,
        public.customer_rewards,
        public.webhook_events, public.idempotency_keys,
        public.notification_events
      restart identity cascade
    `);
    // admin_actions is append-only: its trigger blocks DELETE, but TRUNCATE is
    // a different operation and is how we keep test runs independent.
    await c.query('truncate table public.admin_actions restart identity cascade');
    // ONLINE HISTORY GOES WITH THE PARTNER STATE. Availability is a recorded
    // session now, so leaving old rows behind would have one file's minutes
    // counted in another's totals. Truncating first means the profile updates
    // below re-open exactly one session per approved Partner, through the
    // trigger that owns that invariant.
    await c.query('truncate table public.partner_sessions restart identity cascade');
    // Restore the seeded Partner states. Tests suspend and approve Partners, and
    // without this those changes leak into later tests as order-dependent flakes.
    // BOTH verification documents live here now — the student ID photograph
    // moved back to the Partner application, which is the only review that
    // looks at one.
    // Off first, so the flag genuinely transitions and the trigger opens a
    // fresh session rather than seeing no change and doing nothing.
    await c.query('update public.partner_profiles set is_available = false');
    await c.query(`
      update public.partner_profiles
         set status = 'APPROVED', is_available = true,
             reviewed_at = now(), reviewed_by = '00000000-0000-4000-8000-000000000001',
             face_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/face.jpg',
             student_id_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/student-id.jpg',
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
             face_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/face.jpg',
             student_id_image_path = 'partner-docs/dev/' || right(user_id::text, 4) || '/student-id.jpg'
       where user_id in (
         '00000000-0000-4000-8000-000000000033',
         '00000000-0000-4000-8000-000000000035'
       )
    `);
    // Applications created by tests, and any profile for a non-seeded user.
    // MUST run before the customer_profiles cleanup below: PARTNER ⇒ CUSTOMER is
    // a foreign key with ON DELETE RESTRICT, so the Partner row goes first.
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
    // Customer capabilities granted by tests (onboarding, multi-capability
    // fixtures) are removed, and the seeded ones restored to their declared
    // facts. Student ID numbers are unique across customer_profiles, so a
    // leftover row from one file breaks onboarding in the next.
    await c.query(`
      delete from public.customer_profiles
       where user_id not in (
         '00000000-0000-4000-8000-000000000021',
         '00000000-0000-4000-8000-000000000022',
         '00000000-0000-4000-8000-000000000023',
         '00000000-0000-4000-8000-000000000024',
         '00000000-0000-4000-8000-000000000031',
         '00000000-0000-4000-8000-000000000032',
         '00000000-0000-4000-8000-000000000033',
         '00000000-0000-4000-8000-000000000034',
         '00000000-0000-4000-8000-000000000035'
       )
    `);
    await c.query(`
      insert into public.customer_profiles (user_id, student_id_number, level)
      values
        ('00000000-0000-4000-8000-000000000021','TEST-STU-0021','200'),
        ('00000000-0000-4000-8000-000000000022','TEST-STU-0022','200'),
        ('00000000-0000-4000-8000-000000000023','TEST-STU-0023','100'),
        ('00000000-0000-4000-8000-000000000024','TEST-STU-0024','100'),
        ('00000000-0000-4000-8000-000000000031','TEST-STU-0031','300'),
        ('00000000-0000-4000-8000-000000000032','TEST-STU-0032','300'),
        ('00000000-0000-4000-8000-000000000033','TEST-STU-0033','200'),
        ('00000000-0000-4000-8000-000000000034','TEST-STU-0034','400'),
        ('00000000-0000-4000-8000-000000000035','TEST-STU-0035','100')
      on conflict (user_id) do update
         set student_id_number = excluded.student_id_number,
             level             = excluded.level
    `);
    await c.query(`
      update public.pricing_config
         set service_fee_bps = 695, delivery_fee_pesewas = 500,
             partner_share_of_delivery_bps = 10000,
             vendor_response_seconds = 60, partner_search_seconds = 600,
             customer_absent_wait_seconds = 300,
             payment_pending_timeout_seconds = 900,
             scan_service_fee_pesewas = 200,
             -- Operational limits a test may have changed and committed. Both
             -- are read on every attempt they govern, so a value left behind by
             -- one file changes what the next file's Partners and handoffs are
             -- allowed to do.
             max_active_deliveries_per_partner = 2,
             -- The Partner weekly payout policy. A test that lowers it to
             -- exercise payout mechanics must not lower it for the next file.
             partner_min_payout_pesewas = 2000,
             code_attempt_limit = 5,
             code_lockout_seconds = 300
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
         '20000000-0000-4000-8000-000000000002',
         '20000000-0000-4000-8000-000000000003',
         '20000000-0000-4000-8000-000000000004',
         '20000000-0000-4000-8000-000000000005',
         '20000000-0000-4000-8000-000000000006'
       )
    `);
    // can_accept_scans is restored here too. Scan tests flip it to prove a
    // non-scan store is refused, and without a restore that flag leaks into the
    // next file exactly as a renamed vendor once did.
    // Ownership is restored with the row. It is the vendor capability, so a
    // test that reassigns or clears it would otherwise silently un-vendor an
    // account for every file that runs afterwards. Vendors 3 and 4 ARE owned:
    // a store that honours a meal scan is the redemption point, and it cannot
    // check a scan or read out a handoff code without a board to do it from.
    await c.query(`
      insert into public.vendors (id, name, phone, status, is_accepting_orders, can_accept_scans,
                                  owner_user_id, category_id, description, applicant_name,
                                  owner_is_student, submitted_at, reviewed_at, rejection_reason,
                                  location_id, walk_minutes_to_campus)
      values
        ('20000000-0000-4000-8000-000000000001', 'Test Kitchen One', '+233200000011', 'ACTIVE', true, false,
         '00000000-0000-4000-8000-000000000011', '40000000-0000-4000-8000-000000000001',
         'Hot Ghanaian staples cooked to order.', 'Muni Owner (test)', false, now(), now(), null,
         '10000000-0000-4000-8000-000000000030', 4),
        ('20000000-0000-4000-8000-000000000002', 'Test Grill Two', '+233200000012', 'ACTIVE', true, false,
         '00000000-0000-4000-8000-000000000012', '40000000-0000-4000-8000-000000000002',
         'Shawarma, burgers and pies from the grill.', 'Grill Owner (test)', true, now(), now(), null,
         '10000000-0000-4000-8000-000000000040', 6),
        ('20000000-0000-4000-8000-000000000003', 'Wafflemania (test)', '+233200000053', 'ACTIVE', true, true,
         '00000000-0000-4000-8000-000000000015', '40000000-0000-4000-8000-000000000004',
         null, null, null, null, null, null,
         '10000000-0000-4000-8000-000000000030', 3),
        ('20000000-0000-4000-8000-000000000004', 'Yellow Bar (test)', '+233200000054', 'ACTIVE', true, true,
         '00000000-0000-4000-8000-000000000016', '40000000-0000-4000-8000-000000000001',
         null, null, null, null, null, null,
         '10000000-0000-4000-8000-000000000040', 5),
        ('20000000-0000-4000-8000-000000000005', 'Pending Provisions (test)', '+233200000013', 'PENDING_APPROVAL', false, false,
         '00000000-0000-4000-8000-000000000013', '40000000-0000-4000-8000-000000000005',
         'Dry goods, toiletries and phone credit.', 'Pending Owner (test)', true, now(), null, null,
         null, null),
        ('20000000-0000-4000-8000-000000000006', 'Rejected Snacks (test)', '+233200000014', 'REJECTED', false, false,
         '00000000-0000-4000-8000-000000000014', '40000000-0000-4000-8000-000000000002',
         'Chips and sweets.', 'Rejected Owner (test)', true, now(), now(),
         'The store name and the description do not match. Resubmit with the real trading name.',
         null, null)
      on conflict (id) do update
         set name = excluded.name, phone = excluded.phone, status = excluded.status,
             is_accepting_orders = excluded.is_accepting_orders,
             can_accept_scans = excluded.can_accept_scans,
             owner_user_id = excluded.owner_user_id,
             category_id = excluded.category_id,
             description = excluded.description,
             applicant_name = excluded.applicant_name,
             owner_is_student = excluded.owner_is_student,
             submitted_at = excluded.submitted_at,
             reviewed_at = excluded.reviewed_at,
             rejection_reason = excluded.rejection_reason,
             location_id = excluded.location_id,
             walk_minutes_to_campus = excluded.walk_minutes_to_campus
    `);
    await c.query(`delete from public.vendor_images`);
    await c.query(`
      insert into public.menu_items (id, vendor_id, name, description, price_pesewas, is_available, sort_order, scan_eligible)
      values
        ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Jollof Rice with Chicken', 'Jollof rice, grilled chicken, shito', 3500, true, 1, false),
        ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Waakye Special', 'Waakye, egg, gari, stew', 3000, true, 2, false),
        ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Fried Rice with Beef', 'Fried rice and beef', 4000, true, 3, false),
        ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'Bottled Water', '500ml', 300, true, 4, false),
        ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', 'Kelewele', 'Spiced fried plantain', 1500, false, 5, false),
        ('30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000002', 'Chicken Shawarma', 'Chicken, salad, garlic sauce', 2500, true, 1, false),
        ('30000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002', 'Beef Burger', 'Beef patty, cheese, fries', 4500, true, 2, false),
        ('30000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000002', 'Meat Pie', 'Baked daily', 1000, true, 3, false),
        ('30000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000002', 'Soft Drink', 'Assorted 350ml', 800, true, 4, false),
        ('30000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000003', 'Chicken Waffle', 'Waffle, fried chicken, syrup', 3800, true, 1, true),
        ('30000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000003', 'Waffle and Ice Cream', 'Two scoops', 2200, true, 2, false),
        ('30000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000004', 'Rice and Grilled Tilapia', 'With pepper sauce', 4200, true, 1, true),
        ('30000000-0000-4000-8000-000000000032', '20000000-0000-4000-8000-000000000004', 'Fruit Juice', 'Freshly pressed', 1200, true, 2, false)
      on conflict (id) do update
         set vendor_id = excluded.vendor_id, name = excluded.name,
             description = excluded.description, price_pesewas = excluded.price_pesewas,
             is_available = excluded.is_available, sort_order = excluded.sort_order,
             -- WHAT A MEAL SCAN MAY BE SPENT ON. Scan tests flip this to prove
             -- the per-item rule, so it is restored with everything else.
             scan_eligible = excluded.scan_eligible
    `);
    await c.query(`
      delete from public.menu_items
       where vendor_id in (
           '20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002',
           '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000004'
         )
         and id not in (
           '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002',
           '30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000004',
           '30000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000011',
           '30000000-0000-4000-8000-000000000012','30000000-0000-4000-8000-000000000013',
           '30000000-0000-4000-8000-000000000014',
           '30000000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000022',
           '30000000-0000-4000-8000-000000000031','30000000-0000-4000-8000-000000000032'
         )
    `);
    // Locations: drop anything a test created, then restore the seeded rows in
    // full. UPSERT, not UPDATE — a seeded row can now genuinely be DELETED by an
    // admin test, because an order no longer names a destination at submission
    // and therefore no longer pins one. An update-only restore left Room 204
    // missing for every file that ran afterwards, and the failure it produced
    // ("destination is not a valid delivery location") pointed nowhere near it.
    await c.query(`
      delete from public.locations
       where id::text not like '10000000-0000-4000-8000-%'
    `);
    await c.query(`
      insert into public.locations (id, parent_id, kind, name, is_deliverable, walk_minutes, sort_order, is_active)
      values
        ('10000000-0000-4000-8000-000000000001', null, 'CAMPUS', 'Academic City', false, 0, 0, true),
        ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Hostel Block A', false, 5, 10, true),
        ('10000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Hostel Block B', false, 7, 20, true),
        ('10000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Academic Block', false, 3, 30, true),
        ('10000000-0000-4000-8000-000000000040', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Sports Complex', false, 9, 40, true),
        ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000010', 'FLOOR', 'Floor 1', false, null, 1, true),
        ('10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000010', 'FLOOR', 'Floor 2', false, null, 2, true),
        ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000020', 'FLOOR', 'Floor 1', false, null, 1, true),
        ('10000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000030', 'FLOOR', 'Ground Floor', false, null, 1, true),
        ('10000000-0000-4000-8000-000000000111', '10000000-0000-4000-8000-000000000011', 'ROOM', 'Room 101', true, null, 1, true),
        ('10000000-0000-4000-8000-000000000112', '10000000-0000-4000-8000-000000000011', 'ROOM', 'Room 102', true, null, 2, true),
        ('10000000-0000-4000-8000-000000000121', '10000000-0000-4000-8000-000000000012', 'ROOM', 'Room 204', true, null, 1, true),
        ('10000000-0000-4000-8000-000000000122', '10000000-0000-4000-8000-000000000012', 'ROOM', 'Room 205', true, null, 2, true),
        ('10000000-0000-4000-8000-000000000211', '10000000-0000-4000-8000-000000000021', 'ROOM', 'Room 110', true, null, 1, true),
        ('10000000-0000-4000-8000-000000000311', '10000000-0000-4000-8000-000000000031', 'COMMON_AREA', 'Library Entrance', true, null, 1, true),
        ('10000000-0000-4000-8000-000000000411', '10000000-0000-4000-8000-000000000040', 'FIELD', 'Main Field', true, null, 1, true)
      on conflict (id) do update
         set parent_id = excluded.parent_id, kind = excluded.kind, name = excluded.name,
             is_deliverable = excluded.is_deliverable, walk_minutes = excluded.walk_minutes,
             sort_order = excluded.sort_order, is_active = true
    `);
    await c.query(`update public.users set is_suspended = false`);
    // Restore seeded names AND addresses: tests rename accounts and commit.
    //
    // THE PARTS, NOT full_name. full_name is derived from first_name and
    // last_name by a trigger, so restoring only the whole would be overwritten
    // by the parts a test left behind — the fixture has to put back what the
    // trigger reads.
    //
    // A customer's school address is their sign-in identity, so it is restored
    // rather than cleared: blanking it would delete the identity, not reset a
    // stray field. Vendor accounts have no address at all, which is the point —
    // they sign in by phone and are never asked for one.
    await c.query(`
      update public.users u
         set first_name = v.first, last_name = v.last, email = v.email
        from (values
          ('00000000-0000-4000-8000-000000000001','Dev',     'Admin',           'admin@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000011','Muni',    'Owner (test)',    null),
          ('00000000-0000-4000-8000-000000000012','Grill',   'Owner (test)',    null),
          ('00000000-0000-4000-8000-000000000013','Pending', 'Owner (test)',    null),
          ('00000000-0000-4000-8000-000000000014','Rejected','Owner (test)',    null),
          ('00000000-0000-4000-8000-000000000021','Ama',     'Test-Customer',   'ama@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000022','Kwesi',   'Test-Customer',   'kwesi@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000023','Efua',    'Test-Customer',   'efua@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000031','Yaw',     'Test-Partner',    'yaw@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000032','Adjoa',   'Test-Partner',    'adjoa@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000033','Kofi',    'Test-Applicant',  'kofi@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000034','Esi',     'Test-Partner',    'esi@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000035','Kojo',    'Test-Applicant',  'kojo@acity.edu.gh'),
          ('00000000-0000-4000-8000-000000000024','Abena',   'Test-Customer',   'abena@acity.edu.gh')
        ) as v(id, first, last, email)
       where u.id = v.id::uuid
    `);
    // Addresses claimed by accounts the tests invented, so a re-run of the same
    // fixture does not collide on users_email_unique.
    await c.query(`
      update public.users set email = null
       where id not in (
         '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000011',
         '00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000013',
         '00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000021',
         '00000000-0000-4000-8000-000000000022','00000000-0000-4000-8000-000000000023',
         '00000000-0000-4000-8000-000000000024','00000000-0000-4000-8000-000000000031',
         '00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000033',
         '00000000-0000-4000-8000-000000000034','00000000-0000-4000-8000-000000000035'
       )
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
  vendorPendingOwner: '00000000-0000-4000-8000-000000000013',
  vendorRejectedOwner: '00000000-0000-4000-8000-000000000014',
  // The scan stores are OPERATED, not catalogue entries: a store that honours a
  // meal scan is the redemption point and needs a board to do it from.
  wafflemaniaStaff: '00000000-0000-4000-8000-000000000015',
  yellowBarStaff: '00000000-0000-4000-8000-000000000016',
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
  // Scan-capable in the seed. `two` deliberately is NOT, so a test can prove a
  // scan order is refused at a restaurant that does not take scans.
  wafflemania: '20000000-0000-4000-8000-000000000003',
  yellowBar: '20000000-0000-4000-8000-000000000004',
  // Awaiting review and rejected-with-a-reason. Both are owned; neither is
  // ACTIVE, so neither appears in the marketplace or grants a dashboard.
  pending: '20000000-0000-4000-8000-000000000005',
  rejected: '20000000-0000-4000-8000-000000000006',
};

/** Reference data from the migration, not the seed. Stable ids everywhere. */
export const CATEGORIES = {
  meals: '40000000-0000-4000-8000-000000000001',
  snacks: '40000000-0000-4000-8000-000000000002',
  drinks: '40000000-0000-4000-8000-000000000003',
  bakery: '40000000-0000-4000-8000-000000000004',
  groceries: '40000000-0000-4000-8000-000000000005',
  other: '40000000-0000-4000-8000-00000000000c',
};

export const MENU = {
  jollof: '30000000-0000-4000-8000-000000000001', // 3500
  waakye: '30000000-0000-4000-8000-000000000002', // 3000
  water: '30000000-0000-4000-8000-000000000004', // 300
  kelewele: '30000000-0000-4000-8000-000000000005', // unavailable
  shawarma: '30000000-0000-4000-8000-000000000011', // vendor two
};

/**
 * The scan stores' menus.
 *
 * ELIGIBILITY IS PER ITEM, so `wafflemaniaIneligible` exists on purpose: it is
 * on a scan store's menu and still cannot be paid for with a scan, which is the
 * distinction the store-level switch alone could not express.
 */
export const SCAN_MENU = {
  waffle: '30000000-0000-4000-8000-000000000021', // 3800, Wafflemania, eligible
  tilapia: '30000000-0000-4000-8000-000000000031', // 4200, Yellow Bar, eligible
  // On a scan store's menu and still NOT payable with a scan.
  iceCream: '30000000-0000-4000-8000-000000000022', // 2200, Wafflemania
  juice: '30000000-0000-4000-8000-000000000032', // 1200, Yellow Bar
};

export const LOCATIONS = {
  room204: '10000000-0000-4000-8000-000000000121',
  room101: '10000000-0000-4000-8000-000000000111',
  blockA: '10000000-0000-4000-8000-000000000010',
  floor2: '10000000-0000-4000-8000-000000000012', // not deliverable
};
