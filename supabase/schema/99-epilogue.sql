

-- ============================================================================
-- OBJECTS OUTSIDE THE public SCHEMA
-- ============================================================================
-- pg_dump --schema public cannot see these, and all three are load-bearing.


-- ---------------------------------------------------------------------------
-- auth.users → public.users provisioning
-- ---------------------------------------------------------------------------
-- A profile row is created by a trigger the moment a phone number is
-- CONFIRMED, never when a code is merely requested. GoTrue inserts the
-- auth.users row as soon as someone asks for an OTP, before the number is
-- proven; provisioning then would let anyone claim a phone number they do not
-- own just by asking for a code.
--
-- Doing it in a trigger rather than in application code means an account can
-- never exist without a profile: there is no window, and no code path that
-- forgets. Both trigger functions live in `public` (above) and are granted to
-- nobody.

DROP TRIGGER IF EXISTS "on_auth_user_created" ON "auth"."users";
CREATE TRIGGER "on_auth_user_created"
  AFTER INSERT ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_auth_user"();

DROP TRIGGER IF EXISTS "on_auth_user_phone_confirmed" ON "auth"."users";
CREATE TRIGGER "on_auth_user_phone_confirmed"
  AFTER UPDATE OF "phone_confirmed_at" ON "auth"."users"
  FOR EACH ROW EXECUTE FUNCTION "public"."handle_auth_user_phone_confirmed"();


-- ---------------------------------------------------------------------------
-- Private storage for Partner verification documents
-- ---------------------------------------------------------------------------
-- Holds the student ID photograph and the live face photograph an admin
-- compares during approval.
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
-- Terms documents — PLACEHOLDER TEXT
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
