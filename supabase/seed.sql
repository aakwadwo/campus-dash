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
insert into auth.users (
  instance_id, id, aud, role, phone, phone_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', '+233200000001', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Dev Admin"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', '+233200000011', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Muni Owner (test)"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', '+233200000012', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Grill Owner (test)"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000021', 'authenticated', 'authenticated', '+233200000021', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Ama Test-Customer"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000022', 'authenticated', 'authenticated', '+233200000022', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Kwesi Test-Customer"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000023', 'authenticated', 'authenticated', '+233200000023', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Efua Test-Customer"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000031', 'authenticated', 'authenticated', '+233200000031', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Yaw Test-Partner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000032', 'authenticated', 'authenticated', '+233200000032', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Adjoa Test-Partner"}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000033', 'authenticated', 'authenticated', '+233200000033', now(), '{"provider":"phone","providers":["phone"]}', '{"full_name":"Kofi Test-Applicant"}', now(), now());

-- ---------------------------------------------------------------------------
-- public.users — profiles
-- ---------------------------------------------------------------------------
insert into public.users (id, phone, full_name, is_admin, student_id_number) values
  ('00000000-0000-4000-8000-000000000001', '+233200000001', 'Dev Admin',            true,  null),
  ('00000000-0000-4000-8000-000000000011', '+233200000011', 'Muni Owner (test)',    false, null),
  ('00000000-0000-4000-8000-000000000012', '+233200000012', 'Grill Owner (test)',   false, null),
  ('00000000-0000-4000-8000-000000000021', '+233200000021', 'Ama Test-Customer',    false, null),
  ('00000000-0000-4000-8000-000000000022', '+233200000022', 'Kwesi Test-Customer',  false, null),
  ('00000000-0000-4000-8000-000000000023', '+233200000023', 'Efua Test-Customer',   false, null),
  ('00000000-0000-4000-8000-000000000031', '+233200000031', 'Yaw Test-Partner',     false, 'TEST-STU-0031'),
  ('00000000-0000-4000-8000-000000000032', '+233200000032', 'Adjoa Test-Partner',   false, 'TEST-STU-0032'),
  ('00000000-0000-4000-8000-000000000033', '+233200000033', 'Kofi Test-Applicant',  false, 'TEST-STU-0033');

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
-- GH₵2.00 service fee, GH₵5.00 flat delivery fee, Partner receives all of it.
-- See docs/OPEN-QUESTIONS.md — none of these are agreed numbers.
update public.pricing_config
   set service_fee_pesewas = 200,
       delivery_fee_pesewas = 500,
       partner_share_of_delivery_bps = 10000
 where id;
