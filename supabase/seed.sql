-- ============================================================================
-- Campus Dash — LOCAL DEVELOPMENT SEED DATA
-- ============================================================================
--                    *** DEVELOPMENT / TEST DATA ONLY ***
--
-- Every person, vendor and phone number below is fictional and exists solely to
-- exercise the local stack. Nothing here describes a real business, a real
-- student, or a real commercial arrangement with anybody at Academic City.
--
-- Phone numbers use the +23320000xxxx range as obvious placeholders.
-- Prices are plausible campus prices, not quoted or agreed prices.
--
-- Runs automatically on `supabase db reset`.
-- ============================================================================

-- Deterministic UUIDs so tests can reference actors by constant.
--   ...-0001  admin
--   ...-001x  vendor staff
--   ...-002x  customers
--   ...-003x  partners

-- ---------------------------------------------------------------------------
-- auth.users — phone-based accounts (no passwords; V1 is phone OTP)
-- ---------------------------------------------------------------------------
-- IMPORTANT: GoTrue stores phone numbers WITHOUT the leading '+', and matches
-- on that form at sign-in. Seeding them WITH a '+' looks harmless but means a
-- seeded account can never be found: GoTrue creates a SECOND auth user, which
-- then collides on public.users' unique phone. public.users keeps the '+'
-- (our E.164 form); auth.users must not have it.
-- Two things here look cosmetic and are not:
--
--   1. Phone numbers carry NO leading '+'. GoTrue stores and matches them in
--      that form. Seeding them with a '+' means a seeded account can never be
--      found at sign-in: GoTrue creates a SECOND auth user, which then collides
--      on public.users' unique phone. (public.users keeps the '+' — that is our
--      E.164 form, and the provisioning trigger adds it back.)
--
--   2. The token columns are '' and never NULL. GoTrue scans them into Go
--      strings and fails with "converting NULL to string is unsupported",
--      surfacing as "Database error finding user" on every sign-in. Several of
--      these columns have no database default, so they are set explicitly.
insert into auth.users (
  instance_id, id, aud, role,
  phone, phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   '233200000001', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Dev Admin"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated',
   '233200000011', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Muni Owner (test)"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated',
   '233200000012', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Grill Owner (test)"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000021', 'authenticated', 'authenticated',
   '233200000021', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Ama Test-Customer"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000022', 'authenticated', 'authenticated',
   '233200000022', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Kwesi Test-Customer"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000023', 'authenticated', 'authenticated',
   '233200000023', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Efua Test-Customer"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000031', 'authenticated', 'authenticated',
   '233200000031', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Yaw Test-Partner"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000032', 'authenticated', 'authenticated',
   '233200000032', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Adjoa Test-Partner"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000033', 'authenticated', 'authenticated',
   '233200000033', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Kofi Test-Applicant"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000034', 'authenticated', 'authenticated',
   '233200000034', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Esi Test-Partner"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000035', 'authenticated', 'authenticated',
   '233200000035', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Kojo Test-Applicant"}',
   now(), now(), '', '', '', '', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000024', 'authenticated', 'authenticated',
   '233200000024', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Abena Test-Customer"}',
   now(), now(), '', '', '', '', '', '', '', '');

-- ---------------------------------------------------------------------------
-- public.users — profiles
-- ---------------------------------------------------------------------------
-- The on_auth_user_created trigger has ALREADY created a base profile for each
-- auth.users row above. This upsert only adds what the trigger cannot know:
-- who is an admin, and which student ID backs a Partner application.
insert into public.users (id, phone, full_name, is_admin, student_id_number) values
  ('00000000-0000-4000-8000-000000000001', '+233200000001', 'Dev Admin',            true,  null),
  ('00000000-0000-4000-8000-000000000011', '+233200000011', 'Muni Owner (test)',    false, null),
  ('00000000-0000-4000-8000-000000000012', '+233200000012', 'Grill Owner (test)',   false, null),
  ('00000000-0000-4000-8000-000000000021', '+233200000021', 'Ama Test-Customer',    false, null),
  ('00000000-0000-4000-8000-000000000022', '+233200000022', 'Kwesi Test-Customer',  false, null),
  ('00000000-0000-4000-8000-000000000023', '+233200000023', 'Efua Test-Customer',   false, null),
  ('00000000-0000-4000-8000-000000000031', '+233200000031', 'Yaw Test-Partner',     false, 'TEST-STU-0031'),
  ('00000000-0000-4000-8000-000000000032', '+233200000032', 'Adjoa Test-Partner',   false, 'TEST-STU-0032'),
  ('00000000-0000-4000-8000-000000000033', '+233200000033', 'Kofi Test-Applicant',  false, 'TEST-STU-0033'),
  ('00000000-0000-4000-8000-000000000034', '+233200000034', 'Esi Test-Partner',     false, 'TEST-STU-0034'),
  ('00000000-0000-4000-8000-000000000035', '+233200000035', 'Kojo Test-Applicant',  false, 'TEST-STU-0035'),
  ('00000000-0000-4000-8000-000000000024', '+233200000024', 'Abena Test-Customer',  false, null)
on conflict (id) do update
   set full_name         = excluded.full_name,
       is_admin          = excluded.is_admin,
       student_id_number = excluded.student_id_number;

-- ---------------------------------------------------------------------------
-- Partner profiles
-- ---------------------------------------------------------------------------
-- Two approved and available; one still awaiting manual review, so the admin
-- approval screen has something real to act on.
insert into public.partner_profiles (
  user_id, status, is_available, student_id_image_path, face_image_path,
  reviewed_at, reviewed_by
) values
  ('00000000-0000-4000-8000-000000000031', 'APPROVED', true,
   'partner-docs/dev/0031/student-id.jpg', 'partner-docs/dev/0031/face.jpg',
   now(), '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000032', 'APPROVED', true,
   'partner-docs/dev/0032/student-id.jpg', 'partner-docs/dev/0032/face.jpg',
   now(), '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000033', 'PENDING_REVIEW', false,
   'partner-docs/dev/0033/student-id.jpg', 'partner-docs/dev/0033/face.jpg',
   null, null),
  ('00000000-0000-4000-8000-000000000034', 'APPROVED', true,
   'partner-docs/dev/0034/student-id.jpg', 'partner-docs/dev/0034/face.jpg',
   now(), '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000035', 'PENDING_REVIEW', false,
   'partner-docs/dev/0035/student-id.jpg', 'partner-docs/dev/0035/face.jpg',
   null, null);

-- ---------------------------------------------------------------------------
-- Locations — Academic City campus tree
-- ---------------------------------------------------------------------------
-- Illustrative structure for development. Real block, floor and room names must
-- come from the university before this is used with real students.
insert into public.locations (id, parent_id, kind, name, is_deliverable, walk_minutes, sort_order) values
  ('10000000-0000-4000-8000-000000000001', null, 'CAMPUS', 'Academic City', false, 0, 0);

insert into public.locations (id, parent_id, kind, name, is_deliverable, walk_minutes, sort_order) values
  ('10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Hostel Block A',   false, 5,  10),
  ('10000000-0000-4000-8000-000000000020', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Hostel Block B',   false, 7,  20),
  ('10000000-0000-4000-8000-000000000030', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Academic Block',   false, 3,  30),
  ('10000000-0000-4000-8000-000000000040', '10000000-0000-4000-8000-000000000001', 'BLOCK', 'Sports Complex',   false, 9,  40);

insert into public.locations (id, parent_id, kind, name, is_deliverable, sort_order) values
  ('10000000-0000-4000-8000-000000000011', '10000000-0000-4000-8000-000000000010', 'FLOOR', 'Floor 1', false, 1),
  ('10000000-0000-4000-8000-000000000012', '10000000-0000-4000-8000-000000000010', 'FLOOR', 'Floor 2', false, 2),
  ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000020', 'FLOOR', 'Floor 1', false, 1),
  ('10000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000030', 'FLOOR', 'Ground Floor', false, 1);

insert into public.locations (id, parent_id, kind, name, is_deliverable, sort_order) values
  ('10000000-0000-4000-8000-000000000111', '10000000-0000-4000-8000-000000000011', 'ROOM', 'Room 101', true, 1),
  ('10000000-0000-4000-8000-000000000112', '10000000-0000-4000-8000-000000000011', 'ROOM', 'Room 102', true, 2),
  ('10000000-0000-4000-8000-000000000121', '10000000-0000-4000-8000-000000000012', 'ROOM', 'Room 204', true, 1),
  ('10000000-0000-4000-8000-000000000122', '10000000-0000-4000-8000-000000000012', 'ROOM', 'Room 205', true, 2),
  ('10000000-0000-4000-8000-000000000211', '10000000-0000-4000-8000-000000000021', 'ROOM', 'Room 110', true, 1),
  ('10000000-0000-4000-8000-000000000311', '10000000-0000-4000-8000-000000000031', 'COMMON_AREA', 'Library Entrance', true, 1),
  ('10000000-0000-4000-8000-000000000411', '10000000-0000-4000-8000-000000000040', 'FIELD', 'Main Field', true, 1);

-- ---------------------------------------------------------------------------
-- Vendors (fictional) and their staff
-- ---------------------------------------------------------------------------
insert into public.vendors (id, name, phone, status, is_accepting_orders, location_id, walk_minutes_to_campus) values
  ('20000000-0000-4000-8000-000000000001', 'Test Kitchen One',  '+233200000011', 'ACTIVE', true,
   '10000000-0000-4000-8000-000000000030', 4),
  ('20000000-0000-4000-8000-000000000002', 'Test Grill Two',    '+233200000012', 'ACTIVE', true,
   '10000000-0000-4000-8000-000000000040', 6);

insert into public.vendor_users (vendor_id, user_id) values
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011'),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000012');

-- ---------------------------------------------------------------------------
-- Menu items (prices in integer pesewas)
-- ---------------------------------------------------------------------------
insert into public.menu_items (id, vendor_id, name, description, price_pesewas, is_available, sort_order) values
  ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Jollof Rice with Chicken', 'Jollof rice, grilled chicken, shito', 3500, true, 1),
  ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Waakye Special',           'Waakye, egg, gari, stew',            3000, true, 2),
  ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000001', 'Fried Rice with Beef',     'Fried rice and beef',                4000, true, 3),
  ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'Bottled Water',            '500ml',                               300, true, 4),
  ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000001', 'Kelewele',                 'Spiced fried plantain',              1500, false, 5),

  ('30000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000002', 'Chicken Shawarma',         'Chicken, salad, garlic sauce',       2500, true, 1),
  ('30000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000002', 'Beef Burger',              'Beef patty, cheese, fries',          4500, true, 2),
  ('30000000-0000-4000-8000-000000000013', '20000000-0000-4000-8000-000000000002', 'Meat Pie',                 'Baked daily',                        1000, true, 3),
  ('30000000-0000-4000-8000-000000000014', '20000000-0000-4000-8000-000000000002', 'Soft Drink',               'Assorted 350ml',                      800, true, 4);

-- ---------------------------------------------------------------------------
-- Pricing — PLACEHOLDER figures pending a commercial decision
-- ---------------------------------------------------------------------------
-- 10% Campus Dash fee, GH₵5.00 flat delivery fee, Partner receives all of it.
-- See docs/PILOT-QUESTIONS.md — none of these are agreed numbers.
--
-- The timing values below are widened FOR LOCAL MANUAL TESTING ONLY. A human
-- clicking between four browser profiles cannot beat the real 60-second vendor
-- window, and every order would expire mid-walkthrough. The migration defaults
-- (60 / 600 / 300) remain the product intent and are what production gets,
-- because production runs migrations without this seed file. The automated
-- tests reset these to the real values themselves — see tests/helpers/db.js.
update public.pricing_config
   set service_fee_bps = 500,
       delivery_fee_pesewas = 500,
       partner_share_of_delivery_bps = 10000,
       vendor_response_seconds = 1800,
       partner_search_seconds = 1800,
       customer_absent_wait_seconds = 60,
       payment_pending_timeout_seconds = 300
 where id;


-- ---------------------------------------------------------------------------
-- Terms acceptances — development convenience
-- ---------------------------------------------------------------------------
-- The terms DOCUMENTS themselves are reference data and live in a migration
-- (20260908000001), because every environment needs them. Only the acceptances
-- are development-only: they exist so a local walkthrough does not start behind
-- a consent wall. New sign-ups still get the real prompt.

insert into public.terms_acceptances (user_id, terms_id, audience, version)
select u.id, t.id, t.audience, t.version
  from public.users u
  cross join public.terms_documents t
 where t.audience = 'CUSTOMER'
on conflict do nothing;

insert into public.terms_acceptances (user_id, terms_id, audience, version)
select vu.user_id, t.id, t.audience, t.version
  from public.vendor_users vu
  cross join public.terms_documents t
 where t.audience = 'VENDOR'
on conflict do nothing;

insert into public.terms_acceptances (user_id, terms_id, audience, version)
select p.user_id, t.id, t.audience, t.version
  from public.partner_profiles p
  cross join public.terms_documents t
 where t.audience = 'PARTNER' and p.status = 'APPROVED'
on conflict do nothing;
