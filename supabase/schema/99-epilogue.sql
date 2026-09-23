

-- ============================================================================
-- OBJECTS OUTSIDE THE public SCHEMA
-- ============================================================================
-- pg_dump --schema public cannot see these, and all three are load-bearing.


-- ---------------------------------------------------------------------------
-- auth.users → public.users provisioning
-- ---------------------------------------------------------------------------
-- A profile row is created by a trigger the moment a contact detail is
-- CONFIRMED, never when a code is merely requested. GoTrue inserts the
-- auth.users row as soon as somebody asks for a code, before anything is
-- proven; provisioning then would let anyone claim a phone number or an address
-- they do not own just by asking.
--
-- Doing it in a trigger rather than in application code means an account can
-- never exist without a profile: there is no window, and no code path that
-- forgets. Both trigger functions live in `public` (above) and are granted to
-- nobody.
--
-- THE COLUMN LIST IS THE FIRING CONDITION, not documentation. This trigger was
-- once declared `AFTER UPDATE OF phone_confirmed_at` alone, and when customers
-- moved to email sign-in it silently stopped firing for them: GoTrue confirms
-- an address by updating `email_confirmed_at`, so no profile was ever created
-- and every customer sign-up died one step after the code was accepted. Both
-- columns, always.

DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";
CREATE TRIGGER "on_auth_user_created"
  AFTER INSERT ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_auth_user"();

DROP TRIGGER IF EXISTS "on_auth_user_phone_confirmed" ON "auth"."users";
DROP TRIGGER IF EXISTS "on_auth_user_confirmed" ON "auth"."users";
CREATE TRIGGER "on_auth_user_confirmed"
  AFTER UPDATE OF "phone_confirmed_at", "email_confirmed_at" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."handle_auth_user_phone_confirmed"();


-- ---------------------------------------------------------------------------
-- Private storage for Partner verification documents
-- ---------------------------------------------------------------------------
-- Holds the student ID photograph and the live face photograph an admin holds
-- next to each other during approval. Both belong to the PARTNER application;
-- a customer holds no verification document at all.
--
-- The bucket is PRIVATE and deliberately has NO policies on storage.objects.
-- Without a policy, RLS denies every client read and write — which is exactly
-- right for a photograph of a government ID. An admin sees an image only
-- through a short-lived signed URL minted server-side (lib/admin/documents.js),
-- and only for the minutes it takes to look at it.

INSERT INTO "storage"."buckets" ("id", "name", "public", "file_size_limit", "allowed_mime_types")
VALUES (
  'partner-documents',
  'partner-documents',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT ("id") DO UPDATE
   SET "public"             = false,
       "file_size_limit"    = EXCLUDED."file_size_limit",
       "allowed_mime_types" = EXCLUDED."allowed_mime_types";


-- ---------------------------------------------------------------------------
-- Private storage for campus meal scans
-- ---------------------------------------------------------------------------
-- A different bucket from the verification documents, because it is a different
-- subject with a different retention and a different set of readers: a
-- verification document is looked at once by an administrator, whereas a scan is
-- released to one assigned Partner for the length of one errand. Keeping them
-- apart means a policy change to one can never widen the other.
--
-- Also NO policies on storage.objects, for the same reason as the other private
-- bucket. PDF is allowed alongside images because the university issues some
-- entitlements that way, and a student should not have to screenshot a PDF.
--
-- This was missing from this file, which meant a hosted project installed from
-- schema.sql had no bucket to put a scan in and scan delivery failed there for
-- a reason nothing in the application would name.

INSERT INTO "storage"."buckets" ("id", "name", "public", "file_size_limit", "allowed_mime_types")
VALUES (
  'scan-documents',
  'scan-documents',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT ("id") DO UPDATE
   SET "public"             = false,
       "file_size_limit"    = EXCLUDED."file_size_limit",
       "allowed_mime_types" = EXCLUDED."allowed_mime_types";


-- ---------------------------------------------------------------------------
-- PUBLIC storage for vendor storefront photographs
-- ---------------------------------------------------------------------------
-- The one public bucket, and deliberately so. An unauthenticated visitor
-- browsing the marketplace has to see these, and minting a signed URL per photo
-- per page load would be real cost for no secret: a picture of a plate of jollof
-- is advertising.
--
-- What stays locked down is WRITING. Like the private buckets it has NO policies
-- on storage.objects, so RLS denies every client write; reads on a public bucket
-- are served without one. Every object in it went through
-- lib/verification/documents.js, which checks who is asking before it uploads.

INSERT INTO "storage"."buckets" ("id", "name", "public", "file_size_limit", "allowed_mime_types")
VALUES (
  'vendor-images',
  'vendor-images',
  true,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT ("id") DO UPDATE
   SET "public"             = true,
       "file_size_limit"    = EXCLUDED."file_size_limit",
       "allowed_mime_types" = EXCLUDED."allowed_mime_types";


-- ---------------------------------------------------------------------------
-- Scheduled sweeps (pg_cron)
-- ---------------------------------------------------------------------------
-- A vendor who simply ignores an order must not leave it SUBMITTED for ever,
-- a dispatch search must give up, and a payment the provider never confirmed
-- must not strand a customer on a spinner.
--
-- All three functions call assert_service_or_admin(). pg_cron runs jobs as the
-- database owner, so session_user is 'postgres' and the assertion passes —
-- exactly the "direct database connection" case it was written for.
--
-- cron.schedule() upserts on job name, so re-running this file is safe.

-- The vendor acceptance window is 60 seconds, so a coarser sweep would leave an
-- order visibly stuck past its own countdown. Every 30s bounds the error at
-- half a window.
SELECT "cron"."schedule"(
  'campus-dash-expire-stale-orders',
  '30 seconds',
  $job$ select public.expire_stale_orders(); $job$
);

-- The dispatch search window is 10 minutes; a minute of slack is immaterial.
-- (pg_cron takes the "N seconds" form only for sub-minute intervals.)
SELECT "cron"."schedule"(
  'campus-dash-expire-partner-search',
  '* * * * *',
  $job$ select public.expire_partner_search(); $job$
);

-- Often enough that a customer is not left staring at a spinner, rare enough
-- that it never races a callback that is merely slow.
SELECT "cron"."schedule"(
  'campus-dash-expire-stale-payments',
  '*/15 * * * *',
  $job$ select public.expire_stale_payments(); $job$
);


-- ============================================================================
-- REFERENCE DATA
-- ============================================================================
-- The rows the product cannot start without. Everything here is platform
-- configuration, not sample data — no people, no vendors, no menus, no
-- locations. Those are development-only and live in supabase/seed.sql.


-- ---------------------------------------------------------------------------
-- Platform configuration — one row, id = true
-- ---------------------------------------------------------------------------
-- Fees and timeouts are NOT environment variables. They live here so the pilot
-- can be retuned from /admin/pilot without a deploy, and every change is
-- written to admin_actions.
--
-- The values are the product intent: a 10% Campus Dash service fee on the food
-- subtotal, a flat GH₵5.00 delivery fee, all of which goes to the Partner, a
-- 60-second vendor answer window and a 10-minute dispatch search. None of them
-- are agreed commercial numbers — see docs/PILOT-QUESTIONS.md.
--
-- Column defaults carry the rest; naming only the two that have none keeps
-- this from drifting silently when a column is added.

INSERT INTO "public"."pricing_config" ("id", "service_fee_bps", "delivery_fee_pesewas")
VALUES (true, 1000, 500)
ON CONFLICT ("id") DO NOTHING;


-- ---------------------------------------------------------------------------
-- The Academic City campus
-- ---------------------------------------------------------------------------
-- The places a customer can choose as a destination. Reference data, not
-- seed: without it nobody can ask for a Campus Dash Partner. Identical to the
-- block in 20261007000001_campus_places_and_additional_information.sql, and
-- written so that running it on a database that already has the tree changes
-- nothing.

-- THE TREE ITSELF, written so that running it twice changes nothing.
--
-- A node that already exists under the same parent with the same name is
-- REUSED, never duplicated — a hosted project whose administrator already
-- typed in "Hostel A" keeps that row and every order pointing at it. A node
-- that does not exist is created with an id derived from its parent and its
-- name, so two environments built from empty agree on every id.
--
-- Anything active that is NOT in this list is switched off, not deleted. An
-- order that named it keeps its foreign key and its readable label; it simply
-- stops being offered to the next customer. Campus Dash does not invent places.
create or replace function pg_temp.campus_place(
  p_parent uuid, p_kind public.location_kind, p_name text, p_deliverable boolean, p_sort integer
) returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select id into v_id
    from public.locations
   where parent_id is not distinct from p_parent and lower(name) = lower(p_name);

  if v_id is null then
    insert into public.locations (id, parent_id, kind, name, is_deliverable, sort_order)
    values (md5('campus-dash:location:' || coalesce(p_parent::text, '') || '/' || lower(p_name))::uuid,
            p_parent, p_kind, p_name, p_deliverable, p_sort)
    returning id into v_id;
  else
    update public.locations
       set is_deliverable = p_deliverable, is_active = true, sort_order = p_sort
     where id = v_id;
  end if;

  insert into pg_temp.campus_places (id) values (v_id) on conflict do nothing;
  return v_id;
end;
$fn$;

create temporary table if not exists campus_places (id uuid primary key);

do $tree$
declare
  v_root   uuid;
  v_block  uuid;
  v_floor  uuid;
  v_group  uuid;
  v_hostel text;
  v_letter text;
  v_i      integer;
  v_h      integer := 0;
  v_f      integer;
begin
  -- The campus root: the existing one if an administrator already made it.
  select id into v_root
    from public.locations
   where kind = 'CAMPUS' and parent_id is null
   order by (lower(name) = 'academic city') desc, is_active desc, sort_order, created_at
   limit 1;
  if v_root is null then
    v_root := pg_temp.campus_place(null, 'CAMPUS', 'Academic City', false, 0);
  else
    insert into pg_temp.campus_places (id) values (v_root) on conflict do nothing;
  end if;

  -- ACADEMIC BLOCK. A floor stands on its own; a room is optional precision.
  v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Academic Block', false, 10);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Ground Floor', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A1', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A2', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'A3', true, 3);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Make Lab', true, 4);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'First Floor', true, 2);
  for v_i in 1..6 loop
    perform pg_temp.campus_place(v_floor, 'ROOM', 'L' || v_i, true, v_i);
  end loop;
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Computer Lab 1', true, 7);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Computer Lab 2', true, 8);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Library', true, 9);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Second Floor', true, 3);
  for v_i in 7..12 loop
    perform pg_temp.campus_place(v_floor, 'ROOM', 'L' || v_i, true, v_i - 6);
  end loop;
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Media Lab', true, 7);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Math Center', true, 8);

  -- ADMINISTRATIVE BLOCK.
  v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Administrative Block', false, 20);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Ground Floor', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'SCA', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Finance', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Old Cafeteria', true, 3);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'First Floor', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'IT Office', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Marketing & Admissions Office', true, 2);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Reception/Lounge', true, 3);
  v_floor := pg_temp.campus_place(v_block, 'FLOOR', 'Second Floor', true, 3);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Registry Office', true, 1);
  perform pg_temp.campus_place(v_floor, 'ROOM', 'Faculty Office', true, 2);

  -- HOSTELS. The entrance is where somebody who just says "Hostel A" is met;
  -- a floor stands on its own; a room is optional.
  foreach v_hostel in array array['A', 'B'] loop
    v_h := v_h + 1;
    v_block := pg_temp.campus_place(v_root, 'BLOCK', 'Hostel ' || v_hostel, false, 30 + v_h);
    perform pg_temp.campus_place(v_block, 'COMMON_AREA', 'Hostel ' || v_hostel || ' Entrance', true, 0);
    v_f := 0;
    foreach v_letter in array array['A', 'B', 'C', 'D'] loop
      v_f := v_f + 1;
      v_floor := pg_temp.campus_place(v_block, 'FLOOR', v_letter || ' Floor', true, v_f);
      for v_i in 1..32 loop
        perform pg_temp.campus_place(v_floor, 'ROOM', v_letter || v_i, true, v_i);
      end loop;
    end loop;
  end loop;

  -- LANDMARKS, grouped the way people describe them. The group is how the
  -- picker files them; the place is what everybody reads.
  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Sports & recreation', false, 40);
  perform pg_temp.campus_place(v_group, 'FIELD', 'Football Field', true, 1);
  perform pg_temp.campus_place(v_group, 'FIELD', 'Basketball Court', true, 2);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Slabs', true, 3);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Rec Center Top', true, 4);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Rec Center Down', true, 5);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Old Cafeteria', true, 6);

  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Facilities', false, 50);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Wafflemania', true, 1);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Engineering Workshop', true, 2);

  v_group := pg_temp.campus_place(v_root, 'BLOCK', 'Parking', false, 60);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Academic Block Car Park', true, 1);
  perform pg_temp.campus_place(v_group, 'COMMON_AREA', 'Hostel Car Park', true, 2);

  -- Everything else under this campus stops being offered.
  update public.locations l
     set is_active = false
   where l.is_active
     and l.id not in (select id from pg_temp.campus_places)
     and l.id in (
       with recursive below as (
         select id from public.locations where parent_id = v_root
         union all
         select c.id from public.locations c join below b on c.parent_id = b.id
       )
       select id from below
     );
end;
$tree$;

drop function pg_temp.campus_place(uuid, public.location_kind, text, boolean, integer);
drop table pg_temp.campus_places;


-- ---------------------------------------------------------------------------
-- Terms documents (version 1 was placeholder text; versions 2 and 3 are real)
-- ---------------------------------------------------------------------------
-- THESE ARE NOT LEGAL TERMS. They exist so the acceptance mechanism has
-- something to present and record. Real text must come from a lawyer familiar
-- with Ghanaian consumer and contractor law before anybody relies on it — see
-- docs/PILOT-QUESTIONS.md.
--
-- They are here rather than in the seed because the terms gate is part of the
-- product: with this table empty, every actor signs in with nothing to accept,
-- and the whole mechanism looks like it works when it has simply been skipped.
-- Publishing version 2 is an INSERT, never an edit — an acceptance points at
-- the exact row the person agreed to.

INSERT INTO "public"."terms_documents" ("audience", "version", "title", "body", "published_at")
VALUES
  ('CUSTOMER', 1, 'Campus Dash customer terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You order from independent vendors around Academic City. Campus Dash takes '
   'payment, passes the food amount to the vendor, and arranges delivery by a '
   'verified student Partner when you ask for one.\n\n'
   'You are not charged until a vendor accepts your order. Prices are set by '
   'vendors. Campus Dash charges a service fee, and a delivery fee when a '
   'Partner brings your order.\n\n'
   'You will be given a delivery code. Give it only to the Partner who brings '
   'your order.', "now"()),

  ('VENDOR', 1, 'Campus Dash vendor terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You accept or reject orders within the response window shown in the app. '
   'Prices are yours; Campus Dash does not change them. You mark food READY '
   'only when it is actually ready.\n\n'
   'Campus Dash settles the food amount to you daily. Campus Dash does not hold '
   'your money as a balance.\n\n'
   'You verify a Partner''s pickup code before handing over any order.', "now"()),

  ('PARTNER', 1, 'Campus Dash Partner terms (PLACEHOLDER)',
   E'PLACEHOLDER TEXT — NOT LEGAL ADVICE.\n\n'
   'You are an independent student Partner, not an employee of Campus Dash.\n\n'
   'You carry one delivery at a time. You collect orders using the pickup code '
   'shown in your app and complete them using the code the customer gives you.\n\n'
   'Customer contact details are shown only while you are carrying their order, '
   'and must not be recorded, shared or used for anything else.\n\n'
   'Campus Dash pays Partner earnings weekly.', "now"())
ON CONFLICT ("audience", "version") DO NOTHING;

-- Version 2: the real customer, store and Partner terms, from
-- 20261004000003_terms_version_two.sql. Version 1 stays, because acceptances
-- point at the exact row somebody agreed to.
INSERT INTO "public"."terms_documents" ("audience", "version", "title", "body", "published_at")
values
  ('CUSTOMER', 2, 'Campus Dash customer terms',
   E'These terms apply when you order through Campus Dash. Campus Dash connects you with independent stores around Academic City University and, if you ask, with a Campus Dash Partner who brings your order to you.\n\n'
   '## Your account\n'
   'Customer accounts are for Academic City students and staff. You sign in with a code sent to your @acity.edu.gh address. Keep your details accurate, especially your phone number: it is how a Partner reaches you when they arrive.\n'
   'One person, one account. You may also run a store or become a Partner on the same account.\n\n'
   '## Ordering and prices\n'
   'Stores set their own prices and decide what is available. At checkout you choose to collect the order yourself or to have a Campus Dash Partner bring it to a campus location you pick from the list.\n'
   'Before you pay you see the full price:\n'
   '- the food, at the store''s price\n'
   '- a Campus Dash service fee, shown as its own line\n'
   '- the Campus Dash Partner fee, only if you choose a Partner\n'
   'What you see at checkout is what you are charged. A later price change never changes an order you have already placed.\n\n'
   '## Payment\n'
   'You pay once, through our payment provider, before the store sees your order. An order is only confirmed when the payment provider confirms the payment to us. Returning to Campus Dash from the payment page is not, on its own, confirmation.\n'
   'Until you pay, you can abandon an order from its page. Nothing is charged for an order you abandon.\n\n'
   '## Meal scans\n'
   'If a store accepts meal scans, you can pay for eligible items with your campus meal scan. The scan is settled between you and the university, not by Campus Dash. You pay Campus Dash a flat service fee, a pack fee when a pack is added, and the Partner fee if you choose a Partner. A pack is optional when you collect and included when a Partner brings your order.\n'
   'The store checks your scan before preparing your food. If the store does not accept it, Campus Dash reviews the order before anything else happens.\n'
   'Upload only a scan that belongs to you. It is visible to you, the store preparing the order, the Partner carrying it (while they carry it) and Campus Dash administrators.\n\n'
   '## Collecting and receiving your order\n'
   'When you collect, the store gives you a 4-digit code at the counter. Enter it in Campus Dash to confirm you have your order.\n'
   'When a Partner brings your order, Campus Dash shows you a 4-digit code. Read it to your Partner only once you have your order. Never share it before then.\n'
   'Be at the location you chose and reachable on your phone. If a Partner cannot reach you after waiting, they may record that you were not there, and Campus Dash will review what happens next.\n\n'
   '## Cancellations and refunds\n'
   'Once your payment succeeds, the store starts on your order. You cannot cancel a paid order, and it is not refunded because you changed your mind.\n'
   'A refund may apply when a paid order cannot be fulfilled, for example:\n'
   '- the store cannot make your order\n'
   '- your order never reached the store because of a problem on our side\n'
   '- you were charged more than once for the same order\n'
   'Refunds are not automatic. Campus Dash reviews each case and, where a refund applies, returns the amount you paid for that order to your original payment method.\n'
   'If something is wrong or missing, or a delivery did not happen as it should, report it from the order or contact us. Reports are reviewed by a person.\n\n'
   '## Respect\n'
   'Partners are students and staff helping the campus community. Treat them, and the people working at stores, with respect. Campus Dash may suspend accounts that abuse the service or the people in it.\n\n'
   '## Your information\n'
   'A store sees what you ordered, never where it is going or your phone number. Your Partner sees your first name, destination and phone number only while they are carrying your order. Nobody sees your surname.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   "now"()),

  ('VENDOR', 2, 'Campus Dash store terms',
   E'These terms apply when you run a store on Campus Dash. Your store stays your business: Campus Dash brings you orders that are already paid for and, when a customer asks, a Campus Dash Partner to carry them.\n\n'
   '## Your account and approval\n'
   'You sign in with a code sent to your phone number. Keep that number working. It is how you sign in and how we reach you.\n'
   'A Campus Dash administrator reviews every store before it goes live, and may pause or suspend a store that does not keep to these terms.\n\n'
   '## Your store and menu\n'
   'You set your prices and choose what is available. Keep your menu accurate: mark items sold out when they are, and close the store when you are not taking orders.\n'
   'Your store photos must be your own, and must show your store or what you sell.\n'
   'You are responsible for the food and goods you sell, for preparing them safely, and for any licence or permission your business needs.\n\n'
   '## Orders\n'
   'You only ever receive orders that have been paid for. Start preparing when an order arrives, and press Ready for pickup only when it is ready.\n'
   'When somebody comes to collect, read them the 4-digit code shown on the order. Do not hand an order over to anyone who has not been given that code by you, whether they are the customer or a Campus Dash Partner.\n'
   'If you cannot fulfil a paid order, tell Campus Dash straight away.\n\n'
   '## Meal scans\n'
   'If your store accepts meal scans, you are the one who checks each scan before preparing the food, and you only accept scans you would accept at your counter. Campus Dash does not verify scans with the university.\n'
   'The food on a scan order is settled between the student and the university, not by Campus Dash. When a pack is included, the pack fee is yours and you pack the order in it.\n\n'
   '## Getting paid\n'
   'You receive the full price of the food you sell through Campus Dash, and the pack fee on scan orders that include a pack. Campus Dash does not take a commission from your prices. The customer pays the Campus Dash service fee and any Partner fee on top.\n'
   'Payments reach you by mobile money, either as the customer pays or in a regular settlement run, depending on how your payout account is set up. Keep your payout details accurate.\n'
   'If an order is refunded because it could not be fulfilled, you are not owed that order, and an amount already paid to you for it may be recovered.\n\n'
   '## Customer information\n'
   'You see what was ordered. You do not see where an order is going or the customer''s phone number. Do not try to collect customers'' personal details through Campus Dash orders.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   "now"()),

  ('PARTNER', 2, 'Campus Dash Partner terms',
   E'These terms apply when you carry orders as a Campus Dash Partner. Partners are students and staff who help the campus community and earn for doing it.\n\n'
   '## Becoming a Partner\n'
   'You apply from your customer account with your student or staff ID. A Campus Dash administrator reviews every application. Being a Partner is part of your one Campus Dash account, not a separate one.\n'
   'You are an independent Partner, not an employee of Campus Dash or of any store. You choose when you are available and which orders you accept.\n\n'
   '## Accepting and carrying orders\n'
   'Before you accept, you see the store, the building and floor the order is going to, and what you earn. After you accept, you also see the room, the customer''s first name, any note they left, and their phone number.\n'
   'You may carry more than one order at a time, up to the limit Campus Dash sets.\n'
   'You cannot carry your own order, or an order from a store you own.\n'
   'At the store, enter the 4-digit code the store reads out to you. At the destination, enter the 4-digit code the customer reads out to you. Never ask a customer for their code before they have their order.\n'
   'If the customer is not there, wait for the time shown in the app and try to call them before recording that they were not there.\n'
   'If you cannot complete an order you have accepted, release it in the app as early as you can so another Partner can take it.\n\n'
   '## Customer information\n'
   'A customer''s phone number is shown to you only while you are carrying their order, and only so you can reach them about it. Do not save it, share it, or use it for anything else.\n\n'
   '## Earnings\n'
   'You earn the Campus Dash Partner fee, currently GH₵5, for each order you complete.\n'
   'Earnings are paid weekly to your mobile money account once your available balance reaches GH₵20. A smaller balance carries forward to the next week. Keep your payout details accurate.\n\n'
   '## Conduct\n'
   'Handle every order with care, keep food sealed, and treat customers and store staff with respect. Customers may rate completed deliveries. Campus Dash may suspend a Partner who does not keep to these terms.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish a new version and ask you to accept it. The version you accepted, and when, is recorded.',
   "now"())
ON CONFLICT ("audience", "version") DO NOTHING;

-- Version 3: the same three documents, brought up to date with the product —
-- Meal Scan handling, additional information, and when Paystack pays a store.
-- From 20261007000002_terms_version_three.sql.
insert into public.terms_documents (audience, version, title, body, published_at)
values
  ('CUSTOMER', 3, 'Campus Dash customer terms',
   E'Campus Dash lets you order from stores around Academic City University and either collect your order yourself or have a Campus Dash Partner bring it to you on campus. These terms apply whenever you order.\n\n'
   '## Your account\n'
   'Customer accounts are for Academic City students and staff. You sign in with a code sent to your @acity.edu.gh address. One person, one account. The same account can also carry orders as a Partner or run a store.\n'
   'Keep your phone number accurate. It is how a Partner reaches you when they arrive.\n\n'
   '## Ordering\n'
   'Stores set their own prices and decide what is available. You order from one store at a time. At checkout you choose to collect it yourself or to have a Campus Dash Partner bring it to you, and you see the full price before you pay.\n'
   'If a Partner is bringing it, you choose where on campus from the list: a building, a floor, or a room if you want to be that precise. There is one optional box for additional information, such as "extra napkins" or "call when you arrive". The store and your Partner can read it.\n\n'
   '## Prices and fees\n'
   'Your total can include:\n'
   '- the food, at the store''s price\n'
   '- a Campus Dash service fee, shown as its own line\n'
   '- the Campus Dash Partner fee, only if a Partner brings your order\n'
   '- a pack fee on a Meal Scan order, when a pack is included\n'
   'What you see at checkout is what you are charged. A later price change never changes an order you have already placed.\n\n'
   '## Payment\n'
   'You pay once, through Paystack, before the store sees your order. An order is only confirmed when Paystack confirms the payment to us. Coming back to Campus Dash from the payment page does not, on its own, confirm anything.\n'
   'Until you pay, you can change how you get it or abandon the order. Nothing is charged for an order you abandon.\n\n'
   '## Meal Scan orders\n'
   'If a store accepts Meal Scans, you can pay for eligible items with your campus meal scan instead. The food is settled between you and the university, not by Campus Dash. You pay Campus Dash a flat service fee, the pack fee when a pack is included, and the Partner fee if a Partner brings it. A pack is optional when you collect and always included with a Partner.\n'
   'The store checks your scan before preparing anything. If the store cannot accept it, the order is cancelled and you can place a new one. Upload only a scan that belongs to you. It is seen by you, the store and Campus Dash administrators, never by a Partner.\n\n'
   '## Preparation and collection\n'
   'Once your payment is confirmed, the store starts on your order. There is no separate step where the store accepts it. When the food is ready, the store marks it ready and you are told.\n'
   'When you collect, the store reads you a 4-digit code at the counter. Enter it in Campus Dash to confirm you have your order.\n'
   'When a Partner brings it, Campus Dash shows you a 4-digit code. Read it to your Partner only once your order is in your hands.\n'
   'Too many wrong codes locks the code for a few minutes, for everybody, to stop guessing.\n\n'
   '## Where you are\n'
   'The place you choose is where your Partner comes. It stays as you chose it: Campus Dash does not track your location. If you move, call your Partner. Their number is on your order while they are carrying it.\n'
   'If your Partner cannot reach you after waiting, they may record that you were not there, and Campus Dash will review what happens next.\n\n'
   '## Cancellations and refunds\n'
   'You cannot cancel an order once it is paid, and it is not refunded because you changed your mind.\n'
   'A refund may apply when a paid order cannot be fulfilled, for example:\n'
   '- the store cannot make your order\n'
   '- your order never reached the store because of a problem on our side\n'
   '- you were charged more than once for the same order\n'
   'Refunds are not automatic. A person at Campus Dash reviews each case and, where a refund applies, returns what you paid for that order to your original payment method.\n'
   'If something is wrong or missing, report it from the order or call us.\n\n'
   '## What Campus Dash can and cannot do\n'
   'Campus Dash works on campus only. Stores open and close when they choose, and Partners are students and staff who are available when they are. A Partner is never guaranteed: if none is found in time, you can collect your order yourself.\n\n'
   '## Respect\n'
   'Partners are students and staff helping the campus community. Treat them, and the people at every store, with respect. Campus Dash may restrict or suspend an account that abuses the service or the people in it.\n\n'
   '## Your information\n'
   'A store sees what you ordered and your additional information. It never sees where your order is going or your phone number. Your Partner sees your first name, where you chose, your additional information and your phone number, and only while they are carrying your order. Nobody is shown your surname.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now()),

  ('VENDOR', 3, 'Campus Dash store terms',
   E'Your store stays your business. Campus Dash brings you orders that are already paid for and, when a customer asks, a Campus Dash Partner to carry them. These terms apply when you run a store on Campus Dash.\n\n'
   '## Your account and approval\n'
   'You sign in with a code sent to your phone number. Keep that number working. One account runs one store.\n'
   'A Campus Dash administrator reviews every store before it goes live, and may pause, restrict or suspend a store that does not keep to these terms.\n\n'
   '## Your store and menu\n'
   'You set your prices and choose what is available. Keep your menu accurate, mark items sold out when they are, and close the store when you are not taking orders.\n'
   'Your store photos must be your own and must show your store or what you sell.\n'
   'You are responsible for the food and goods you sell, for preparing them safely, and for any licence or permission your business needs.\n\n'
   '## Orders\n'
   'You only ever receive orders that have been paid for, so there is nothing to accept or reject. Start preparing when an order arrives, and mark it ready only when it is ready.\n'
   'Read any additional information the customer left. It is usually about the food.\n'
   'When somebody comes to collect, read them the 4-digit code shown on the order, whether they are the customer or a Campus Dash Partner. Hand the order over only once they have entered it.\n'
   'If you cannot fulfil a paid order, tell Campus Dash straight away.\n\n'
   '## Meal Scan orders\n'
   'If your store accepts Meal Scans, you check each scan before preparing the food, and you only accept a scan you would accept at your counter. If you cannot accept it, say why: the order is cancelled. Campus Dash does not verify scans with the university.\n'
   'The food on a Meal Scan order is settled between the student and the university, not by Campus Dash. When a pack is included, the pack fee is yours and you pack the order in it.\n\n'
   '## Getting paid\n'
   'You receive the full price of the food you sell through Campus Dash, and the pack fee on Meal Scan orders that include one. Campus Dash takes no commission from your prices. The customer pays the Campus Dash service fee and any Partner fee on top.\n'
   'When you add your mobile money details under Getting paid, Campus Dash registers them with Paystack. From then on your share of each order is set aside for you by Paystack as the customer pays, and Paystack pays it into your account on the next working day. Weekends and Ghana public holidays are not working days, so sales from Friday to Sunday usually arrive on Monday morning. Campus Dash does not hold or send this money.\n'
   'Until your details are registered, Campus Dash settles what you are owed directly. Keep your payout details accurate.\n'
   'If an order is refunded because it could not be fulfilled, you are not owed that order, and an amount already paid to you for it may be recovered.\n\n'
   '## Customer information\n'
   'You see what was ordered and any additional information. You do not see where an order is going or the customer''s phone number. Do not try to collect customers'' personal details through Campus Dash.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now()),

  ('PARTNER', 3, 'Campus Dash Partner terms',
   E'Campus Dash Partners are students and staff who carry orders across campus, help the campus community and earn for doing it. These terms apply when you carry orders as a Partner.\n\n'
   '## Becoming a Partner\n'
   'You apply from your customer account with a photo of your student or staff ID. A Campus Dash administrator reviews every application. Being a Partner is part of your one Campus Dash account, not a separate one.\n'
   'You are an independent Partner, not an employee of Campus Dash or of any store. You choose when you are available and which orders you take.\n\n'
   '## Taking and carrying orders\n'
   'Before you take an order, you see the store, the building and floor it is going to, and what you earn. Once you take it, you also see the exact place the customer chose, their first name, any additional information they left, and their phone number.\n'
   'You may carry more than one order at a time, up to the limit Campus Dash sets. You cannot carry your own order, or an order from a store you own.\n'
   'Collect only once the store has marked the order ready. At the store, enter the 4-digit code the store reads out to you. At the destination, enter the 4-digit code the customer reads out to you. Never ask a customer for their code before they have their order.\n'
   'If the customer has moved, call them. If you cannot find them, wait for the time shown in the app and try to call before recording that they were not there.\n'
   'If you cannot finish an order you have taken, release it in the app as early as you can so another Partner can take it.\n\n'
   '## Customer information\n'
   'A customer''s phone number is shown to you only while you are carrying their order, and only so you can reach them about it. Do not save it, share it or use it for anything else. You never see a customer''s Meal Scan.\n\n'
   '## Earnings\n'
   'You earn the Campus Dash Partner fee, currently GH₵5, for each order you complete.\n'
   'Earnings are paid weekly to your mobile money account once your available balance reaches GH₵20. A smaller balance carries forward to the next week. Keep your payout details accurate.\n\n'
   '## Conduct\n'
   'Handle every order with care, keep food sealed, and treat customers and store staff with respect. Customers may rate completed deliveries. Campus Dash may restrict or suspend a Partner who does not keep to these terms.\n\n'
   '## Contact\n'
   'Call Campus Dash on 0531275217 or 0594667183.\n\n'
   '## Changes\n'
   'When these terms change, we publish the new terms and ask you to accept them. What you accepted, and when, is recorded.',
   now())
on conflict (audience, version) do nothing;


-- ============================================================================
-- INSTALL-TIME ASSERTIONS
-- ============================================================================
-- The grant model above is the security boundary, and a silent failure in it
-- looks exactly like success. So the install checks its own work and refuses to
-- report a clean bootstrap if the most important invariants did not hold.

SET client_min_messages = notice;

DO $assert$
DECLARE
  v_writes         integer;
  v_unprotected    integer;
  v_default_tables integer;
  v_default_funcs  integer;
BEGIN
  SELECT count(*) INTO v_writes
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_writes > 0 THEN
    RAISE EXCEPTION 'schema install failed: % client write grant(s) on public tables', v_writes;
  END IF;

  SELECT count(*) INTO v_unprotected
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
  IF v_unprotected > 0 THEN
    RAISE EXCEPTION 'schema install failed: % table(s) in public without RLS', v_unprotected;
  END IF;

  SELECT count(*) INTO v_default_tables
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    JOIN pg_roles r ON r.oid = d.defaclrole
   CROSS JOIN LATERAL unnest(d.defaclacl) AS e(entry)
   WHERE n.nspname = 'public' AND d.defaclobjtype = 'r' AND r.rolname = current_user
     AND (e.entry::text LIKE '=%' OR e.entry::text LIKE 'anon=%' OR e.entry::text LIKE 'authenticated=%');
  IF v_default_tables > 0 THEN
    RAISE EXCEPTION 'schema install failed: new tables would be client-writable by default';
  END IF;

  SELECT count(*) INTO v_default_funcs
    FROM pg_default_acl d
    JOIN pg_namespace n ON n.oid = d.defaclnamespace
    JOIN pg_roles r ON r.oid = d.defaclrole
   CROSS JOIN LATERAL unnest(d.defaclacl) AS e(entry)
   WHERE n.nspname = 'public' AND d.defaclobjtype = 'f' AND r.rolname = current_user
     AND (e.entry::text LIKE '=X/%' OR e.entry::text LIKE 'anon=X/%' OR e.entry::text LIKE 'authenticated=X/%');
  IF v_default_funcs > 0 THEN
    RAISE EXCEPTION 'schema install failed: new functions would be client-callable by default';
  END IF;

  RAISE NOTICE 'Campus Dash schema installed: RLS on every table, no client DML, deny-by-default.';
END
$assert$;
