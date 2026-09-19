-- ============================================================================
-- Campus Dash — canonical database schema
-- ============================================================================
--                          *** GENERATED FILE ***
--
-- Do not edit by hand. Change supabase/migrations/, then:
--
--     npm run db:reset && npm run db:schema
--
-- WHAT THIS FILE IS
-- -----------------
-- The complete, final state of the Campus Dash database, installable from
-- empty in one pass. It is what a new environment — the hosted Supabase
-- project included — is bootstrapped from.
--
-- It is NOT the migrations pasted together. supabase/migrations/ is the
-- history: it adds a column a later phase drops, defines a function a later
-- phase replaces, and grants privileges a later phase takes back. Replaying
-- that installs the mistakes alongside the corrections. This file is derived
-- from a database that has applied every migration in order, so every drop,
-- replacement and tightened grant is already resolved.
--
-- The migrations are not going anywhere. They stay in git as the record of how
-- each rule came to exist, and they remain the place new changes are written.
--
-- WHAT IS AND IS NOT IN HERE
-- --------------------------
--   In:  extensions, default privileges, enums, tables, constraints, indexes,
--        partial unique indexes, sequences, functions, triggers, RLS,
--        policies, grants, revokes, the auth.users provisioning triggers, the
--        private storage bucket, the pg_cron schedules, and the reference data
--        the product cannot start without (the pricing_config singleton and
--        the placeholder terms documents).
--
--   Out: development actors, test vendors, test menus and test locations.
--        Those live in supabase/seed.sql and are never installed anywhere but
--        a development database.
--
-- SECURITY MODEL, IN ONE PARAGRAPH
-- --------------------------------
-- Clients hold SELECT only. There is no INSERT, UPDATE or DELETE grant for
-- `anon` or `authenticated` on any table. Every write goes through a SECURITY
-- DEFINER function that re-derives authorisation from auth.uid(), and every
-- race-sensitive transition is a conditional UPDATE backed by a partial unique
-- index. Frontend routing is not access control; this file is.
-- ============================================================================

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


-- ============================================================================
-- 0. EXTENSIONS
-- ============================================================================
-- Supabase pre-installs pgcrypto and pg_cron on both the local stack and a
-- hosted project, so these are almost always no-ops. They are stated anyway so
-- the file is honest about what it depends on.
--
--   pgcrypto  — extensions.gen_random_bytes(), the CSPRNG behind pickup and
--               delivery codes. A code guessed is an order stolen, so this is
--               never random().
--   pg_cron   — the expiry sweeps. They run INSIDE the database: there is no
--               HTTP call to miss and no deploy that silently drops the
--               schedule.

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "pg_cron";


-- ============================================================================
-- 1. DEFAULT PRIVILEGES  —  MUST RUN BEFORE ANYTHING IS CREATED
-- ============================================================================
-- This is the single most important block in the file, and the easiest to get
-- wrong, because getting it wrong fails silently.
--
-- Supabase ships default ACLs that grant `anon` and `authenticated` full DML on
-- new tables and EXECUTE on new functions in this schema. Postgres additionally
-- grants EXECUTE on a new function to PUBLIC. So without these revokes, every
-- object created below is born reachable by anonymous visitors — and for a
-- SECURITY DEFINER function that means anyone on the internet could call
-- confirm_payment() and mark their own order paid.
--
-- Revoking PUBLIC alone is NOT enough: the Supabase defaults name anon and
-- authenticated explicitly, and a revoke from PUBLIC does not touch a grant
-- made to a named role.
--
-- These run before the first CREATE precisely so that no object ever exists in
-- the permissive state, even momentarily. The migrations arrived here the hard
-- way, retroactively, twice — see 20260902000003 and 20260905000005. Both
-- holes were found by tests/schema.test.js, not by anyone noticing.

ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC, "anon", "authenticated";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, "anon", "authenticated";




CREATE TYPE "public"."allocation_status" AS ENUM (
    'PENDING',
    'ELIGIBLE',
    'SETTLING',
    'SETTLED',
    'CANCELLED'
);


ALTER TYPE "public"."allocation_status" OWNER TO "postgres";


CREATE TYPE "public"."campus_affiliation" AS ENUM (
    'STUDENT',
    'STAFF'
);


ALTER TYPE "public"."campus_affiliation" OWNER TO "postgres";


CREATE TYPE "public"."customer_gender" AS ENUM (
    'MALE',
    'FEMALE'
);


ALTER TYPE "public"."customer_gender" OWNER TO "postgres";


CREATE TYPE "public"."delivery_status" AS ENUM (
    'NONE',
    'SEARCHING',
    'ASSIGNED',
    'PICKED_UP',
    'DELIVERED',
    'FAILED_NO_PARTNER',
    'FAILED_CUSTOMER_ABSENT'
);


ALTER TYPE "public"."delivery_status" OWNER TO "postgres";


CREATE TYPE "public"."fulfilment_type" AS ENUM (
    'PICKUP',
    'DELIVERY'
);


ALTER TYPE "public"."fulfilment_type" OWNER TO "postgres";


CREATE TYPE "public"."location_kind" AS ENUM (
    'CAMPUS',
    'BLOCK',
    'FLOOR',
    'ROOM',
    'FIELD',
    'COMMON_AREA'
);


ALTER TYPE "public"."location_kind" OWNER TO "postgres";


CREATE TYPE "public"."order_status" AS ENUM (
    'DRAFT',
    'SUBMITTED',
    'ACCEPTED',
    'PREPARING',
    'READY',
    'COMPLETED',
    'REJECTED',
    'EXPIRED',
    'CANCELLED',
    'CANCELLED_BY_VENDOR'
);


ALTER TYPE "public"."order_status" OWNER TO "postgres";


CREATE TYPE "public"."order_type" AS ENUM (
    'FOOD',
    'SCAN'
);


ALTER TYPE "public"."order_type" OWNER TO "postgres";


COMMENT ON TYPE "public"."order_type" IS 'FOOD: Campus Dash sells the food. SCAN: the food is already paid for through the campus meal system and Campus Dash sells only the errand.';


CREATE TYPE "public"."partner_application_status" AS ENUM (
    'NOT_APPLIED',
    'PENDING_REVIEW',
    'APPROVED',
    'REJECTED',
    'SUSPENDED'
);


ALTER TYPE "public"."partner_application_status" OWNER TO "postgres";


CREATE TYPE "public"."payee_type" AS ENUM (
    'VENDOR',
    'PLATFORM',
    'PARTNER'
);


ALTER TYPE "public"."payee_type" OWNER TO "postgres";


CREATE TYPE "public"."payment_status" AS ENUM (
    'UNPAID',
    'PENDING',
    'PAID',
    'FAILED',
    'REFUND_PENDING',
    'REFUNDED'
);


ALTER TYPE "public"."payment_status" OWNER TO "postgres";


CREATE TYPE "public"."payment_txn_status" AS ENUM (
    'PENDING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
);


ALTER TYPE "public"."payment_txn_status" OWNER TO "postgres";


CREATE TYPE "public"."payout_status" AS ENUM (
    'PENDING',
    'PROCESSING',
    'PAID',
    'FAILED',
    'CANCELLED',
    'REVERSED'
);


ALTER TYPE "public"."payout_status" OWNER TO "postgres";


CREATE TYPE "public"."scan_status" AS ENUM (
    'UPLOADED',
    'RELEASED',
    'REDEEMED',
    'REFUSED'
);


ALTER TYPE "public"."scan_status" OWNER TO "postgres";


COMMENT ON TYPE "public"."scan_status" IS 'The scan artifact''s own lifecycle. Independent of order_status, payment_status and delivery_status — never merge them.';


CREATE TYPE "public"."settlement_run_status" AS ENUM (
    'OPEN',
    'PROCESSING',
    'COMPLETED',
    'FAILED'
);


ALTER TYPE "public"."settlement_run_status" OWNER TO "postgres";


CREATE TYPE "public"."terms_audience" AS ENUM (
    'CUSTOMER',
    'VENDOR',
    'PARTNER'
);


ALTER TYPE "public"."terms_audience" OWNER TO "postgres";


CREATE TYPE "public"."transition_result" AS (
	"success" boolean,
	"reason" "text"
);


ALTER TYPE "public"."transition_result" OWNER TO "postgres";


CREATE TYPE "public"."vendor_status" AS ENUM (
    'DRAFT',
    'PENDING_APPROVAL',
    'ACTIVE',
    'SUSPENDED',
    'REJECTED'
);


ALTER TYPE "public"."vendor_status" OWNER TO "postgres";


CREATE TYPE "public"."webhook_event_status" AS ENUM (
    'RECEIVED',
    'PROCESSED',
    'IGNORED',
    'INVALID_SIGNATURE',
    'FAILED'
);


ALTER TYPE "public"."webhook_event_status" OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."terms_acceptances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "terms_id" "uuid" NOT NULL,
    "audience" "public"."terms_audience" NOT NULL,
    "version" integer NOT NULL,
    "accepted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."terms_acceptances" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_terms"("p_terms_id" "uuid") RETURNS "public"."terms_acceptances"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_doc        public.terms_documents%rowtype;
  v_acceptance public.terms_acceptances%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null then
    raise exception 'those terms are not available to accept' using errcode = 'no_data_found';
  end if;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (auth.uid(), v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version) do update set accepted_at = public.terms_acceptances.accepted_at
  returning * into v_acceptance;

  return v_acceptance;
end;
$$;


ALTER FUNCTION "public"."accept_terms"("p_terms_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."active_vendor_categories"() RETURNS TABLE("id" "uuid", "slug" "text", "name" "text", "sort_order" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select k.id, k.slug, k.name, k.sort_order
    from public.vendor_categories k
   where k.is_active
   order by k.sort_order, k.name;
$$;


ALTER FUNCTION "public"."active_vendor_categories"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_order_number"() RETURNS "text"
    LANGUAGE "sql"
    AS $$
  select 'CD-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;


ALTER FUNCTION "public"."next_order_number"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_number" "text" DEFAULT "public"."next_order_number"() NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "partner_id" "uuid",
    "fulfilment_type" "public"."fulfilment_type",
    "order_status" "public"."order_status" DEFAULT 'DRAFT'::"public"."order_status" NOT NULL,
    "payment_status" "public"."payment_status" DEFAULT 'UNPAID'::"public"."payment_status" NOT NULL,
    "delivery_status" "public"."delivery_status" DEFAULT 'NONE'::"public"."delivery_status" NOT NULL,
    "destination_location_id" "uuid",
    "destination_note" "text",
    "destination_zone_id" "uuid",
    "subtotal_pesewas" bigint DEFAULT 0 NOT NULL,
    "service_fee_pesewas" bigint DEFAULT 0 NOT NULL,
    "delivery_fee_pesewas" bigint DEFAULT 0 NOT NULL,
    "partner_earnings_pesewas" bigint DEFAULT 0 NOT NULL,
    "total_pesewas" bigint DEFAULT 0 NOT NULL,
    "submitted_at" timestamp with time zone,
    "accept_deadline_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "preparing_at" timestamp with time zone,
    "ready_at" timestamp with time zone,
    "search_started_at" timestamp with time zone,
    "search_deadline_at" timestamp with time zone,
    "assigned_at" timestamp with time zone,
    "picked_up_at" timestamp with time zone,
    "delivered_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "cancellation_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_absent_reported_at" timestamp with time zone,
    "disputed_at" timestamp with time zone,
    "dispute_reason" "text",
    "dispute_resolved_at" timestamp with time zone,
    "order_type" "public"."order_type" DEFAULT 'FOOD'::"public"."order_type" NOT NULL,
    "scan_status" "public"."scan_status",
    "partner_slot" smallint,
    "pack_fee_pesewas" bigint DEFAULT 0 NOT NULL,
    "order_day" "date",
    "vendor_order_no" integer,
    "vendor_completed_at" timestamp with time zone,
    "dispatch_generation" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "orders_delivery_fee_pesewas_check" CHECK (("delivery_fee_pesewas" >= 0)),
    CONSTRAINT "orders_delivery_needs_destination" CHECK ((("fulfilment_type" <> 'DELIVERY'::"public"."fulfilment_type") OR ("destination_location_id" IS NOT NULL))),
    CONSTRAINT "orders_pack_fee_check" CHECK (("pack_fee_pesewas" >= 0)),
    CONSTRAINT "orders_pack_fee_scan_only" CHECK ((("order_type" = 'SCAN'::"public"."order_type") OR ("pack_fee_pesewas" = 0))),
    CONSTRAINT "orders_partner_earnings_pesewas_check" CHECK (("partner_earnings_pesewas" >= 0)),
    CONSTRAINT "orders_partner_earnings_within_fee" CHECK (("partner_earnings_pesewas" <= "delivery_fee_pesewas")),
    CONSTRAINT "orders_partner_matches_delivery_state" CHECK ((("partner_id" IS NOT NULL) = ("delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status", 'DELIVERED'::"public"."delivery_status", 'FAILED_CUSTOMER_ABSENT'::"public"."delivery_status"])))),
    CONSTRAINT "orders_partner_slot_range" CHECK ((("partner_slot" IS NULL) OR (("partner_slot" >= 1) AND ("partner_slot" <= 10)))),
    CONSTRAINT "orders_pickup_has_no_delivery" CHECK ((("fulfilment_type" <> 'PICKUP'::"public"."fulfilment_type") OR (("delivery_fee_pesewas" = 0) AND ("partner_earnings_pesewas" = 0) AND ("delivery_status" = 'NONE'::"public"."delivery_status") AND ("partner_id" IS NULL)))),
    CONSTRAINT "orders_scan_has_no_food_value" CHECK ((("order_type" <> 'SCAN'::"public"."order_type") OR ("subtotal_pesewas" = 0))),
    CONSTRAINT "orders_scan_status_presence" CHECK ((("order_type" = 'SCAN'::"public"."order_type") = ("scan_status" IS NOT NULL))),
    CONSTRAINT "orders_service_fee_pesewas_check" CHECK (("service_fee_pesewas" >= 0)),
    CONSTRAINT "orders_subtotal_pesewas_check" CHECK (("subtotal_pesewas" >= 0)),
    CONSTRAINT "orders_total_is_sum" CHECK (("total_pesewas" = ((("subtotal_pesewas" + "service_fee_pesewas") + "delivery_fee_pesewas") + "pack_fee_pesewas"))),
    CONSTRAINT "orders_total_pesewas_check" CHECK (("total_pesewas" >= 0))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."orders"."fulfilment_type" IS 'PICKUP, DELIVERY, or NULL meaning the customer has not chosen yet. NULL is a state, not a missing value: an order reaches it at submission and leaves it when customer_choose_fulfilment() runs, after the vendor has accepted. create_payment_intent() refuses an order still in it, so nothing is ever charged for a delivery nobody asked for.';


COMMENT ON COLUMN "public"."orders"."order_type" IS 'FOOD or SCAN. Decides pricing, whether the vendor participates, and whether a vendor allocation is written.';


COMMENT ON COLUMN "public"."orders"."partner_slot" IS 'Which of a Partner''s concurrent delivery slots this order occupies. Unique per Partner while the delivery is active — that index IS the capacity limit; pricing_config.max_active_deliveries_per_partner decides how many slots exist. Retained after completion for the audit trail; the index ignores it there, so a finished delivery never blocks a new one.';


COMMENT ON COLUMN "public"."orders"."pack_fee_pesewas" IS 'The pack fee charged on this order, snapshotted at submission. The STORE''S money: it is allocated to the vendor with the rest of the store''s share (subtotal + pack). Always 0 on a FOOD order — orders_pack_fee_scan_only says so — because a food order arrives in the store''s own packaging and is charged nothing for it.';


COMMENT ON COLUMN "public"."orders"."order_day" IS 'The calendar day the queue number belongs to. Kept as a column rather than derived from created_at so the number and the day it is unique within can never disagree.';


COMMENT ON COLUMN "public"."orders"."vendor_order_no" IS 'The store''s queue number for that day: 1, 2, 3 … shown as 001. Unique per (vendor, day). NULL on a SCAN errand, which the store never sees, and on orders placed before daily numbering existed.';


COMMENT ON COLUMN "public"."orders"."vendor_completed_at" IS 'When the store handed the food over and its part ended — to a collecting customer, or to a Partner. NOT the end of the order: a Partner order is still in flight, and order_status says so. The store''s board buckets on this, so handing a bag to a Partner clears the counter instead of leaving the order sitting there until somebody across campus opens a door.';


COMMENT ON COLUMN "public"."orders"."dispatch_generation" IS 'How many times this order has been put out to Partners. Incremented whenever a search reopens — a cancellation, an admin reassignment. It exists to be part of the notification dedupe key, so re-broadcasting reaches Partners who were already told once and did not take it; without it the second broadcast silently reached nobody.';


CREATE OR REPLACE FUNCTION "public"."admin_cancel_order"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;
  if v_before.order_status in ('COMPLETED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED') then
    raise exception 'order is already in terminal state %', v_before.order_status
      using errcode = 'check_violation';
  end if;

  update public.orders
     set order_status = 'CANCELLED',
         cancelled_at = now(),
         cancellation_reason = p_reason,
         -- Release any Partner so they are free to take other work.
         partner_id = null,
         delivery_status = case
           when delivery_status = 'NONE' then 'NONE'::public.delivery_status
           else 'SEARCHING'::public.delivery_status end
   where id = p_order_id
  returning * into v_after;

  -- Money already collected is marked for refund, never silently kept.
  if v_before.payment_status = 'PAID' then
    update public.orders set payment_status = 'REFUND_PENDING' where id = p_order_id;
    update public.allocations set status = 'CANCELLED'
     where order_id = p_order_id and status in ('PENDING', 'ELIGIBLE');
  end if;

  perform public.log_order_event(p_order_id, 'ADMIN_CANCEL', true, 'ADMIN',
    'order_status', v_before.order_status::text, 'CANCELLED', p_reason);
  perform public.log_admin_action('ORDER_CANCEL', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_cancel_order"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."partner_profiles" (
    "user_id" "uuid" NOT NULL,
    "status" "public"."partner_application_status" DEFAULT 'PENDING_REVIEW'::"public"."partner_application_status" NOT NULL,
    "face_image_path" "text",
    "is_available" boolean DEFAULT false NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "review_notes" "text",
    "documents_purge_after" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "student_id_image_path" "text",
    CONSTRAINT "partner_reviewed_consistently" CHECK ((("status" = ANY (ARRAY['APPROVED'::"public"."partner_application_status", 'REJECTED'::"public"."partner_application_status", 'SUSPENDED'::"public"."partner_application_status"])) = (("reviewed_at" IS NOT NULL) AND ("reviewed_by" IS NOT NULL))))
);


ALTER TABLE "public"."partner_profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."partner_profiles"."face_image_path" IS 'PARTNER verification document, in the private partner-documents bucket. Purged after the review retention window — see documents_purge_after and admin_partner_documents_due_for_purge().';


COMMENT ON COLUMN "public"."partner_profiles"."student_id_image_path" IS 'PARTNER verification document — the student ID photograph an administrator compares against face_image_path. Purged with the face photograph after the review retention window.';


CREATE OR REPLACE FUNCTION "public"."admin_clear_partner_documents"("p_user_id" "uuid", "p_reason" "text") RETURNS "public"."partner_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner profile for this user' using errcode = 'no_data_found';
  end if;

  update public.partner_profiles
     set student_id_image_path = null,
         face_image_path       = null,
         documents_purge_after = null
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_DOCUMENTS_PURGED', 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_clear_partner_documents"("p_user_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_complete_order"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  -- delivery_status only becomes DELIVERED when a Partner actually carried it.
  -- An order completed after dispatch failed (the customer collected it, or the
  -- admin resolved it another way) has no Partner, and claiming DELIVERED would
  -- both be untrue and violate orders_partner_matches_delivery_state.
  update public.orders
     set order_status = 'COMPLETED',
         completed_at = now(),
         delivery_status = case
           when fulfilment_type = 'DELIVERY' and partner_id is not null
             then 'DELIVERED'::public.delivery_status
           else delivery_status end,
         delivered_at = case
           when fulfilment_type = 'DELIVERY' and partner_id is not null then now()
           else delivered_at end
   where id = p_order_id and order_status not in ('COMPLETED', 'CANCELLED', 'CANCELLED_BY_VENDOR', 'REJECTED', 'EXPIRED')
  returning * into v_after;

  if not found then
    raise exception 'order cannot be completed from its current state' using errcode = 'check_violation';
  end if;

  -- Only pay a Partner who exists.
  if v_after.fulfilment_type = 'DELIVERY' and v_after.partner_id is not null then
    perform public.settle_partner_earnings(p_order_id);
  end if;

  perform public.log_order_event(p_order_id, 'ADMIN_COMPLETE', true, 'ADMIN',
    'order_status', v_before.order_status::text, 'COMPLETED', p_reason);
  perform public.log_admin_action('ORDER_COMPLETE', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_complete_order"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "parent_id" "uuid",
    "kind" "public"."location_kind" NOT NULL,
    "name" "text" NOT NULL,
    "is_deliverable" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "walk_minutes" integer,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "locations_no_self_parent" CHECK (("id" <> "parent_id")),
    CONSTRAINT "locations_root_is_campus" CHECK ((("parent_id" IS NULL) = ("kind" = 'CAMPUS'::"public"."location_kind"))),
    CONSTRAINT "locations_walk_minutes_check" CHECK (("walk_minutes" >= 0))
);


ALTER TABLE "public"."locations" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_create_location"("p_kind" "public"."location_kind", "p_name" "text", "p_reason" "text", "p_parent_id" "uuid" DEFAULT NULL::"uuid", "p_is_deliverable" boolean DEFAULT false, "p_walk_minutes" integer DEFAULT NULL::integer, "p_sort_order" integer DEFAULT 0) RETURNS "public"."locations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_location public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_kind <> 'CAMPUS' and p_parent_id is null then
    raise exception 'only a CAMPUS may be a root location' using errcode = 'check_violation';
  end if;

  insert into public.locations (parent_id, kind, name, is_deliverable, walk_minutes, sort_order)
  values (p_parent_id, p_kind, btrim(p_name), coalesce(p_is_deliverable, false),
          p_walk_minutes, coalesce(p_sort_order, 0))
  returning * into v_location;

  perform public.log_admin_action(
    'LOCATION_CREATE', 'location', v_location.id, p_reason, null, to_jsonb(v_location)
  );

  return v_location;
end;
$$;


ALTER FUNCTION "public"."admin_create_location"("p_kind" "public"."location_kind", "p_name" "text", "p_reason" "text", "p_parent_id" "uuid", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menu_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price_pesewas" bigint NOT NULL,
    "is_available" boolean DEFAULT true NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "scan_eligible" boolean DEFAULT false NOT NULL,
    "image_path" "text",
    "image_content_type" "text",
    "image_byte_size" bigint,
    "unavailable_reason" "text",
    CONSTRAINT "menu_items_image_complete" CHECK (((("image_path" IS NULL) AND ("image_content_type" IS NULL) AND ("image_byte_size" IS NULL)) OR (("image_path" IS NOT NULL) AND ("image_content_type" IS NOT NULL) AND ("image_byte_size" > 0)))),
    CONSTRAINT "menu_items_price_pesewas_check" CHECK (("price_pesewas" > 0)),
    CONSTRAINT "menu_items_unavailable_reason_shape" CHECK ((("unavailable_reason" IS NULL) OR ("unavailable_reason" = ANY (ARRAY['SOLD_OUT'::"text", 'WITHDRAWN'::"text"]))))
);


ALTER TABLE "public"."menu_items" OWNER TO "postgres";


COMMENT ON COLUMN "public"."menu_items"."scan_eligible" IS 'Whether this item may be paid for with a campus meal scan. Meaningless unless vendors.can_accept_scans is also true: the store opts in, then chooses which items. Default false, because being wrong about this sends somebody to a counter expecting to be served without paying.';


COMMENT ON COLUMN "public"."menu_items"."image_path" IS 'A photograph of this dish, in the PUBLIC vendor-images bucket. Null is normal and renders the designed placeholder. The three image columns move together — menu_items_image_complete says so — because a path with no content type is a broken image on every storefront.';


COMMENT ON COLUMN "public"."menu_items"."unavailable_reason" IS 'Why is_available is false. SOLD_OUT is today''s problem and is cleared when the store reopens; WITHDRAWN is deliberate and stays until a person puts the item back. Null whenever is_available is true. The ordering path reads is_available alone and does not care which.';


CREATE OR REPLACE FUNCTION "public"."admin_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_reason" "text", "p_description" "text" DEFAULT NULL::"text", "p_sort_order" integer DEFAULT 0) RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Money is integer pesewas. A caller sending 35.50 is a bug, not a rounding
  -- opportunity, so it is refused rather than truncated.
  if p_price_pesewas is null or p_price_pesewas <= 0 then
    raise exception 'price must be a positive whole number of pesewas'
      using errcode = 'check_violation';
  end if;

  insert into public.menu_items (vendor_id, name, description, price_pesewas, sort_order)
  values (p_vendor_id, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''),
          p_price_pesewas, coalesce(p_sort_order, 0))
  returning * into v_item;

  perform public.log_admin_action(
    'MENU_ITEM_CREATE', 'menu_item', v_item.id, p_reason, null, to_jsonb(v_item)
  );

  return v_item;
end;
$$;


ALTER FUNCTION "public"."admin_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_reason" "text", "p_description" "text", "p_sort_order" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "status" "public"."vendor_status" DEFAULT 'DRAFT'::"public"."vendor_status" NOT NULL,
    "is_accepting_orders" boolean DEFAULT false NOT NULL,
    "location_id" "uuid",
    "location_note" "text",
    "walk_minutes_to_campus" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "can_accept_scans" boolean DEFAULT false NOT NULL,
    "owner_user_id" "uuid",
    "category_id" "uuid",
    "description" "text",
    "applicant_name" "text",
    "owner_is_student" boolean,
    "rejection_reason" "text",
    "submitted_at" timestamp with time zone,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    CONSTRAINT "vendors_phone_e164" CHECK (("phone" ~ '^\+[1-9]\d{7,14}$'::"text")),
    CONSTRAINT "vendors_rejection_has_reason" CHECK ((("status" <> 'REJECTED'::"public"."vendor_status") OR (NULLIF("btrim"(COALESCE("rejection_reason", ''::"text")), ''::"text") IS NOT NULL))),
    CONSTRAINT "vendors_walk_minutes_to_campus_check" CHECK (("walk_minutes_to_campus" >= 0))
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


COMMENT ON COLUMN "public"."vendors"."phone" IS 'The business contact number. NOT published on the storefront and NOT the owner''s sign-in credential — that lives on users.phone, on the owner''s own identity row, and is never exposed through a vendor read model.';


COMMENT ON COLUMN "public"."vendors"."can_accept_scans" IS 'Whether this restaurant honours campus meal scans. Set by an administrator.';


COMMENT ON COLUMN "public"."vendors"."owner_user_id" IS 'The identity that operates this business. NULL means a catalogue-only entry — a restaurant Campus Dash lists so a scan can be fetched from it, which has signed up for nothing and operates no dashboard. A NULL owner grants nothing to anybody: my_vendor_ids() matches no row.';


COMMENT ON COLUMN "public"."vendors"."owner_is_student" IS 'Whether the owner told us they are a student. INFORMATIONAL ONLY. It is not a capability and confers none — a student vendor is not thereby a Customer.';


CREATE OR REPLACE FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_category_id" "uuid" DEFAULT NULL::"uuid", "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes_to_campus" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'vendor name is required' using errcode = 'check_violation';
  end if;

  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    category_id, location_id, location_note, walk_minutes_to_campus
  )
  values (
    btrim(p_name), p_phone, 'DRAFT', false,
    coalesce(p_category_id, '40000000-0000-4000-8000-000000000001'),
    p_location_id, p_location_note, p_walk_minutes_to_campus
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor)
  );

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text" DEFAULT NULL::"text", "p_category_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT NULL::"text", "p_owner_is_student" boolean DEFAULT NULL::boolean, "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes_to_campus" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_owner  public.users%rowtype;
  v_vendor public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_store_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_owner from public.users where id = p_owner_user_id;
  if not found then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;
  if coalesce(v_owner.phone, '') = '' then
    raise exception 'the owner account has no phone number to sign in with'
      using errcode = 'check_violation';
  end if;

  -- ONE ACCOUNT, ONE STORE. vendors_owner_unique says the same thing; this is
  -- the sentence an operator reads instead of a constraint name.
  if exists (select 1 from public.vendors v where v.owner_user_id = p_owner_user_id) then
    raise exception 'that account already owns a store' using errcode = 'unique_violation';
  end if;

  -- An administrator is not a shopkeeper. Operational access must not depend on
  -- an SMS, and an admin row is the one the audit trail keys off.
  if v_owner.is_admin then
    raise exception 'an administrator account cannot own a store'
      using errcode = 'check_violation';
  end if;

  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    owner_user_id, category_id, description, applicant_name, owner_is_student,
    location_id, location_note, walk_minutes_to_campus, submitted_at
  )
  values (
    btrim(p_store_name), v_owner.phone, 'PENDING_APPROVAL', false,
    p_owner_user_id,
    coalesce(p_category_id, '40000000-0000-4000-8000-000000000001'),
    nullif(btrim(coalesce(p_description, '')), ''),
    coalesce(nullif(btrim(coalesce(p_applicant_name, '')), ''), v_owner.full_name),
    p_owner_is_student,
    p_location_id, nullif(btrim(coalesce(p_location_note, '')), ''),
    p_walk_minutes_to_campus, now()
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_ACCOUNT_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor),
    jsonb_build_object('owner_user_id', p_owner_user_id)
  );

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text", "p_category_id" "uuid", "p_description" "text", "p_owner_is_student" boolean, "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text", "p_category_id" "uuid", "p_description" "text", "p_owner_is_student" boolean, "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) IS 'Creates a store that has an OWNER, for a vendor recruited in person. The identity is provisioned by the caller through the auth admin API and passed in; this attaches it to a new PENDING_APPROVAL store so the existing review queue, approval and welcome SMS all apply unchanged. Administrator only, re-checked in the body, audited.';


CREATE TABLE IF NOT EXISTS "public"."vendor_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendor_categories_name_shape" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "vendor_categories_slug_shape" CHECK (("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::"text"))
);


ALTER TABLE "public"."vendor_categories" OWNER TO "postgres";


COMMENT ON TABLE "public"."vendor_categories" IS 'What kind of business a vendor is. Admin-managed rows rather than an enum, so the list can change without a deploy. Disabling a category hides it from the sign-up form and the customer filter; it never detaches the vendors already in it, and it never touches a historical order.';


COMMENT ON COLUMN "public"."vendor_categories"."slug" IS 'The stable identifier. Filters and vendor rows point at the category by id, and this is what makes a rename safe: the display name is free to change.';


CREATE OR REPLACE FUNCTION "public"."admin_create_vendor_category"("p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_reason" "text") RETURNS "public"."vendor_categories"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_row public.vendor_categories%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.vendor_categories (slug, name, sort_order)
  values (lower(btrim(p_slug)), btrim(p_name), coalesce(p_sort_order, 0))
  returning * into v_row;

  perform public.log_admin_action(
    'VENDOR_CATEGORY_CREATE', 'vendor_category', v_row.id, p_reason, null, to_jsonb(v_row)
  );
  return v_row;
end;
$$;


ALTER FUNCTION "public"."admin_create_vendor_category"("p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_customer_detail"("p_user_id" "uuid") RETURNS TABLE("user_id" "uuid", "full_name" "text", "first_name" "text", "last_name" "text", "phone" "text", "email" "text", "affiliation" "public"."campus_affiliation", "graduation_year" integer, "gender" "public"."customer_gender", "student_id_number" "text", "level" "text", "is_suspended" boolean, "is_admin" boolean, "onboarded_at" timestamp with time zone, "created_at" timestamp with time zone, "partner_status" "text", "partner_applied_at" timestamp with time zone, "vendor_names" "text"[], "order_count" bigint, "completed_count" bigint, "spent_pesewas" bigint, "pickup_count" bigint, "partner_count" bigint, "recent_orders" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select u.id, u.full_name, u.first_name, u.last_name, u.phone, u.email,
         c.affiliation, c.graduation_year, c.gender, c.student_id_number, c.level,
         u.is_suspended, u.is_admin, c.onboarded_at, u.created_at,
         coalesce(p.status::text, 'NOT_APPLIED'), p.applied_at,
         coalesce(array_agg(distinct v.name) filter (where v.name is not null), '{}'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status <> 'DRAFT'),
         (select count(*) from public.orders o where o.customer_id = u.id and o.order_status = 'COMPLETED'),
         (select coalesce(sum(o.total_pesewas), 0) from public.orders o
           where o.customer_id = u.id and o.payment_status = 'PAID'),
         (select count(*) from public.orders o where o.customer_id = u.id
           and o.payment_status = 'PAID' and o.fulfilment_type = 'PICKUP'),
         (select count(*) from public.orders o where o.customer_id = u.id
           and o.payment_status = 'PAID' and o.fulfilment_type = 'DELIVERY'),
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'order_id', o.id,
                    'order_number', o.order_number,
                    'vendor_order_no', o.vendor_order_no,
                    'created_at', o.created_at,
                    'order_status', o.order_status,
                    'payment_status', o.payment_status,
                    'total_pesewas', o.total_pesewas) order by o.created_at desc)
             from (select * from public.orders o2
                    where o2.customer_id = u.id and o2.order_status <> 'DRAFT'
                    order by o2.created_at desc limit 10) o
         ), '[]'::jsonb)
    from public.users u
    join public.customer_profiles c on c.user_id = u.id
    left join public.partner_profiles p on p.user_id = u.id
    left join public.vendors v on v.owner_user_id = u.id
   where u.id = p_user_id and public.is_admin()
   group by u.id, u.full_name, u.first_name, u.last_name, u.phone, u.email,
            c.affiliation, c.graduation_year, c.gender, c.student_id_number, c.level,
            u.is_suspended, u.is_admin, c.onboarded_at, u.created_at, p.status, p.applied_at;
$$;


ALTER FUNCTION "public"."admin_customer_detail"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_customer_rewards"("p_status" "text" DEFAULT 'UNLOCKED'::"text", "p_limit" integer DEFAULT 100) RETURNS TABLE("reward_id" "uuid", "user_id" "uuid", "customer_name" "text", "email" "text", "phone" "text", "cycle" integer, "goal_orders" integer, "completed_orders" integer, "status" "text", "unlocked_at" timestamp with time zone, "fulfilled_at" timestamp with time zone, "notes" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select r.id, r.user_id, u.full_name, u.email, u.phone,
         r.cycle, r.goal_orders,
         (select count(*)::integer from public.orders o
           where o.customer_id = r.user_id and o.order_status = 'COMPLETED'),
         r.status, r.unlocked_at, r.fulfilled_at, r.notes
    from public.customer_rewards r
    join public.users u on u.id = r.user_id
   where public.is_admin()
     and (p_status is null or r.status = p_status)
   order by r.unlocked_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_customer_rewards"("p_status" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_customer_summary"("p_affiliation" "public"."campus_affiliation" DEFAULT NULL::"public"."campus_affiliation", "p_graduation_year" integer DEFAULT NULL::integer, "p_gender" "public"."customer_gender" DEFAULT NULL::"public"."customer_gender", "p_joined_since" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with scoped as (
    select c.user_id, c.affiliation, c.graduation_year, c.gender,
           (select count(*) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID') as paid_orders,
           (select coalesce(sum(o.total_pesewas), 0) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID') as spent,
           (select max(o.created_at) from public.orders o where o.customer_id = c.user_id) as last_order_at,
           (select count(*) from public.orders o
             where o.customer_id = c.user_id and o.payment_status = 'PAID'
               and o.fulfilment_type = 'DELIVERY') as partner_orders
      from public.customer_profiles c
     where public.is_admin()
       and (p_affiliation is null or c.affiliation = p_affiliation)
       and (p_graduation_year is null or c.graduation_year = p_graduation_year)
       and (p_gender is null or c.gender = p_gender)
       and (p_joined_since is null or c.onboarded_at >= p_joined_since)
  )
  select jsonb_build_object(
    'customers',        (select count(*) from scoped),
    'students',         (select count(*) from scoped where affiliation = 'STUDENT'),
    'staff',            (select count(*) from scoped where affiliation = 'STAFF'),
    'male',             (select count(*) from scoped where gender = 'MALE'),
    'female',           (select count(*) from scoped where gender = 'FEMALE'),
    'gender_unstated',  (select count(*) from scoped where gender is null),
    'active_30d',       (select count(*) from scoped where last_order_at >= now() - interval '30 days'),
    'never_ordered',    (select count(*) from scoped where paid_orders = 0),
    'paid_orders',      (select coalesce(sum(paid_orders), 0) from scoped),
    'spent_pesewas',    (select coalesce(sum(spent), 0) from scoped),
    'partner_orders',   (select coalesce(sum(partner_orders), 0) from scoped),
    'pickup_orders',    (select coalesce(sum(paid_orders - partner_orders), 0) from scoped),
    -- The shape of the cohort, for the one chart worth drawing.
    'by_graduation_year', coalesce((
      select jsonb_agg(jsonb_build_object('year', year, 'customers', n) order by year)
        from (select graduation_year as year, count(*) as n
                from scoped where graduation_year is not null
               group by graduation_year) g
    ), '[]'::jsonb)
  );
$$;


ALTER FUNCTION "public"."admin_customer_summary"("p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_customers"("p_search" "text" DEFAULT NULL::"text", "p_affiliation" "public"."campus_affiliation" DEFAULT NULL::"public"."campus_affiliation", "p_graduation_year" integer DEFAULT NULL::integer, "p_gender" "public"."customer_gender" DEFAULT NULL::"public"."customer_gender", "p_joined_since" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_min_orders" integer DEFAULT NULL::integer, "p_active" boolean DEFAULT NULL::boolean, "p_fulfilment" "public"."fulfilment_type" DEFAULT NULL::"public"."fulfilment_type", "p_limit" integer DEFAULT 200) RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "email" "text", "affiliation" "public"."campus_affiliation", "graduation_year" integer, "gender" "public"."customer_gender", "student_id_number" "text", "level" "text", "is_suspended" boolean, "is_admin" boolean, "partner_status" "text", "onboarded_at" timestamp with time zone, "order_count" bigint, "completed_count" bigint, "spent_pesewas" bigint, "pickup_count" bigint, "partner_count" bigint, "last_order_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with mine as (
    select c.user_id,
           count(o.id) filter (where o.order_status <> 'DRAFT') as order_count,
           count(o.id) filter (where o.order_status = 'COMPLETED') as completed_count,
           -- WHAT THEY HAVE ACTUALLY PAID, which is only ever a PAID order.
           coalesce(sum(o.total_pesewas) filter (where o.payment_status = 'PAID'), 0) as spent,
           count(o.id) filter (where o.fulfilment_type = 'PICKUP' and o.payment_status = 'PAID')
             as pickups,
           count(o.id) filter (where o.fulfilment_type = 'DELIVERY' and o.payment_status = 'PAID')
             as partners,
           max(o.created_at) as last_order_at
      from public.customer_profiles c
      left join public.orders o on o.customer_id = c.user_id
     group by c.user_id
  )
  select c.user_id,
         u.full_name,
         u.phone,
         u.email,
         c.affiliation,
         c.graduation_year,
         c.gender,
         c.student_id_number,
         c.level,
         u.is_suspended,
         u.is_admin,
         coalesce(p.status::text, 'NOT_APPLIED'),
         c.onboarded_at,
         m.order_count,
         m.completed_count,
         m.spent,
         m.pickups,
         m.partners,
         m.last_order_at
    from public.customer_profiles c
    join public.users u on u.id = c.user_id
    join mine m on m.user_id = c.user_id
    left join public.partner_profiles p on p.user_id = c.user_id
   where public.is_admin()
     and (p_search is null or btrim(p_search) = ''
          or u.full_name ilike '%' || btrim(p_search) || '%'
          or u.email ilike '%' || btrim(p_search) || '%'
          or u.phone ilike '%' || btrim(p_search) || '%'
          or coalesce(c.student_id_number, '') ilike '%' || btrim(p_search) || '%')
     and (p_affiliation is null or c.affiliation = p_affiliation)
     and (p_graduation_year is null or c.graduation_year = p_graduation_year)
     and (p_gender is null or c.gender = p_gender)
     and (p_joined_since is null or c.onboarded_at >= p_joined_since)
     and (p_min_orders is null or m.order_count >= p_min_orders)
     -- ACTIVE means "has ordered in the last 30 days", which is the only
     -- definition an operator can act on during a pilot.
     and (p_active is null
          or (p_active and m.last_order_at >= now() - interval '30 days')
          or (not p_active and (m.last_order_at is null or m.last_order_at < now() - interval '30 days')))
     and (p_fulfilment is null
          or (p_fulfilment = 'PICKUP' and m.pickups > 0)
          or (p_fulfilment = 'DELIVERY' and m.partners > 0))
   order by m.last_order_at desc nulls last, c.onboarded_at desc
   limit least(coalesce(p_limit, 200), 500);
$$;


ALTER FUNCTION "public"."admin_customers"("p_search" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone, "p_min_orders" integer, "p_active" boolean, "p_fulfilment" "public"."fulfilment_type", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_dashboard"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- One row per non-cancelled PLATFORM allocation, split into what the platform
  -- has actually earned and what it is merely holding.
  --
  -- `service_component` is capped at the allocation because the ledger may only
  -- ever carve the DELIVERY fee out of this row (partner_earnings_pesewas <=
  -- delivery_fee_pesewas is a table constraint), so the service fee is always
  -- fully present — the least() is belt and braces against a future change
  -- making that untrue and silently reporting a negative delivery component.
  with platform_rows as (
    select a.amount_pesewas,
           least(o.service_fee_pesewas, a.amount_pesewas)                as service_component,
           a.amount_pesewas - least(o.service_fee_pesewas, a.amount_pesewas) as delivery_component,
           exists (
             select 1 from public.allocations pa
              where pa.order_id = a.order_id
                and pa.payee_type = 'PARTNER'
                and pa.status <> 'CANCELLED'
           ) as partner_settled
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.payee_type = 'PLATFORM' and a.status <> 'CANCELLED'
  )
  select case when not public.is_admin() then null else jsonb_build_object(

    'operations', jsonb_build_object(
      'orders_today', (select count(*) from public.orders
                        where order_status <> 'DRAFT' and created_at >= date_trunc('day', now())),
      'active_food',  (select count(*) from public.orders
                        where order_type = 'FOOD' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'active_scan',  (select count(*) from public.orders
                        where order_type = 'SCAN' and order_status not in ('DRAFT','COMPLETED','CANCELLED','REJECTED','EXPIRED')),
      'searching',    (select count(*) from public.orders where delivery_status = 'SEARCHING'),
      'assigned',     (select count(*) from public.orders where delivery_status in ('ASSIGNED','PICKED_UP')),
      'no_partner',   (select count(*) from public.orders where delivery_status = 'FAILED_NO_PARTNER'),
      'scan_refused', (select count(*) from public.orders
                        where order_type = 'SCAN' and scan_status = 'REFUSED'),
      'needs_attention', (select count(*) from public.admin_order_board(null, 500) b
                           where b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','NO_PARTNER',
                                                 'REFUND_PENDING','PAYMENT_FAILED'))
    ),

    'money', jsonb_build_object(
      -- What customers have actually paid us, gross.
      'collected_pesewas', (select coalesce(sum(amount_pesewas),0) from public.payments where status = 'SUCCEEDED'),
      'payments_count',    (select count(*) from public.payments where status = 'SUCCEEDED'),
      -- What we owe, by payee, excluding anything already settled or cancelled.
      'vendor_owed',   (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'VENDOR'  and status in ('PENDING','ELIGIBLE')),
      'partner_owed',  (select coalesce(sum(amount_pesewas),0) from public.allocations
                         where payee_type = 'PARTNER' and status in ('PENDING','ELIGIBLE')),

      -- REVENUE. The service fee the platform charged, plus whatever it keeps
      -- of a delivery fee once the Partner on that delivery has been settled.
      -- It deliberately EXCLUDES delivery money still waiting on a delivery.
      'platform_earned', (select coalesce(sum(service_component),0)::bigint
                            + coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                            from platform_rows),
      -- The same figure's two halves, so a suspicious number can be taken apart
      -- on the screen instead of in a SQL client.
      'platform_service_fee',    (select coalesce(sum(service_component),0)::bigint from platform_rows),
      'platform_delivery_margin',(select coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                                    from platform_rows),
      -- LIABILITY, not revenue: delivery fees collected from customers, sitting
      -- in the platform allocation only because no Partner row exists to hold
      -- them yet. This is the money the old `platform_earned` was quietly
      -- counting as ours.
      'delivery_fees_held',      (select coalesce(sum(delivery_component) filter (where not partner_settled),0)::bigint
                                    from platform_rows),
      -- The raw allocation row total, unchanged, so the ledger identity
      -- vendor + partner + platform_allocated = gross can still be checked.
      'platform_allocated',      (select coalesce(sum(amount_pesewas),0)::bigint from platform_rows),

      'payouts_pending',    (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PENDING'),
      'payouts_processing', (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PROCESSING'),
      'payouts_failed',     (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'FAILED'),
      'payouts_paid',       (select coalesce(sum(amount_pesewas),0) from public.payouts where status = 'PAID'),
      'refunded_pesewas',   (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUNDED'),
      'refund_pending_pesewas', (select coalesce(sum(total_pesewas),0) from public.orders where payment_status = 'REFUND_PENDING')
    ),

    'people', jsonb_build_object(
      'customers',        (select count(*) from public.customer_profiles),
      'partners',         (select count(*) from public.partner_profiles where status = 'APPROVED'),
      'partners_pending', (select count(*) from public.partner_profiles where status = 'PENDING_REVIEW'),
      'partners_online',  (select count(*) from public.partner_profiles where status = 'APPROVED' and is_available),
      'vendors',          (select count(*) from public.vendors),
      'vendors_active',   (select count(*) from public.vendors where status = 'ACTIVE'),
      'vendors_scan',     (select count(*) from public.vendors where can_accept_scans),
      'suspended',        (select count(*) from public.users where is_suspended)
    ),

    'system', jsonb_build_object(
      'webhooks_24h',        (select count(*) from public.webhook_events where received_at >= now() - interval '24 hours'),
      'webhooks_invalid_24h',(select count(*) from public.webhook_events
                               where received_at >= now() - interval '24 hours' and not signature_valid),
      'notifications_24h',   (select count(*) from public.notification_events where created_at >= now() - interval '24 hours'),
      'notifications_failed_24h', (select count(*) from public.notification_events
                                    where created_at >= now() - interval '24 hours' and not succeeded),
      'admin_actions_24h',   (select count(*) from public.admin_actions where created_at >= now() - interval '24 hours'),
      'scan_fee_configured', (select scan_service_fee_pesewas is not null from public.pricing_config where id)
    )
  ) end;
$$;


ALTER FUNCTION "public"."admin_dashboard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_dashboard_totals"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select case when public.is_admin() then jsonb_build_object(
    -- COUNTING ORDERS, not payments: a retried payment is still one order, and
    -- counting payments would quietly inflate this.
    'orders_total', (
      select count(*) from public.orders where payment_status = 'PAID'
    ),
    'orders_active', (
      select count(*) from public.orders
       where payment_status = 'PAID'
         and order_status not in ('COMPLETED', 'CANCELLED')
    ),
    'total_sales', (
      select coalesce(sum(amount_pesewas), 0)
        from public.payments where status = 'SUCCEEDED'
    ),
    'vendor_sales', (
      select coalesce(sum(amount_pesewas), 0)
        from public.allocations
       where payee_type = 'VENDOR' and status <> 'CANCELLED'
    ),
    'partner_earnings', (
      select coalesce(sum(amount_pesewas), 0)
        from public.allocations
       where payee_type = 'PARTNER' and status <> 'CANCELLED'
    ),
    'partner_payouts_pending', (
      select coalesce(sum(amount_pesewas), 0)
        from public.payouts
       where payee_type = 'PARTNER' and status in ('PENDING', 'PROCESSING')
    ),
    'vendors_pending', (
      select count(*) from public.vendors where status = 'PENDING_APPROVAL'
    ),
    'partners_pending', (
      select count(*) from public.partner_profiles where status = 'PENDING_REVIEW'
    )
  ) end;
$$;


ALTER FUNCTION "public"."admin_dashboard_totals"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_dashboard_totals"() IS 'Lifetime totals for the operations dashboard — orders, sales, the vendor and Partner shares, and the pending Partner payout — summed from the existing payments, allocations and payouts ledger. Returns NULL for a non-administrator. Administrator only.';


CREATE OR REPLACE FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user   public.users%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_orders integer;
  v_paths  jsonb;
  v_counts jsonb := '{}'::jsonb;
  v_n      integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_user from public.users where id = p_user_id;
  if not found then
    raise exception 'no such account' using errcode = 'no_data_found';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'an administrator cannot delete their own account'
      using errcode = 'check_violation';
  end if;

  if v_user.is_admin
     or exists (select 1 from public.admin_actions a where a.admin_user_id = p_user_id) then
    raise exception 'an administrator account cannot be deleted here'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.vendors v where v.owner_user_id = p_user_id) then
    raise exception 'this account owns a store. Delete the store first.'
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_orders
    from public.orders o
   where o.customer_id = p_user_id or o.partner_id = p_user_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order(s) involve this account, and deleting them would delete the money records that reconcile them. Suspend the account instead.',
      v_orders using errcode = 'foreign_key_violation';
  end if;

  if exists (select 1 from public.allocations a where a.payee_id = p_user_id)
     or exists (select 1 from public.payouts p where p.payee_id = p_user_id) then
    raise exception
      'cannot delete: this account has settlement records. Suspend it instead.'
      using errcode = 'foreign_key_violation';
  end if;

  -- A rating is somebody else's statement about a delivery. With no orders
  -- there can be none, and if there is one it is not this call's to erase.
  if exists (
    select 1 from public.partner_ratings r
     where r.partner_id = p_user_id or r.customer_id = p_user_id
  ) then
    raise exception 'cannot delete: this account has delivery ratings against it.'
      using errcode = 'foreign_key_violation';
  end if;

  -- The object paths, read before the rows that name them are gone. Both
  -- Partner document columns: a current application has only a student ID, but
  -- an older one also has a face photograph, and the one that is missed stays
  -- in storage for ever once the row naming it is deleted.
  select jsonb_build_object(
    'partner-documents',
      coalesce((select jsonb_agg(x.path)
                  from public.partner_profiles pp,
                       lateral (values (pp.student_id_image_path), (pp.face_image_path)) as x(path)
                 where pp.user_id = p_user_id and x.path is not null), '[]'::jsonb),
    'scan-documents',
      coalesce((select jsonb_agg(s.image_path) from public.order_scans s
                 where s.customer_id = p_user_id and s.image_path is not null), '[]'::jsonb)
  ) into v_paths;

  -- The append-only rows, through the existing audited mechanism. It opens and
  -- closes its own transaction-local door; nothing here touches it.
  v_n := public.admin_purge_test_history(array[p_user_id], '{}'::uuid[], v_reason);
  v_counts := v_counts || jsonb_build_object('notification_events', v_n);

  delete from public.order_scans s where s.customer_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('order_scans', v_n);

  delete from public.idempotency_keys k where k.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n);

  delete from public.customer_rewards r where r.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_rewards', v_n);

  delete from public.terms_acceptances t where t.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('terms_acceptances', v_n);

  -- PARTNER BEFORE CUSTOMER. The foreign key between them is RESTRICT.
  delete from public.partner_profiles p where p.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_profiles', v_n);

  delete from public.customer_profiles c where c.user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_profiles', v_n);

  -- The identity. public.users cascades from auth.users, and so do the
  -- account's sessions, identities and factors.
  delete from auth.users u where u.id = p_user_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth_users', v_n);

  perform public.log_admin_action(
    'CUSTOMER_DELETE', 'user', p_user_id, v_reason, to_jsonb(v_user), null,
    jsonb_build_object('counts', v_counts, 'storage_paths', v_paths)
  );

  return jsonb_build_object(
    'name', coalesce(v_user.full_name, v_user.phone, v_user.email),
    'counts', v_counts,
    'storage_paths', v_paths
  );
end;
$$;


ALTER FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") IS 'Deletes an account that has never ordered, with every capability row built on it, in the order the foreign keys require. Refuses an administrator, the caller, a store owner, an account with orders, settlement records or delivery ratings. Administrator only, re-checked in the body, audited. Returns the storage object paths the caller must remove through the Storage API.';


CREATE OR REPLACE FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before   public.locations%rowtype;
  v_children integer;
  v_orders   integer;
  v_vendors  integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    return false;
  end if;

  select count(*) into v_children from public.locations where parent_id = p_location_id;
  if v_children > 0 then
    raise exception 'cannot delete: % child location(s). Deactivate it instead.', v_children
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_orders from public.orders
   where destination_location_id = p_location_id or destination_zone_id = p_location_id;
  if v_orders > 0 then
    raise exception 'cannot delete: % order(s) reference this location. Deactivate it instead.', v_orders
      using errcode = 'foreign_key_violation';
  end if;

  select count(*) into v_vendors from public.vendors where location_id = p_location_id;
  if v_vendors > 0 then
    raise exception 'cannot delete: % vendor(s) sit at this location.', v_vendors
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.locations where id = p_location_id;

  perform public.log_admin_action(
    'LOCATION_DELETE', 'location', p_location_id, p_reason, to_jsonb(v_before), null
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.menu_items%rowtype;
  v_orders integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    return false;
  end if;

  select count(*) into v_orders from public.order_items where menu_item_id = p_menu_item_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order line(s) reference this item. Disable it instead.', v_orders
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.menu_items where id = p_menu_item_id;

  perform public.log_admin_action(
    'MENU_ITEM_DELETE', 'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), null
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_vendor  public.vendors%rowtype;
  v_owner   public.users%rowtype;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_orders  integer;
  v_paths   jsonb;
  v_counts  jsonb := '{}'::jsonb;
  v_n       integer;
  v_owner_deleted boolean := false;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  select * into v_vendor from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  select count(*) into v_orders from public.orders where vendor_id = p_vendor_id;
  if v_orders > 0 then
    raise exception
      'cannot delete: % order(s) belong to this store, and deleting them would delete the money records that reconcile them. Suspend the store instead.',
      v_orders using errcode = 'foreign_key_violation';
  end if;

  -- Belt as well as braces: a settlement row for a store with no orders should
  -- not exist, and if one does it is the thing to look at before deleting.
  if exists (select 1 from public.allocations a where a.payee_id = p_vendor_id)
     or exists (select 1 from public.payouts p where p.payee_id = p_vendor_id) then
    raise exception
      'cannot delete: this store has settlement records. Suspend it instead.'
      using errcode = 'foreign_key_violation';
  end if;

  -- The object paths, read before the rows that name them are gone.
  select coalesce(jsonb_agg(i.storage_path) filter (where i.storage_path is not null), '[]'::jsonb)
    into v_paths
    from public.vendor_images i
   where i.vendor_id = p_vendor_id;

  select count(*) into v_n from public.menu_items where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('menu_items', v_n);
  select count(*) into v_n from public.vendor_images where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendor_images', v_n);
  select count(*) into v_n from public.vendor_order_counters where vendor_id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendor_order_counters', v_n);

  -- Where the money would have gone. No payout exists, so nothing is orphaned.
  delete from public.payout_destinations d where d.payee_id = p_vendor_id;
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payout_destinations', v_n);

  -- Menu items, photographs and the daily queue counter cascade from here.
  delete from public.vendors v where v.id = p_vendor_id;
  v_counts := v_counts || jsonb_build_object('vendors', 1);

  if v_vendor.owner_user_id is not null then
    select * into v_owner from public.users where id = v_vendor.owner_user_id;

    -- Everything that would make this identity more than the store it just
    -- lost. Any one of them and the account stays exactly as it is.
    if found
       and not v_owner.is_admin
       and v_owner.id <> auth.uid()
       and not exists (select 1 from public.customer_profiles c where c.user_id = v_owner.id)
       and not exists (select 1 from public.partner_profiles p where p.user_id = v_owner.id)
       and not exists (select 1 from public.vendors v2 where v2.owner_user_id = v_owner.id)
       and not exists (select 1 from public.orders o
                        where o.customer_id = v_owner.id or o.partner_id = v_owner.id)
       and not exists (select 1 from public.admin_actions a where a.admin_user_id = v_owner.id)
    then
      perform public.admin_purge_test_history(array[v_owner.id], '{}'::uuid[], v_reason);

      delete from public.terms_acceptances t where t.user_id = v_owner.id;
      -- public.users cascades from auth.users, and so do the account's
      -- sessions, identities and factors.
      delete from auth.users u where u.id = v_owner.id;
      v_owner_deleted := true;
    end if;
  end if;

  v_counts := v_counts || jsonb_build_object('owner_account_deleted', v_owner_deleted);

  perform public.log_admin_action(
    'VENDOR_DELETE', 'vendor', p_vendor_id, v_reason, to_jsonb(v_vendor), null,
    jsonb_build_object('counts', v_counts, 'storage_paths', v_paths)
  );

  return jsonb_build_object(
    'name', v_vendor.name,
    'counts', v_counts,
    'storage_paths', jsonb_build_object('vendor-images', v_paths)
  );
end;
$$;


ALTER FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") IS 'Deletes a store that has never traded, with its menu, photographs, queue counter and payout destination, and the owner identity if the store was the only thing it held. Refuses a store with orders or settlement records — suspend those instead. Administrator only, re-checked in the body, audited. Returns the storage object paths the caller must remove through the Storage API.';


CREATE OR REPLACE FUNCTION "public"."admin_exceptions"("p_limit" integer DEFAULT 200) RETURNS TABLE("kind" "text", "order_id" "uuid", "order_number" "text", "order_type" "public"."order_type", "subject" "text", "detail" "text", "amount_pesewas" bigint, "requires_decision" boolean, "since" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- Orders whose classification is already a problem.
  select b.attention,
         b.order_id, b.order_number, b.order_type,
         b.customer_name,
         case b.attention
           when 'DISPUTED'        then 'The customer disputes this delivery.'
           when 'SCAN_REFUSED'    then 'The restaurant would not honour the scan. No refund policy exists — decide.'
           when 'CUSTOMER_ABSENT' then 'The Partner could not hand the order over.'
           when 'NO_PARTNER'      then 'Nobody accepted the delivery before the search expired.'
           when 'REFUND_PENDING'  then 'A refund has been marked pending and needs completing at the provider.'
           when 'PAYMENT_FAILED'  then 'The payment failed.'
           else b.attention
         end,
         b.total_pesewas,
         -- These four have no automatic resolution anywhere in the system.
         b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','REFUND_PENDING'),
         b.created_at
    from public.admin_order_board(null, 500) b
   where public.is_admin()
     and b.attention in ('DISPUTED','SCAN_REFUSED','CUSTOMER_ABSENT','NO_PARTNER',
                         'REFUND_PENDING','PAYMENT_FAILED')

  union all

  -- Money that tried to leave and did not.
  select 'FAILED_PAYOUT',
         null::uuid, null::text, null::public.order_type,
         coalesce(v.name, u.full_name, 'unknown payee'),
         'Payout failed: ' || coalesce(po.failure_reason, 'no reason recorded') ||
           '. Retry only when the cause is understood.',
         po.amount_pesewas,
         true,
         po.created_at
    from public.payouts po
    left join public.vendors v on v.id = po.payee_id and po.payee_type = 'VENDOR'
    left join public.users u on u.id = po.payee_id and po.payee_type = 'PARTNER'
   where public.is_admin() and po.status = 'FAILED'

  union all

  -- Anything the ledger itself cannot explain.
  select 'RECONCILIATION',
         r.order_id, r.order_number, null::public.order_type,
         r.issue, r.detail, r.total_pesewas, true, r.created_at
    from public.admin_reconciliation(200) r
   where public.is_admin()

  -- Ordinal, not a name: across a UNION the output columns take their names
  -- from the first branch's expressions, not from the RETURNS TABLE list.
  -- Oldest first — the thing that has been broken longest is the thing that
  -- has been costing somebody the longest.
  order by 9 asc
  limit least(coalesce(p_limit, 200), 500);
$$;


ALTER FUNCTION "public"."admin_exceptions"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_failed_notifications"("p_limit" integer DEFAULT 100) RETURNS TABLE("id" bigint, "event" "text", "audience" "text", "recipient" "text", "order_id" "uuid", "error" "text", "attempts" bigint, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select n.id, n.event, n.audience, n.recipient, n.order_id, n.error,
         (select count(*) from public.notification_events a
           where a.dedupe_key is not distinct from n.dedupe_key),
         n.created_at
    from public.notification_events n
   where public.is_admin()
     and not n.succeeded
     -- Nothing to chase if a later attempt got through.
     and not exists (
       select 1 from public.notification_events s
        where s.dedupe_key = n.dedupe_key and s.succeeded
     )
   order by n.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_failed_notifications"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_ledger"("p_order_type" "text" DEFAULT NULL::"text", "p_payee_type" "text" DEFAULT NULL::"text", "p_allocation_status" "text" DEFAULT NULL::"text", "p_payout_status" "text" DEFAULT NULL::"text", "p_vendor_id" "uuid" DEFAULT NULL::"uuid", "p_payee_id" "uuid" DEFAULT NULL::"uuid", "p_since" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_until" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_limit" integer DEFAULT 200) RETURNS TABLE("allocation_id" "uuid", "order_id" "uuid", "order_number" "text", "order_type" "public"."order_type", "order_created_at" timestamp with time zone, "vendor_name" "text", "payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "amount_pesewas" bigint, "allocation_status" "public"."allocation_status", "settled_at" timestamp with time zone, "settlement_run_id" "uuid", "payout_id" "uuid", "payout_status" "public"."payout_status", "order_total_pesewas" bigint, "order_subtotal_pesewas" bigint, "order_service_fee_pesewas" bigint, "order_delivery_fee_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select a.id, o.id, o.order_number, o.order_type, o.created_at,
         v.name,
         a.payee_type, a.payee_id,
         case a.payee_type
           when 'PLATFORM' then 'Campus Dash'
           when 'VENDOR'   then vp.name
           else pu.full_name
         end,
         a.amount_pesewas, a.status, a.settled_at, a.settlement_run_id,
         po.id, po.status,
         o.total_pesewas, o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas
    from public.allocations a
    join public.orders o on o.id = a.order_id
    join public.vendors v on v.id = o.vendor_id
    left join public.vendors vp on vp.id = a.payee_id and a.payee_type = 'VENDOR'
    left join public.users pu on pu.id = a.payee_id and a.payee_type = 'PARTNER'
    left join public.payouts po on po.settlement_run_id = a.settlement_run_id
                               and po.payee_type = a.payee_type
                               and po.payee_id is not distinct from a.payee_id
   where public.is_admin()
     and (p_order_type is null        or o.order_type::text = p_order_type)
     and (p_payee_type is null        or a.payee_type::text = p_payee_type)
     and (p_allocation_status is null or a.status::text = p_allocation_status)
     and (p_payout_status is null     or po.status::text = p_payout_status)
     and (p_vendor_id is null         or o.vendor_id = p_vendor_id)
     and (p_payee_id is null          or a.payee_id = p_payee_id)
     and (p_since is null             or o.created_at >= p_since)
     and (p_until is null             or o.created_at <  p_until)
   order by o.created_at desc, a.payee_type
   limit least(coalesce(p_limit, 200), 1000);
$$;


ALTER FUNCTION "public"."admin_ledger"("p_order_type" "text", "p_payee_type" "text", "p_allocation_status" "text", "p_payout_status" "text", "p_vendor_id" "uuid", "p_payee_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_ledger_totals"("p_order_type" "text" DEFAULT NULL::"text", "p_since" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_until" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- GROSS IS SUMMED OVER DISTINCT ORDERS, not over allocation rows. An order
  -- with three payees would otherwise contribute its total three times and the
  -- finance page would report revenue that does not exist.
  with rows as (
    select a.amount_pesewas, a.payee_type, o.id as order_id, o.total_pesewas,
           o.service_fee_pesewas
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.status <> 'CANCELLED'
       and (p_order_type is null or o.order_type::text = p_order_type)
       and (p_since is null or o.created_at >= p_since)
       and (p_until is null or o.created_at <  p_until)
  ),
  orders_once as (select distinct order_id, total_pesewas from rows),
  -- The PLATFORM row, taken apart. `partner_settled` is decided from the same
  -- filtered set, which is safe because every filter here is order-level: an
  -- order's PLATFORM and PARTNER rows are always both in or both out.
  platform_rows as (
    select p.amount_pesewas,
           least(p.service_fee_pesewas, p.amount_pesewas)                as service_component,
           p.amount_pesewas - least(p.service_fee_pesewas, p.amount_pesewas) as delivery_component,
           exists (select 1 from rows x
                    where x.order_id = p.order_id and x.payee_type = 'PARTNER') as partner_settled
      from rows p
     where p.payee_type = 'PLATFORM'
  )
  select case when not public.is_admin() then null else jsonb_build_object(
    'orders',            (select count(*) from orders_once),
    'gross_pesewas',     (select coalesce(sum(total_pesewas),0)::bigint from orders_once),
    'vendor_pesewas',    (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'VENDOR'),
    'partner_pesewas',   (select coalesce(sum(amount_pesewas),0)::bigint from rows where payee_type = 'PARTNER'),

    -- Platform REVENUE: service fees, plus retained delivery margin on
    -- deliveries a Partner has already been settled for.
    'platform_pesewas',  (select coalesce(sum(service_component),0)::bigint
                            + coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                            from platform_rows),
    'platform_service_fee_pesewas',     (select coalesce(sum(service_component),0)::bigint from platform_rows),
    'platform_delivery_margin_pesewas', (select coalesce(sum(delivery_component) filter (where partner_settled),0)::bigint
                                           from platform_rows),
    -- Delivery fees parked in the PLATFORM row awaiting Partner settlement.
    -- Owed, not earned.
    'delivery_fees_held_pesewas',       (select coalesce(sum(delivery_component) filter (where not partner_settled),0)::bigint
                                           from platform_rows),
    -- The unsplit PLATFORM allocation. Kept so the ledger identity is still
    -- expressible: vendor + partner + platform_allocated = allocated = gross.
    'platform_allocated_pesewas',       (select coalesce(sum(amount_pesewas),0)::bigint from platform_rows),

    'allocated_pesewas', (select coalesce(sum(amount_pesewas),0)::bigint from rows)
  ) end;
$$;


ALTER FUNCTION "public"."admin_ledger_totals"("p_order_type" "text", "p_since" timestamp with time zone, "p_until" timestamp with time zone) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."admin_actions" (
    "id" bigint NOT NULL,
    "admin_user_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid",
    "reason" "text" NOT NULL,
    "before_state" "jsonb",
    "after_state" "jsonb",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "admin_actions_reason_check" CHECK (("length"("btrim"("reason")) >= 3))
);


ALTER TABLE "public"."admin_actions" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_actions"("p_limit" integer DEFAULT 100) RETURNS SETOF "public"."admin_actions"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select * from public.admin_actions
   where public.is_admin()
   order by created_at desc
   limit least(coalesce(p_limit, 100), 1000);
$$;


ALTER FUNCTION "public"."admin_list_actions"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status" DEFAULT NULL::"public"."partner_application_status") RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "student_id_number" "text", "level" "text", "email" "text", "status" "public"."partner_application_status", "student_id_image_path" "text", "face_image_path" "text", "is_available" boolean, "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "reviewed_by_name" "text", "review_notes" "text", "documents_purge_after" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.user_id, u.full_name, u.phone,
         c.student_id_number, c.level, u.email, p.status,
         p.student_id_image_path, p.face_image_path, p.is_available,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.documents_purge_after
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    join public.customer_profiles c on c.user_id = p.user_id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin()
     and (p_status is null or p.status = p_status)
   order by
     case when p.status = 'PENDING_REVIEW' then 0 else 1 end,
     p.applied_at asc;
$$;


ALTER FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_mark_refunded"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;

  update public.orders set payment_status = 'REFUNDED'
   where id = p_order_id and payment_status = 'REFUND_PENDING'
  returning * into v_after;

  if not found then
    raise exception 'order payment is not REFUND_PENDING' using errcode = 'check_violation';
  end if;

  update public.allocations set status = 'CANCELLED'
   where order_id = p_order_id and status <> 'SETTLED';

  perform public.log_order_event(p_order_id, 'REFUND_COMPLETED', true, 'ADMIN',
    'payment_status', 'REFUND_PENDING', 'REFUNDED', p_reason);
  perform public.log_admin_action('ORDER_REFUND', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_mark_refunded"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_events" (
    "id" bigint NOT NULL,
    "event" "text" NOT NULL,
    "audience" "text" NOT NULL,
    "channel" "text" DEFAULT 'SMS'::"text" NOT NULL,
    "user_id" "uuid",
    "order_id" "uuid",
    "recipient" "text",
    "succeeded" boolean NOT NULL,
    "provider" "text",
    "provider_message_id" "text",
    "error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "dedupe_key" "text",
    "correlation_id" "text",
    "delivery_status" "text",
    "delivery_updated_at" timestamp with time zone
);


ALTER TABLE "public"."notification_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."notification_events"."correlation_id" IS 'Our reference, generated before the send and handed to the provider so its delivery callback can be matched back to this row.';


COMMENT ON COLUMN "public"."notification_events"."delivery_status" IS 'Normalised final outcome from the provider: DELIVERED, FAILED, EXPIRED, REJECTED or UNKNOWN. Null until the provider says.';


CREATE OR REPLACE FUNCTION "public"."admin_notification_log"("p_limit" integer DEFAULT 100) RETURNS SETOF "public"."notification_events"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select * from public.notification_events
   where public.is_admin()
   order by created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_notification_log"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_order_board"("p_filter" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 100, "p_order_type" "text" DEFAULT NULL::"text", "p_order_status" "text" DEFAULT NULL::"text", "p_payment_status" "text" DEFAULT NULL::"text", "p_partner_state" "text" DEFAULT NULL::"text", "p_vendor_id" "uuid" DEFAULT NULL::"uuid", "p_since" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_until" timestamp with time zone DEFAULT NULL::timestamp with time zone, "p_search" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "order_type" "public"."order_type", "vendor_name" "text", "customer_name" "text", "partner_name" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "scan_status" "public"."scan_status", "fulfilment_type" "public"."fulfilment_type", "total_pesewas" bigint, "attention" "text", "age_seconds" integer, "disputed" boolean, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with scored as (
    select o.*,
           v.name as vendor_name,
           c.full_name as customer_name,
           p.full_name as partner_name,
           case
             when o.disputed_at is not null and o.dispute_resolved_at is null then 'DISPUTED'
             -- NEW. A refused scan is not "in progress": the Partner is standing
             -- at a counter that will not serve them, and only a person can
             -- decide what happens to the money.
             when o.order_type = 'SCAN' and o.scan_status = 'REFUSED'          then 'SCAN_REFUSED'
             when o.delivery_status = 'FAILED_CUSTOMER_ABSENT'                then 'CUSTOMER_ABSENT'
             when o.delivery_status = 'FAILED_NO_PARTNER'                     then 'NO_PARTNER'
             when o.payment_status = 'REFUND_PENDING'                         then 'REFUND_PENDING'
             when o.payment_status = 'FAILED'                                 then 'PAYMENT_FAILED'
             when o.order_status = 'SUBMITTED'                                then 'AWAITING_VENDOR'
             when o.order_status = 'ACCEPTED' and o.payment_status <> 'PAID'  then 'AWAITING_PAYMENT'
             when o.delivery_status = 'SEARCHING'                             then 'SEARCHING_PARTNER'
             when o.order_status in ('PREPARING', 'READY')                    then 'IN_PROGRESS'
             when o.delivery_status in ('ASSIGNED', 'PICKED_UP')              then 'IN_PROGRESS'
             when o.order_status = 'COMPLETED'                                then 'DONE'
             else 'CLOSED'
           end as attention
      from public.orders o
      join public.vendors v on v.id = o.vendor_id
      join public.users c on c.id = o.customer_id
      left join public.users p on p.id = o.partner_id
     where public.is_admin() and o.order_status <> 'DRAFT'
  )
  select s.id, s.order_number, s.order_type, s.vendor_name, s.customer_name, s.partner_name,
         s.order_status, s.payment_status, s.delivery_status, s.scan_status, s.fulfilment_type,
         s.total_pesewas, s.attention,
         extract(epoch from (now() - s.created_at))::integer,
         s.disputed_at is not null and s.dispute_resolved_at is null,
         s.created_at
    from scored s
   where (p_filter is null         or s.attention = p_filter)
     and (p_order_type is null     or s.order_type::text = p_order_type)
     and (p_order_status is null   or s.order_status::text = p_order_status)
     and (p_payment_status is null or s.payment_status::text = p_payment_status)
     and (p_partner_state is null
          or (p_partner_state = 'ASSIGNED'   and s.partner_id is not null)
          or (p_partner_state = 'UNASSIGNED' and s.partner_id is null))
     and (p_vendor_id is null      or s.vendor_id = p_vendor_id)
     and (p_since is null          or s.created_at >= p_since)
     and (p_until is null          or s.created_at <  p_until)
     -- Order number is exact-ish; the customer name is a contains match. Both
     -- are already visible to an admin on this very board, so searching them
     -- reveals nothing new.
     and (p_search is null or btrim(p_search) = ''
          or s.order_number ilike '%' || btrim(p_search) || '%'
          or s.customer_name ilike '%' || btrim(p_search) || '%')
   order by
     case s.attention
       when 'DISPUTED'          then 0
       when 'SCAN_REFUSED'      then 1
       when 'CUSTOMER_ABSENT'   then 2
       when 'NO_PARTNER'        then 3
       when 'REFUND_PENDING'    then 4
       when 'PAYMENT_FAILED'    then 5
       when 'AWAITING_VENDOR'   then 6
       when 'AWAITING_PAYMENT'  then 7
       when 'SEARCHING_PARTNER' then 8
       when 'IN_PROGRESS'       then 9
       else 10
     end,
     s.created_at asc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer, "p_order_type" "text", "p_order_status" "text", "p_payment_status" "text", "p_partner_state" "text", "p_vendor_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_order_board_summary"() RETURNS TABLE("attention" "text", "count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select b.attention, count(*)
    from public.admin_order_board(null, 500) b
   where public.is_admin()
   group by b.attention
   order by count(*) desc;
$$;


ALTER FUNCTION "public"."admin_order_board_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_order_money"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "total_pesewas" bigint, "payment_status" "public"."payment_status", "payment_id" "uuid", "payment_provider" "text", "payment_txn_status" "public"."payment_txn_status", "provider_transaction_id" "text", "paid_pesewas" bigint, "split_subaccount_code" "text", "split_vendor_pesewas" bigint, "vendor_name" "text", "vendor_allocation" bigint, "vendor_channel" "text", "platform_allocation" bigint, "partner_name" "text", "partner_allocation" bigint, "allocated_pesewas" bigint, "balances" boolean, "allocations" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.total_pesewas,
         o.payment_status,
         pay.id,
         pay.provider,
         pay.status,
         pay.provider_transaction_id,
         coalesce(pay.amount_pesewas, 0),
         pay.split_subaccount_code,
         coalesce(pay.split_vendor_pesewas, 0),
         v.name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'VENDOR'
                      and a.status <> 'CANCELLED'), 0),
         (select a.settlement_channel from public.allocations a
           where a.order_id = o.id and a.payee_type = 'VENDOR'
             and a.status <> 'CANCELLED'),
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PLATFORM'
                      and a.status <> 'CANCELLED'), 0),
         pu.full_name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'PARTNER'
                      and a.status <> 'CANCELLED'), 0),
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0)::bigint,
         -- The invariant, stated where an admin can see it fail.
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.order_id = o.id and a.status <> 'CANCELLED'), 0) = o.total_pesewas
           or not exists (select 1 from public.allocations a where a.order_id = o.id),
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'payee_type', a.payee_type,
                     'amount_pesewas', a.amount_pesewas,
                     'status', a.status,
                     'settlement_channel', a.settlement_channel,
                     'settlement_run_id', a.settlement_run_id,
                     'settled_at', a.settled_at
                   ) order by a.payee_type)
              from public.allocations a where a.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join lateral (
      select p.* from public.payments p
       where p.order_id = o.id
       order by case p.status when 'SUCCEEDED' then 0 else 1 end, p.created_at desc
       limit 1
    ) pay on true
   where public.is_admin() and o.id = p_order_id;
$$;


ALTER FUNCTION "public"."admin_order_money"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_partner_activity"() RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "status" "public"."partner_application_status", "is_suspended" boolean, "is_online" boolean, "current_session_seconds" integer, "online_seconds_today" bigint, "online_seconds_this_week" bigint, "last_online_at" timestamp with time zone, "last_offline_at" timestamp with time zone, "deliveries_completed" bigint, "active_deliveries" bigint, "owed_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with bounds as (
    select date_trunc('day', now()) as day_start,
           date_trunc('week', now()) as week_start
  ),
  -- Overlap of each session with the window, so a session that started
  -- yesterday and is still open counts only today's share of itself.
  windowed as (
    select s.user_id,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.day_start)))) as today_seconds,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.week_start)))) as week_seconds
      from public.partner_sessions s
      cross join bounds b
     where coalesce(s.ended_at, now()) >= b.week_start
  )
  select p.user_id,
         u.full_name,
         u.phone,
         p.status,
         u.is_suspended,
         p.is_available,
         (select extract(epoch from (now() - s.started_at))::integer
            from public.partner_sessions s
           where s.user_id = p.user_id and s.ended_at is null
           limit 1),
         (select coalesce(sum(w.today_seconds), 0)::bigint from windowed w where w.user_id = p.user_id),
         (select coalesce(sum(w.week_seconds), 0)::bigint from windowed w where w.user_id = p.user_id),
         (select max(s.started_at) from public.partner_sessions s where s.user_id = p.user_id),
         (select max(s.ended_at) from public.partner_sessions s where s.user_id = p.user_id),
         (select count(*) from public.orders o
           where o.partner_id = p.user_id and o.delivery_status = 'DELIVERED'),
         (select count(*) from public.orders o
           where o.partner_id = p.user_id and o.delivery_status in ('ASSIGNED', 'PICKED_UP')),
         (select coalesce(sum(a.amount_pesewas), 0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = p.user_id and a.status = 'ELIGIBLE')
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
   where public.is_admin()
   order by p.is_available desc, u.full_name;
$$;


ALTER FUNCTION "public"."admin_partner_activity"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_partner_activity"() IS 'Partner supply, measured. Online time is summed from partner_sessions rows clipped to the window, so a session still open counts only the part of itself inside it. Never derived from page visits.';


CREATE OR REPLACE FUNCTION "public"."admin_partner_balances"() RETURNS TABLE("partner_id" "uuid", "partner_name" "text", "phone" "text", "delivered_count" bigint, "available_pesewas" bigint, "in_progress_pesewas" bigint, "settled_pesewas" bigint, "payout_threshold_pesewas" bigint, "eligible_for_payout" boolean, "has_destination" boolean, "transfers_ready" boolean, "last_paid_at" timestamp with time zone, "oldest_unpaid_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.user_id,
         u.full_name,
         u.phone,
         count(a.id) filter (where a.id is not null),
         coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLING'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint,
         public.payout_threshold_for('PARTNER'),
         coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0)
           >= public.payout_threshold_for('PARTNER'),
         d.payee_id is not null,
         d.provider_recipient_code is not null,
         (select max(po.paid_at) from public.payouts po
           where po.payee_type = 'PARTNER' and po.payee_id = p.user_id and po.status = 'PAID'),
         min(o.created_at) filter (where a.status in ('PENDING','ELIGIBLE'))
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.allocations a
      on a.payee_type = 'PARTNER' and a.payee_id = p.user_id and a.status <> 'CANCELLED'
    left join public.orders o on o.id = a.order_id
    left join public.payout_destinations d
      on d.payee_type = 'PARTNER' and d.payee_id = p.user_id
   where public.is_admin()
     and p.status = 'APPROVED'
   group by p.user_id, u.full_name, u.phone, d.payee_id, d.provider_recipient_code
   order by coalesce(sum(a.amount_pesewas) filter (where a.status in ('PENDING','ELIGIBLE')), 0) desc;
$$;


ALTER FUNCTION "public"."admin_partner_balances"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_partner_balances"() IS 'Every approved Partner, what they are owed, whether it clears the weekly threshold, and whether they can actually be paid. Never returns an account number.';


CREATE OR REPLACE FUNCTION "public"."admin_partner_detail"("p_user_id" "uuid") RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "email" "text", "student_id_number" "text", "level" "text", "status" "public"."partner_application_status", "is_available" boolean, "is_suspended" boolean, "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "reviewed_by_name" "text", "review_notes" "text", "has_face_image" boolean, "has_student_id" boolean, "deliveries_completed" bigint, "deliveries_failed" bigint, "earned_pesewas" bigint, "owed_pesewas" bigint, "paid_pesewas" bigint, "active_order_id" "uuid", "active_order_number" "text", "recent_deliveries" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select u.id, u.full_name, u.phone, u.email,
         c.student_id_number, c.level,
         p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.face_image_path is not null,
         p.student_id_image_path is not null,
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select count(*) from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('FAILED_CUSTOMER_ABSENT','FAILED_NO_PARTNER')),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status <> 'CANCELLED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE')),
         (select coalesce(sum(po.amount_pesewas),0)::bigint from public.payouts po
           where po.payee_type = 'PARTNER' and po.payee_id = u.id and po.status = 'PAID'),
         (select o.id from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP')
           order by o.assigned_at limit 1),
         (select o.order_number from public.orders o
           where o.partner_id = u.id and o.delivery_status in ('ASSIGNED','PICKED_UP')
           order by o.assigned_at limit 1),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'order_id', o.id, 'order_number', o.order_number,
                     'order_type', o.order_type, 'delivery_status', o.delivery_status,
                     'earnings_pesewas', o.partner_earnings_pesewas,
                     'delivered_at', o.delivered_at, 'created_at', o.created_at
                   ) order by o.created_at desc)
             from (select * from public.orders o2 where o2.partner_id = u.id
                    order by o2.created_at desc limit 20) o), '[]'::jsonb)
    from public.users u
    join public.partner_profiles p on p.user_id = u.id
    left join public.customer_profiles c on c.user_id = u.id
    left join public.users r on r.id = p.reviewed_by
   where public.is_admin() and u.id = p_user_id;
$$;


ALTER FUNCTION "public"."admin_partner_detail"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_partner_documents_due_for_purge"() RETURNS TABLE("user_id" "uuid", "student_id_image_path" "text", "face_image_path" "text", "status" "public"."partner_application_status", "documents_purge_after" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.user_id, p.student_id_image_path, p.face_image_path,
         p.status, p.documents_purge_after
    from public.partner_profiles p
   where public.is_admin()
     and p.documents_purge_after is not null
     and p.documents_purge_after <= now()
     and (p.student_id_image_path is not null or p.face_image_path is not null)
   order by p.documents_purge_after asc;
$$;


ALTER FUNCTION "public"."admin_partner_documents_due_for_purge"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_partner_ratings"("p_partner_id" "uuid" DEFAULT NULL::"uuid", "p_max_stars" smallint DEFAULT NULL::smallint, "p_limit" integer DEFAULT 100) RETURNS TABLE("order_id" "uuid", "order_number" "text", "partner_id" "uuid", "partner_name" "text", "customer_id" "uuid", "customer_name" "text", "stars" smallint, "comment" "text", "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select r.order_id, o.order_number,
         r.partner_id, pu.full_name,
         r.customer_id, cu.full_name,
         r.stars, r.comment, r.created_at
    from public.partner_ratings r
    join public.orders o on o.id = r.order_id
    join public.users pu on pu.id = r.partner_id
    join public.users cu on cu.id = r.customer_id
   where public.is_admin()
     and (p_partner_id is null or r.partner_id = p_partner_id)
     and (p_max_stars is null or r.stars <= p_max_stars)
   order by r.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_partner_ratings"("p_partner_id" "uuid", "p_max_stars" smallint, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_partners"("p_status" "text" DEFAULT NULL::"text") RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "level" "text", "status" "public"."partner_application_status", "is_available" boolean, "is_suspended" boolean, "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "deliveries" bigint, "owed_pesewas" bigint, "rating_count" bigint, "average_stars" numeric, "payout_ready" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select u.id, u.full_name, u.phone, c.level, p.status, p.is_available, u.is_suspended,
         p.applied_at, p.reviewed_at,
         (select count(*) from public.orders o where o.partner_id = u.id and o.delivery_status = 'DELIVERED'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'PARTNER' and a.payee_id = u.id and a.status in ('PENDING','ELIGIBLE')),
         (select count(*) from public.partner_ratings r where r.partner_id = u.id),
         (select round(avg(r.stars), 2) from public.partner_ratings r where r.partner_id = u.id),
         exists (select 1 from public.payout_destinations d
                  where d.payee_type = 'PARTNER' and d.payee_id = u.id)
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
    left join public.customer_profiles c on c.user_id = u.id
   where public.is_admin()
     and (p_status is null or p.status::text = p_status)
   order by
     case p.status when 'PENDING_REVIEW' then 0 when 'APPROVED' then 1 else 2 end,
     p.applied_at desc nulls last;
$$;


ALTER FUNCTION "public"."admin_partners"("p_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_payments"("p_limit" integer DEFAULT 100) RETURNS TABLE("payment_id" "uuid", "order_id" "uuid", "order_number" "text", "provider" "text", "provider_transaction_id" "text", "amount_pesewas" bigint, "status" "public"."payment_txn_status", "failure_reason" "text", "created_at" timestamp with time zone, "succeeded_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.id, p.order_id, o.order_number, p.provider, p.provider_transaction_id,
         p.amount_pesewas, p.status, p.failure_reason, p.created_at, p.succeeded_at
    from public.payments p
    join public.orders o on o.id = p.order_id
   where public.is_admin()
   order by p.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_payments"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_payout_destinations"() RETURNS TABLE("payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "momo_network" "text", "account_number" "text", "account_name" "text", "provider" "text", "provider_recipient_code" "text", "provider_synced_at" timestamp with time zone, "provider_subaccount_code" "text", "subaccount_synced_at" timestamp with time zone, "subaccount_error" "text", "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select d.payee_type, d.payee_id,
         coalesce(v.name, u.full_name, u.phone),
         d.momo_network, d.account_number, d.account_name,
         d.provider, d.provider_recipient_code, d.provider_synced_at,
         d.provider_subaccount_code, d.subaccount_synced_at, d.subaccount_error,
         d.updated_at
    from public.payout_destinations d
    left join public.vendors v on d.payee_type = 'VENDOR'  and v.id = d.payee_id
    left join public.users   u on d.payee_type = 'PARTNER' and u.id = d.payee_id
   where public.is_admin()
   order by d.payee_type, coalesce(v.name, u.full_name, u.phone);
$$;


ALTER FUNCTION "public"."admin_payout_destinations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_payout_history"("p_payee_type" "public"."payee_type" DEFAULT NULL::"public"."payee_type", "p_status" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 100) RETURNS TABLE("payout_id" "uuid", "settlement_run_id" "uuid", "payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "amount_pesewas" bigint, "status" "public"."payout_status", "provider" "text", "provider_transfer_id" "text", "failure_reason" "text", "transfer_attempt" integer, "period_start" timestamp with time zone, "period_end" timestamp with time zone, "created_at" timestamp with time zone, "paid_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.id, p.settlement_run_id, p.payee_type, p.payee_id,
         case p.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           else 'Campus Dash'
         end,
         p.amount_pesewas, p.status, p.provider, p.provider_transfer_id,
         p.failure_reason, p.transfer_attempt,
         r.period_start, r.period_end,
         p.created_at, p.paid_at
    from public.payouts p
    left join public.settlement_runs r on r.id = p.settlement_run_id
   where public.is_admin()
     and (p_payee_type is null or p.payee_type = p_payee_type)
     and (p_status is null or btrim(p_status) = '' or p.status::text = p_status)
   order by p.created_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_payout_history"("p_payee_type" "public"."payee_type", "p_status" "text", "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_payout_readiness"() RETURNS TABLE("payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "has_destination" boolean, "momo_network" "text", "account_last3" "text", "split_ready" boolean, "transfers_ready" boolean, "setup_error" "text", "owed_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with payees as (
    select 'VENDOR'::public.payee_type as payee_type, v.id as payee_id, v.name as payee_name
      from public.vendors v
     where v.status = 'ACTIVE' and v.owner_user_id is not null
    union all
    select 'PARTNER'::public.payee_type, p.user_id, u.full_name
      from public.partner_profiles p
      join public.users u on u.id = p.user_id
     where p.status = 'APPROVED'
  )
  select k.payee_type, k.payee_id, k.payee_name,
         d.payee_id is not null,
         d.momo_network,
         right(d.account_number, 3),
         d.provider_subaccount_code is not null,
         d.provider_recipient_code is not null,
         d.subaccount_error,
         coalesce((select sum(a.amount_pesewas) from public.allocations a
                    where a.payee_type = k.payee_type and a.payee_id = k.payee_id
                      and a.status in ('PENDING', 'ELIGIBLE', 'SETTLING')), 0)::bigint
    from payees k
    left join public.payout_destinations d
      on d.payee_type = k.payee_type and d.payee_id = k.payee_id
   where public.is_admin()
   order by k.payee_type, (d.payee_id is not null), k.payee_name;
$$;


ALTER FUNCTION "public"."admin_payout_readiness"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_payout_readiness"() IS 'Every payee who could be owed money, and whether they can actually be paid. Shows the last three digits of an account and never the whole number — an operations screen needs to confirm a number is set, not read it out.';


CREATE OR REPLACE FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type" DEFAULT 'PARTNER'::"public"."payee_type") RETURNS TABLE("payout_id" "uuid", "settlement_run_id" "uuid", "payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "payee_phone" "text", "amount_pesewas" bigint, "status" "public"."payout_status", "created_at" timestamp with time zone, "period_start" timestamp with time zone, "period_end" timestamp with time zone, "momo_network" "text", "account_last3" "text", "account_name" "text", "deliveries" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.id,
         p.settlement_run_id,
         p.payee_type,
         p.payee_id,
         u.full_name,
         u.phone,
         p.amount_pesewas,
         p.status,
         p.created_at,
         r.period_start,
         r.period_end,
         d.momo_network,
         -- THE LAST THREE DIGITS, never the number. An operator checking they
         -- are paying the right person needs to recognise it, not to be able
         -- to read it off a screen in a shared office.
         case when d.account_number is not null
              then right(d.account_number, 3) end,
         d.account_name,
         (select count(*) from public.allocations a
           where a.settlement_run_id = p.settlement_run_id
             and a.payee_type = p.payee_type
             and a.payee_id = p.payee_id)
    from public.payouts p
    join public.settlement_runs r on r.id = p.settlement_run_id
    left join public.users u on u.id = p.payee_id
    left join public.payout_destinations d
           on d.payee_type = p.payee_type and d.payee_id = p.payee_id
   where public.is_admin()
     and p.payee_type = p_payee_type
     and p.status in ('PENDING', 'PROCESSING', 'FAILED')
   order by p.created_at desc;
$$;


ALTER FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type") IS 'The weekly settlement list: who is owed, how much, and where to send it. Returns only the last three digits of an account number — an operator needs to recognise a destination, not to be able to read one off a screen in a shared office.';


CREATE OR REPLACE FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") RETURNS TABLE("payee_id" "uuid", "payee_name" "text", "order_count" bigint, "owed_pesewas" bigint, "oldest_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select a.payee_id,
         case p_payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = a.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = a.payee_id)
           else 'Campus Dash'
         end,
         count(*),
         sum(a.amount_pesewas)::bigint,
         min(o.created_at)
    from public.allocations a
    join public.orders o on o.id = a.order_id
   where public.is_admin()
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
   group by a.payee_id
   order by sum(a.amount_pesewas) desc;
$$;


ALTER FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE("metric" "text", "value" numeric, "unit" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_admin() then
    return;  -- an empty result, not an error page
  end if;

  return query
  with bounds as (
    select coalesce(p_since, date_trunc('day', now())) as since
  ),
  o as (
    select orders.* from public.orders, bounds
     where orders.created_at >= bounds.since and orders.order_status <> 'DRAFT'
  )
  select 'orders_placed', count(*)::numeric, 'orders' from o
  union all
  select 'orders_accepted', count(*) filter (where accepted_at is not null)::numeric, 'orders' from o
  union all
  select 'orders_rejected', count(*) filter (where order_status = 'REJECTED')::numeric, 'orders' from o
  union all
  select 'orders_expired_no_vendor_answer',
         count(*) filter (where order_status = 'EXPIRED')::numeric, 'orders' from o
  union all
  select 'orders_completed', count(*) filter (where order_status = 'COMPLETED')::numeric, 'orders' from o
  union all
  select 'orders_cancelled',
         count(*) filter (where order_status in ('CANCELLED', 'CANCELLED_BY_VENDOR'))::numeric,
         'orders' from o
  union all
  select 'median_vendor_response_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (accepted_at - submitted_at)))::numeric, 'seconds'
    from o where accepted_at is not null
  union all
  select 'median_customer_pay_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (p.succeeded_at - o.accepted_at)))::numeric, 'seconds'
    from o join public.payments p on p.order_id = o.id and p.status = 'SUCCEEDED'
   where o.accepted_at is not null
  union all
  select 'median_prep_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (ready_at - preparing_at)))::numeric, 'seconds'
    from o where ready_at is not null and preparing_at is not null
  union all
  select 'median_partner_match_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (assigned_at - search_started_at)))::numeric, 'seconds'
    from o where assigned_at is not null and search_started_at is not null
  union all
  select 'median_delivery_seconds',
         percentile_cont(0.5) within group (
           order by extract(epoch from (delivered_at - picked_up_at)))::numeric, 'seconds'
    from o where delivered_at is not null and picked_up_at is not null
  union all
  select 'deliveries_requested',
         count(*) filter (where fulfilment_type = 'DELIVERY')::numeric, 'orders' from o
  union all
  select 'deliveries_no_partner_found',
         count(*) filter (where delivery_status = 'FAILED_NO_PARTNER')::numeric, 'orders' from o
  union all
  select 'deliveries_customer_absent',
         count(*) filter (where delivery_status = 'FAILED_CUSTOMER_ABSENT')::numeric, 'orders' from o
  union all
  select 'partner_cancellations',
         (select count(*) from public.order_events e, bounds
           where e.event = 'PARTNER_CANCEL' and e.accepted and e.created_at >= bounds.since)::numeric,
         'events'
  union all
  select 'disputes_open',
         count(*) filter (where disputed_at is not null and dispute_resolved_at is null)::numeric,
         'orders' from o
  union all
  select 'partners_approved',
         (select count(*) from public.partner_profiles where status = 'APPROVED')::numeric, 'partners'
  union all
  select 'partners_online_now',
         (select count(*) from public.partner_profiles
           where status = 'APPROVED' and is_available)::numeric, 'partners'
  union all
  select 'partners_on_a_delivery_now',
         (select count(distinct partner_id) from public.orders
           where delivery_status in ('ASSIGNED', 'PICKED_UP'))::numeric, 'partners'
  union all
  select 'collected_pesewas',
         coalesce(sum(total_pesewas) filter (where payment_status = 'PAID'), 0)::numeric, 'pesewas'
    from o
  union all
  select 'unsettled_pesewas',
         (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
           where a.status in ('PENDING', 'ELIGIBLE', 'SETTLING'))::numeric, 'pesewas'
  union all
  select 'settled_pesewas',
         (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
           where a.status = 'SETTLED')::numeric, 'pesewas'
  union all
  select 'payouts_failed',
         (select count(*) from public.payouts where status = 'FAILED')::numeric, 'payouts'
  union all
  select 'reconciliation_issues',
         (select count(*) from public.admin_reconciliation(500))::numeric, 'issues'
  union all
  select 'notifications_sent',
         (select count(*) from public.notification_events n, bounds
           where n.succeeded and n.created_at >= bounds.since)::numeric, 'messages'
  union all
  select 'notifications_failed',
         (select count(*) from public.notification_events n, bounds
           where not n.succeeded and n.created_at >= bounds.since)::numeric, 'messages'
  union all
  select 'notifications_per_order',
         case when (select count(*) from o) = 0 then 0
              else round(
                (select count(*) from public.notification_events n, bounds
                  where n.succeeded and n.created_at >= bounds.since)::numeric
                / (select count(*) from o), 2) end,
         'messages';
end;
$$;


ALTER FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") RETURNS TABLE("provider_transaction_id" "text", "kind" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.provider_transaction_id, 'collection'
    from public.payments p
   where public.is_admin() and p.provider = p_provider
     and p.provider_transaction_id is not null
  union all
  select po.provider_transfer_id, 'transfer'
    from public.payouts po
   where public.is_admin() and po.provider = p_provider
     and po.provider_transfer_id is not null;
$$;


ALTER FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_purge_test_accounts"("p_user_ids" "uuid"[], "p_reason" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_users    uuid[] := coalesce(p_user_ids, '{}');
  v_reason   text   := nullif(btrim(coalesce(p_reason, '')), '');
  v_vendors  uuid[];
  v_payees   uuid[];
  v_orders   uuid[];
  v_payments text[];
  v_runs     uuid[];
  v_paths    jsonb;
  v_counts   jsonb := '{}'::jsonb;
  v_n        integer;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = 'insufficient_privilege';
  end if;

  if array_length(v_users, 1) is null then
    raise exception 'name the accounts to purge' using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  if auth.uid() = any(v_users) then
    raise exception 'an administrator cannot purge their own account'
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.users u where u.id = any(v_users) and u.is_admin)
     or exists (select 1 from public.admin_actions a where a.admin_user_id = any(v_users))
  then
    raise exception 'an administrator account cannot be purged'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(v.id), '{}') into v_vendors
    from public.vendors v where v.owner_user_id = any(v_users);

  v_payees := v_users || v_vendors;

  if exists (
    select 1 from public.payouts p
     where p.payee_id = any(v_payees) and p.status = 'PROCESSING'
  ) then
    raise exception 'a payout to one of these accounts is still PROCESSING; resolve it first'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(o.id), '{}') into v_orders
    from public.orders o
   where o.customer_id = any(v_users)
      or o.partner_id  = any(v_users)
      or o.vendor_id   = any(v_vendors);

  select coalesce(array_agg(p.provider_transaction_id) filter (where p.provider_transaction_id is not null), '{}')
    into v_payments
    from public.payments p where p.order_id = any(v_orders);

  -- The object paths, read before the rows that name them are gone.
  select jsonb_build_object(
    'vendor-images',
      coalesce((select jsonb_agg(i.storage_path) from public.vendor_images i
                 where i.vendor_id = any(v_vendors) and i.storage_path is not null), '[]'),
    'partner-documents',
      coalesce((select jsonb_agg(x.path) from public.partner_profiles pp,
                  lateral (values (pp.student_id_image_path), (pp.face_image_path)) as x(path)
                 where pp.user_id = any(v_users) and x.path is not null), '[]'),
    'scan-documents',
      coalesce((select jsonb_agg(s.image_path) from public.order_scans s
                 where (s.order_id = any(v_orders) or s.customer_id = any(v_users))
                   and s.image_path is not null), '[]')
  ) into v_paths;

  -- 1. The append-only rows, through the existing audited mechanism. It opens
  --    and closes its own transaction-local door; nothing here touches it.
  v_n := public.admin_purge_test_history(v_users, v_orders, v_reason);
  v_counts := v_counts || jsonb_build_object('notification_events', v_n);

  -- 2. Webhook deliveries that name a payment being removed. Matched on the
  --    provider's reference appearing in the payload, so no provider's payload
  --    shape is written into the schema.
  delete from public.webhook_events w
   where exists (
     select 1 from unnest(v_payments) as ref
      where strpos(w.payload::text, ref) > 0
   );
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('webhook_events', v_n);

  -- 3. Money. Allocations and payments are RESTRICT on the order; payouts are
  --    RESTRICT on their run. The balance trigger accepts an order with no
  --    allocations left, which is the state this leaves.
  delete from public.allocations a
   where a.order_id = any(v_orders) or a.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('allocations', v_n);

  delete from public.payments p where p.order_id = any(v_orders);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payments', v_n);

  -- A run goes only if every payout in it belonged to these payees and no
  -- other allocation still points at it. A run that paid anyone else stays.
  select coalesce(array_agg(r.id), '{}') into v_runs
    from public.settlement_runs r
   where exists (select 1 from public.payouts p where p.settlement_run_id = r.id and p.payee_id = any(v_payees))
     and not exists (select 1 from public.payouts p where p.settlement_run_id = r.id and not (p.payee_id = any(v_payees)))
     and not exists (select 1 from public.allocations a where a.settlement_run_id = r.id);

  delete from public.payouts p where p.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payouts', v_n);

  delete from public.settlement_runs r where r.id = any(v_runs);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('settlement_runs', v_n);

  delete from public.payout_destinations d where d.payee_id = any(v_payees);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('payout_destinations', v_n);

  -- 4. Orders. Items, secrets, scans and ratings cascade; their order_events
  --    and notification rows are already gone, so nothing append-only is hit.
  select count(*) into v_n from public.order_items where order_id = any(v_orders);
  v_counts := v_counts || jsonb_build_object('order_items', v_n);
  select count(*) into v_n from public.order_secrets where order_id = any(v_orders);
  v_counts := v_counts || jsonb_build_object('order_secrets', v_n);

  delete from public.order_scans s where s.order_id = any(v_orders) or s.customer_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('order_scans', v_n);

  delete from public.partner_ratings r
   where r.order_id = any(v_orders) or r.partner_id = any(v_users) or r.customer_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_ratings', v_n);

  delete from public.orders o where o.id = any(v_orders);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('orders', v_n);

  -- 5. Stores. Menu items, images and the daily queue counters cascade.
  select count(*) into v_n from public.menu_items where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('menu_items', v_n);
  select count(*) into v_n from public.vendor_images where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('vendor_images', v_n);
  select count(*) into v_n from public.vendor_order_counters where vendor_id = any(v_vendors);
  v_counts := v_counts || jsonb_build_object('vendor_order_counters', v_n);

  delete from public.vendors v where v.id = any(v_vendors);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('vendors', v_n);

  -- 6. Capabilities, in the order the foreign keys require: a Partner before
  --    the customer profile it upgrades.
  delete from public.idempotency_keys k where k.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n);

  delete from public.customer_rewards r where r.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_rewards', v_n);

  delete from public.terms_acceptances t where t.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('terms_acceptances', v_n);

  delete from public.partner_profiles p where p.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('partner_profiles', v_n);

  delete from public.customer_profiles c where c.user_id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('customer_profiles', v_n);

  -- 7. The identity. public.users cascades from auth.users, and so do the
  --    account's sessions, identities and factors.
  delete from auth.users u where u.id = any(v_users);
  get diagnostics v_n = row_count;
  v_counts := v_counts || jsonb_build_object('auth_users', v_n);

  perform public.log_admin_action(
    'TEST_ACCOUNTS_PURGED',
    'users',
    null,
    v_reason,
    null,
    null,
    jsonb_build_object(
      'user_ids', to_jsonb(v_users),
      'vendor_ids', to_jsonb(v_vendors),
      'order_ids', to_jsonb(v_orders),
      'counts', v_counts
    )
  );

  return jsonb_build_object('counts', v_counts, 'storage_paths', v_paths);
end;
$$;


ALTER FUNCTION "public"."admin_purge_test_accounts"("p_user_ids" "uuid"[], "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_purge_test_accounts"("p_user_ids" "uuid"[], "p_reason" "text") IS 'Removes named pilot test accounts with every capability, store, order and money record that belongs to them, in one transaction. Reuses admin_purge_test_history() for the append-only rows. Refuses administrators, the caller, an empty list, a missing reason and PROCESSING payouts. Administrator only, re-checked in the body; executable by no client role; audited to admin_actions. Returns counts and the storage object paths the caller must remove through the Storage API.';


CREATE OR REPLACE FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_order_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_reason" "text" DEFAULT NULL::"text") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_users  uuid[] := coalesce(p_user_ids, '{}');
  v_orders uuid[] := coalesce(p_order_ids, '{}');
  v_reason text   := nullif(btrim(coalesce(p_reason, '')), '');
  v_count  integer;
  v_events integer := 0;
begin
  if not public.is_admin() then
    raise exception 'administrator access required' using errcode = 'insufficient_privilege';
  end if;

  -- No ids is not "all rows". A purge has to name what it is forgetting.
  if array_length(v_users, 1) is null and array_length(v_orders, 1) is null then
    raise exception 'name the accounts or orders to purge' using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'a reason is required — it is what the audit log shows'
      using errcode = 'check_violation';
  end if;

  -- Transaction-local, and the only thing that opens the trigger's one door.
  perform set_config('campus_dash.notification_purge', 'on', true);

  delete from public.notification_events
   where (user_id  = any(v_users))
      or (order_id = any(v_orders));
  get diagnostics v_count = row_count;

  -- The order's own history, so the order itself can then be removed. Scoped to
  -- the named orders; an account with no orders named clears nothing here.
  delete from public.order_events where order_id = any(v_orders);
  get diagnostics v_events = row_count;

  -- Shut it again immediately. The flag would die with the transaction anyway;
  -- closing it here means the rest of this transaction cannot delete more.
  perform set_config('campus_dash.notification_purge', 'off', true);

  perform public.log_admin_action(
    'TEST_HISTORY_PURGED',
    'notification_events',
    null,
    v_reason,
    null,
    null,
    jsonb_build_object(
      'notification_rows_deleted', v_count,
      'order_event_rows_deleted', v_events,
      'user_ids', to_jsonb(v_users),
      'order_ids', to_jsonb(v_orders)
    )
  );

  return v_count;
end;
$$;


ALTER FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[], "p_order_ids" "uuid"[], "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[], "p_order_ids" "uuid"[], "p_reason" "text") IS 'Deletes delivery-log and order-history rows for the named accounts and orders. Administrator only, re-checked in the body; refuses an empty target list and a missing reason; audited to admin_actions. The only thing that may delete from notification_events or order_events. admin_actions itself has no such escape.';


CREATE OR REPLACE FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
  v_cfg    public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_cfg from public.pricing_config where id;
  select * into v_before from public.orders where id = p_order_id;

  update public.orders o
     set partner_id = null, partner_slot = null, delivery_status = 'SEARCHING',
         assigned_at = null, picked_up_at = null,
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds),
         dispatch_generation = o.dispatch_generation + 1,
         -- The store is back in it: whoever comes next has to be handed the
         -- food, so the order returns to their board.
         vendor_completed_at = null
   where o.id = p_order_id
     and o.fulfilment_type = 'DELIVERY'
     -- FAILED_CUSTOMER_ABSENT deliberately excluded: that Partner is owed money.
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER')
  returning * into v_after;

  if not found then
    raise exception 'order has no reassignable delivery' using errcode = 'check_violation';
  end if;

  update public.order_secrets
     set pickup_code = null,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = null
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'ADMIN_REASSIGN', true, 'ADMIN',
    'delivery_status', v_before.delivery_status::text, 'SEARCHING', p_reason,
    jsonb_build_object('previous_partner_id', v_before.partner_id,
                       'pickup_code_rotated', true,
                       'dispatch_generation', v_after.dispatch_generation));
  perform public.log_admin_action('DELIVERY_REASSIGN', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") RETURNS TABLE("issue" "text", "provider_transaction_id" "text", "order_number" "text", "our_status" "text", "provider_status" "text", "our_amount_pesewas" bigint, "provider_amount_pesewas" bigint, "detail" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with theirs as (
    select r ->> 'provider_transaction_id' as txn,
           upper(r ->> 'status')           as status,
           (r ->> 'amount_pesewas')::bigint as amount,
           coalesce(r ->> 'kind', 'collection') as kind
      from jsonb_array_elements(coalesce(p_provider_rows, '[]'::jsonb)) r
     where public.is_admin()
  ),
  ours as (
    select p.provider_transaction_id as txn,
           p.status::text            as status,
           p.amount_pesewas          as amount,
           o.order_number
      from public.payments p
      join public.orders o on o.id = p.order_id
     where public.is_admin() and p.provider = p_provider
  ),
  transfers_ours as (
    select po.provider_transfer_id as txn,
           po.status::text         as status,
           po.amount_pesewas       as amount
      from public.payouts po
     where public.is_admin() and po.provider = p_provider
  )

  -- The provider took money we have no record of. The worst case: a customer
  -- was charged and we never credited anyone.
  select 'PROVIDER_ONLY', t.txn, null, null, t.status, null, t.amount,
         'the provider reports a transaction we have no payment row for'
    from theirs t
   where t.kind = 'collection'
     and not exists (select 1 from ours o where o.txn = t.txn)

  union all

  -- We think we collected; the provider has never heard of it.
  select 'MISSING_AT_PROVIDER', o.txn, o.order_number, o.status, null, o.amount, null,
         'we recorded a succeeded payment the provider does not report'
    from ours o
   where o.status = 'SUCCEEDED'
     and o.txn is not null
     and not exists (select 1 from theirs t where t.txn = o.txn and t.kind = 'collection')

  union all

  -- Both know it, and disagree about the amount.
  select 'AMOUNT_MISMATCH', o.txn, o.order_number, o.status, t.status, o.amount, t.amount,
         format('we recorded %s, the provider reports %s', o.amount, t.amount)
    from ours o
    join theirs t on t.txn = o.txn and t.kind = 'collection'
   where o.amount <> t.amount

  union all

  -- Both know it, and disagree about whether it happened.
  select 'STATUS_MISMATCH', o.txn, o.order_number, o.status, t.status, o.amount, t.amount,
         format('we say %s, the provider says %s', o.status, t.status)
    from ours o
    join theirs t on t.txn = o.txn and t.kind = 'collection'
   where (o.status = 'SUCCEEDED') <> (t.status = 'SUCCEEDED')

  union all

  -- A transfer we believe we sent that the provider has no record of. This is
  -- the direction that silently under-pays a vendor or Partner.
  select 'TRANSFER_MISSING_AT_PROVIDER', po.txn, null, po.status, null, po.amount, null,
         'we recorded a paid payout the provider does not report'
    from transfers_ours po
   where po.status = 'PAID'
     and po.txn is not null
     and not exists (select 1 from theirs t where t.txn = po.txn and t.kind = 'transfer')

  union all

  -- A transfer the provider made that we did not ask for.
  select 'TRANSFER_PROVIDER_ONLY', t.txn, null, null, t.status, null, t.amount,
         'the provider reports a transfer we have no payout row for'
    from theirs t
   where t.kind = 'transfer'
     and not exists (select 1 from transfers_ours po where po.txn = t.txn)

  union all

  -- A provider event we stored but never acted on. Often the first sign that a
  -- webhook handler is failing quietly.
  select 'WEBHOOK_UNPROCESSED', w.event_id, null, w.status::text, null, null, null,
         coalesce(w.error, 'event received but never processed')
    from public.webhook_events w
   where public.is_admin()
     and w.provider = p_provider
     and w.status in ('RECEIVED', 'FAILED')
     and w.received_at < now() - interval '10 minutes';
$$;


ALTER FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_reconciliation"("p_limit" integer DEFAULT 200) RETURNS TABLE("order_id" "uuid", "order_number" "text", "issue" "text", "detail" "text", "total_pesewas" bigint, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with paid as (
    select o.* from public.orders o where public.is_admin() and o.payment_status = 'PAID'
  ),
  problems as (
    -- Paid, but nothing was allocated.
    select p.id, p.order_number, 'NO_ALLOCATIONS'::text as issue,
           'order is PAID but has no allocations'::text as detail,
           p.total_pesewas, p.created_at
      from paid p
     where not exists (select 1 from public.allocations a where a.order_id = p.id)

    union all

    -- Allocated, but the parts do not add up to the whole.
    select p.id, p.order_number, 'ALLOCATION_MISMATCH',
           format('allocations sum to %s but the order total is %s',
                  (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
                    where a.order_id = p.id and a.status <> 'CANCELLED'),
                  p.total_pesewas),
           p.total_pesewas, p.created_at
      from paid p
     where exists (select 1 from public.allocations a where a.order_id = p.id)
       and (select coalesce(sum(a.amount_pesewas), 0) from public.allocations a
             where a.order_id = p.id and a.status <> 'CANCELLED') <> p.total_pesewas

    union all

    -- Our record says PAID; the provider record does not say SUCCEEDED.
    select p.id, p.order_number, 'PROVIDER_MISMATCH',
           'order is PAID but no succeeded payment row exists',
           p.total_pesewas, p.created_at
      from paid p
     where not exists (
       select 1 from public.payments pay
        where pay.order_id = p.id and pay.status = 'SUCCEEDED'
     )

    union all

    -- The provider took a different amount from the one we asked for.
    select p.id, p.order_number, 'AMOUNT_MISMATCH',
           format('payment captured %s but the order total is %s',
                  pay.amount_pesewas, p.total_pesewas),
           p.total_pesewas, p.created_at
      from paid p
      join public.payments pay on pay.order_id = p.id and pay.status = 'SUCCEEDED'
     where pay.amount_pesewas <> p.total_pesewas

    union all

    -- Delivered, but the Partner was never allocated anything.
    select o.id, o.order_number, 'PARTNER_UNPAID',
           'delivery completed but no Partner allocation exists',
           o.total_pesewas, o.created_at
      from public.orders o
     where public.is_admin()
       and o.delivery_status in ('DELIVERED', 'FAILED_CUSTOMER_ABSENT')
       and o.partner_earnings_pesewas > 0
       and not exists (
         select 1 from public.allocations a
          where a.order_id = o.id and a.payee_type = 'PARTNER'
       )
  )
  select * from problems order by created_at desc limit least(coalesce(p_limit, 200), 500);
$$;


ALTER FUNCTION "public"."admin_reconciliation"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "public"."orders"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.orders%rowtype;
  v_after  public.orders%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.orders where id = p_order_id;
  if not found or v_before.disputed_at is null then
    raise exception 'no open dispute on this order' using errcode = 'no_data_found';
  end if;

  update public.orders set dispute_resolved_at = now() where id = p_order_id
  returning * into v_after;

  perform public.log_order_event(p_order_id, 'DISPUTE_RESOLVED', true, 'ADMIN',
    null, null, null, p_notes);
  perform public.log_admin_action('DISPUTE_RESOLVE', 'order', p_order_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after));

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text" DEFAULT NULL::"text") RETURNS "public"."partner_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.partner_profiles%rowtype;
  v_after  public.partner_profiles%rowtype;
  v_cfg    public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('APPROVED', 'REJECTED', 'SUSPENDED') then
    raise exception 'review status must be APPROVED, REJECTED or SUSPENDED'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.partner_profiles where user_id = p_user_id;
  if not found then
    raise exception 'no partner application for this user' using errcode = 'no_data_found';
  end if;

  select * into v_cfg from public.pricing_config where id;

  update public.partner_profiles
     set status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         review_notes = p_notes,
         is_available = case when p_status = 'APPROVED' then is_available else false end,
         documents_purge_after = case
           when p_status = 'APPROVED'
             then now() + make_interval(days => v_cfg.approved_document_retention_days)
           else now() + make_interval(days => v_cfg.rejected_document_retention_days) end
   where user_id = p_user_id
  returning * into v_after;

  perform public.log_admin_action(
    'PARTNER_' || p_status::text, 'partner_profile', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_review_vendor"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('ACTIVE', 'REJECTED') then
    raise exception 'a review decision is APPROVE (ACTIVE) or REJECT (REJECTED)'
      using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required, and is recorded in the audit log'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  update public.vendors
     set status = p_status,
         rejection_reason = case when p_status = 'REJECTED' then btrim(p_reason) end,
         reviewed_at = now(),
         reviewed_by = auth.uid(),
         -- APPROVAL DOES NOT OPEN THE STORE. Going live is the vendor's own
         -- decision, made when they are actually standing behind the counter.
         is_accepting_orders = false
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    case when p_status = 'ACTIVE' then 'VENDOR_APPROVED' else 'VENDOR_REJECTED' end,
    'vendor', p_vendor_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_review_vendor"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "customer_name" "text", "restaurant_name" "text", "destination" "text", "details" "text", "scan_status" "public"."scan_status", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "partner_name" "text", "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "partner_earnings_pesewas" bigint, "total_pesewas" bigint, "has_scan_image" boolean, "uploaded_at" timestamp with time zone, "released_at" timestamp with time zone, "redeemed_at" timestamp with time zone, "refused_at" timestamp with time zone, "refusal_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    o.id, o.order_number,
    c.full_name, v.name, public.location_path(o.destination_location_id),
    s.details,
    o.scan_status, o.order_status, o.payment_status, o.delivery_status,
    p.full_name,
    o.service_fee_pesewas, o.delivery_fee_pesewas, o.partner_earnings_pesewas, o.total_pesewas,
    (s.image_path is not null),
    s.uploaded_at, s.released_at, s.redeemed_at, s.refused_at, s.refusal_reason
  from public.orders o
  join public.users c on c.id = o.customer_id
  join public.vendors v on v.id = o.vendor_id
  left join public.users p on p.id = o.partner_id
  left join public.order_scans s on s.order_id = o.id
  where o.id = p_order_id
    and o.order_type = 'SCAN'
    and public.is_admin();
$$;


ALTER FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_scheduled_job_status"() RETURNS TABLE("jobname" "text", "schedule" "text", "active" boolean, "last_run" timestamp with time zone, "last_status" "text", "last_error" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select j.jobname::text,
         j.schedule::text,
         j.active,
         r.start_time,
         r.status::text,
         r.return_message::text
    from cron.job j
    left join lateral (
      select start_time, status, return_message
        from cron.job_run_details d
       where d.jobid = j.jobid
       order by d.start_time desc
       limit 1
    ) r on true
   where public.is_admin()
     and j.jobname like 'campus-dash-%'
   order by j.jobname;
$$;


ALTER FUNCTION "public"."admin_scheduled_job_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_location_active"("p_location_id" "uuid", "p_active" boolean, "p_reason" "text") RETURNS "public"."locations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.locations%rowtype;
  v_after  public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;

  update public.locations set is_active = p_active where id = p_location_id
  returning * into v_after;

  -- Deactivating a block must not leave its rooms selectable underneath it.
  if not p_active then
    update public.locations set is_active = false
     where id in (
       with recursive descendants as (
         select id from public.locations where parent_id = p_location_id
         union all
         select l.id from public.locations l join descendants d on l.parent_id = d.id
       )
       select id from descendants
     );
  end if;

  perform public.log_admin_action(
    case when p_active then 'LOCATION_ACTIVATE' else 'LOCATION_DEACTIVATE' end,
    'location', p_location_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_set_location_active"("p_location_id" "uuid", "p_active" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.menu_items%rowtype;
  v_after  public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  update public.menu_items set is_available = p_available
   where id = p_menu_item_id
  returning * into v_after;

  perform public.log_admin_action(
    case when p_available then 'MENU_ITEM_ENABLE' else 'MENU_ITEM_DISABLE' end,
    'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payout_destinations" (
    "payee_type" "public"."payee_type" NOT NULL,
    "payee_id" "uuid" NOT NULL,
    "momo_network" "text" NOT NULL,
    "account_number" "text" NOT NULL,
    "account_name" "text" NOT NULL,
    "provider" "text",
    "provider_recipient_code" "text",
    "provider_synced_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "provider_subaccount_code" "text",
    "subaccount_synced_at" timestamp with time zone,
    "subaccount_error" "text",
    CONSTRAINT "payout_destinations_account_name_check" CHECK (("btrim"("account_name") <> ''::"text")),
    CONSTRAINT "payout_destinations_account_number_check" CHECK (("account_number" ~ '^0[0-9]{9}$'::"text")),
    CONSTRAINT "payout_destinations_code_needs_provider" CHECK ((("provider_recipient_code" IS NULL) OR ("provider" IS NOT NULL))),
    CONSTRAINT "payout_destinations_momo_network_check" CHECK (("momo_network" = ANY (ARRAY['MTN'::"text", 'VODAFONE'::"text", 'AIRTELTIGO'::"text"]))),
    CONSTRAINT "payout_destinations_not_platform" CHECK (("payee_type" <> 'PLATFORM'::"public"."payee_type")),
    CONSTRAINT "payout_destinations_subaccount_needs_provider" CHECK ((("provider_subaccount_code" IS NULL) OR ("provider" IS NOT NULL)))
);


ALTER TABLE "public"."payout_destinations" OWNER TO "postgres";


COMMENT ON TABLE "public"."payout_destinations" IS 'Where settlement money goes. Server-only: no client role holds any grant.';


COMMENT ON COLUMN "public"."payout_destinations"."provider_subaccount_code" IS 'Paystack subaccount code (ACCT_…) for this mobile money account. Present means the vendor''s share can be split off the charge itself; absent means their money is settled by the payout run instead. Never returned to a client.';


COMMENT ON COLUMN "public"."payout_destinations"."subaccount_error" IS 'Why the last attempt to register a subaccount failed. Read by administrators; the vendor is told only that setup is incomplete.';


CREATE OR REPLACE FUNCTION "public"."admin_set_payout_destination"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text", "p_reason" "text") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_before public.payout_destinations%rowtype;
  v_after  public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Accept the E.164 form people paste out of a phone book and store the local
  -- one Paystack wants. Rejecting +233… here would just move the conversion
  -- into whoever is typing.
  if left(v_number, 4) = '+233' then
    v_number := '0' || substring(v_number from 5);
  elsif left(v_number, 3) = '233' then
    v_number := '0' || substring(v_number from 4);
  end if;

  if v_number !~ '^0[0-9]{9}$' then
    raise exception 'a Ghanaian mobile money number is required, e.g. 0551234567'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_account_name, '')), '') is null then
    raise exception 'the name on the mobile money account is required'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.payout_destinations
   where payee_type = p_payee_type and payee_id = p_payee_id;

  insert into public.payout_destinations (
    payee_type, payee_id, momo_network, account_number, account_name
  )
  values (p_payee_type, p_payee_id, p_momo_network, v_number, btrim(p_account_name))
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         -- A changed destination invalidates the provider's recipient. Keeping
         -- it would send the next transfer to the OLD number.
         provider                = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider end,
         provider_recipient_code = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at      = case
           when public.payout_destinations.account_number <> excluded.account_number
             or public.payout_destinations.momo_network   <> excluded.momo_network
           then null else public.payout_destinations.provider_synced_at end
  returning * into v_after;

  perform public.log_admin_action(
    'PAYOUT_DESTINATION_SET', lower(p_payee_type::text), p_payee_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$_$;


ALTER FUNCTION "public"."admin_set_payout_destination"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "phone" "text",
    "full_name" "text",
    "is_admin" boolean DEFAULT false NOT NULL,
    "is_suspended" boolean DEFAULT false NOT NULL,
    "student_verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "email" "text",
    "first_name" "text",
    "last_name" "text",
    CONSTRAINT "users_email_shape" CHECK ((("email" IS NULL) OR ("email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::"text"))),
    CONSTRAINT "users_phone_e164" CHECK (("phone" ~ '^\+[1-9]\d{7,14}$'::"text"))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."phone" IS 'Contact number in E.164. For a VENDOR this is also the sign-in credential; for a CUSTOMER it is the number a Partner rings on arrival; for an ADMIN it is NULL, because administrators sign in with a password and must not depend on SMS to reach the console. Unique when present — one number never backs two identities.';


COMMENT ON COLUMN "public"."users"."full_name" IS 'DERIVED from first_name and last_name by users_sync_full_name(). Still the one column every read model selects for a display name; no longer a separate fact that can drift from the parts.';


COMMENT ON COLUMN "public"."users"."email" IS 'For a CUSTOMER this is the verified @acity.edu.gh address that IS the sign-in credential. For an ADMIN it is the password login. For a VENDOR it is usually NULL — vendors sign in by phone and are never asked for an email.';


COMMENT ON COLUMN "public"."users"."first_name" IS 'Given name. What a Partner is called to a customer and a customer to a Partner — never a surname, never a phone number.';


COMMENT ON COLUMN "public"."users"."last_name" IS 'Family name. Shown to administrators and on the account screen; never to the other side of a delivery.';


CREATE OR REPLACE FUNCTION "public"."admin_set_user_suspended"("p_user_id" "uuid", "p_suspended" boolean, "p_reason" "text") RETURNS "public"."users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.users%rowtype;
  v_after  public.users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  if p_suspended is null then
    raise exception 'suspend or unsuspend must be stated explicitly'
      using errcode = 'check_violation';
  end if;

  -- admin_actions enforces this too, but failing here names the missing field
  -- instead of surfacing a constraint violation on a table the operator has
  -- never heard of.
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'a reason is required, and is recorded in the audit log'
      using errcode = 'check_violation';
  end if;

  -- SELF-SUSPENSION IS REFUSED, IN SQL.
  --
  -- is_admin() is `is_admin and not is_suspended`. An administrator suspending
  -- their own account therefore revokes, in the same statement, the authority
  -- needed to reverse it — and if they are the only administrator, the console
  -- is gone until somebody opens a SQL client against production. The UI hides
  -- the control; this is what actually stops it.
  --
  -- Suspending ANOTHER administrator is allowed and deliberately so: that is a
  -- real thing an operator may need to do, and the target keeps a colleague who
  -- can undo it.
  if p_suspended and p_user_id = auth.uid() then
    raise exception 'you cannot suspend your own account; ask another administrator'
      using errcode = 'check_violation';
  end if;

  select * into v_before from public.users where id = p_user_id;
  if not found then
    raise exception 'no such user' using errcode = 'no_data_found';
  end if;

  update public.users
     set is_suspended = p_suspended
   where id = p_user_id
  returning * into v_after;

  -- A suspended Partner must also stop being offered deliveries. is_available
  -- is the dispatch flag, and leaving it true would keep the account in the
  -- offer pool right up until is_approved_partner() rejected the acceptance —
  -- a Partner watching offers appear and fail. Reinstatement does NOT set it
  -- back: going online is the Partner's own decision, not an admin's.
  if p_suspended then
    update public.partner_profiles
       set is_available = false
     where user_id = p_user_id and is_available;
  end if;

  perform public.log_admin_action(
    case when p_suspended then 'USER_SUSPENDED' else 'USER_UNSUSPENDED' end,
    'user', p_user_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_set_user_suspended"("p_user_id" "uuid", "p_suspended" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_vendor_scans"("p_vendor_id" "uuid", "p_accepts" boolean, "p_reason" "text") RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  update public.vendors
     set can_accept_scans = p_accepts
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_SCANS_SET', 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_set_vendor_scans"("p_vendor_id" "uuid", "p_accepts" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;

  update public.vendors
     set status = p_status,
         -- A suspended vendor cannot be left silently taking orders.
         is_accepting_orders = case when p_status = 'ACTIVE' then is_accepting_orders else false end
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_STATUS_' || p_status::text, 'vendor', p_vendor_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customer_rewards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cycle" integer NOT NULL,
    "goal_orders" integer NOT NULL,
    "completed_orders_at_unlock" integer NOT NULL,
    "status" "text" DEFAULT 'UNLOCKED'::"text" NOT NULL,
    "unlocked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "fulfilled_at" timestamp with time zone,
    "fulfilled_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "customer_rewards_cycle_check" CHECK (("cycle" > 0)),
    CONSTRAINT "customer_rewards_fulfilled_pair" CHECK ((("status" = 'FULFILLED'::"text") = ("fulfilled_at" IS NOT NULL))),
    CONSTRAINT "customer_rewards_goal_check" CHECK (("goal_orders" > 0)),
    CONSTRAINT "customer_rewards_status_check" CHECK (("status" = ANY (ARRAY['UNLOCKED'::"text", 'FULFILLED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."customer_rewards" OWNER TO "postgres";


COMMENT ON TABLE "public"."customer_rewards" IS 'One row per customer per completed run of the order goal. Reaching the goal writes it once; every order after that finds the row already there. Campus Dash decides what the reward actually is — this records only that somebody qualified.';


CREATE OR REPLACE FUNCTION "public"."admin_settle_customer_reward"("p_reward_id" "uuid", "p_notes" "text") RETURNS "public"."customer_rewards"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_row public.customer_rewards%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_notes, '')), '') is null then
    raise exception 'say what was given' using errcode = 'check_violation';
  end if;

  update public.customer_rewards
     set status = 'FULFILLED', fulfilled_at = now(), fulfilled_by = auth.uid(),
         notes = btrim(p_notes)
   where id = p_reward_id and status = 'UNLOCKED'
  returning * into v_row;

  if not found then
    raise exception 'that reward is not open' using errcode = 'check_violation';
  end if;

  perform public.log_admin_action('SETTLE_CUSTOMER_REWARD', 'customer_reward', p_reward_id,
    btrim(p_notes), jsonb_build_object('user_id', v_row.user_id, 'cycle', v_row.cycle));

  return v_row;
end;
$$;


ALTER FUNCTION "public"."admin_settle_customer_reward"("p_reward_id" "uuid", "p_notes" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payouts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "settlement_run_id" "uuid" NOT NULL,
    "payee_type" "public"."payee_type" NOT NULL,
    "payee_id" "uuid" NOT NULL,
    "amount_pesewas" bigint NOT NULL,
    "currency" "text" DEFAULT 'GHS'::"text" NOT NULL,
    "status" "public"."payout_status" DEFAULT 'PENDING'::"public"."payout_status" NOT NULL,
    "provider" "text",
    "provider_transfer_id" "text",
    "idempotency_key" "text" NOT NULL,
    "failure_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "paid_at" timestamp with time zone,
    "transfer_attempt" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "payouts_amount_pesewas_check" CHECK (("amount_pesewas" > 0)),
    CONSTRAINT "payouts_currency_check" CHECK (("currency" = 'GHS'::"text"))
);


ALTER TABLE "public"."payouts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."payouts"."transfer_attempt" IS 'Number of transfer attempts made. Drives the provider reference so a retry is never a duplicate; our payout id and idempotency_key are unchanged by it.';


CREATE OR REPLACE FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") RETURNS "public"."payouts"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.payouts%rowtype;
  v_payout public.payouts%rowtype;
  v_ref    text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- IDEMPOTENT REPLAY. A double-tapped button must not write a second audit
  -- entry claiming the money was sent twice.
  if v_before.status = 'PAID' then
    return v_before;
  end if;

  -- THE REFERENCE IS THE EVIDENCE. A manual settlement has no provider event
  -- behind it, so the only thing linking this row to a real transfer is what
  -- the person typed — a MoMo transaction id, a bank reference, "cash, signed
  -- for". Without it the record says money moved and gives nobody a way to
  -- check, which is worse than no record.
  if v_ref is null then
    raise exception 'record the transfer reference you sent it with'
      using errcode = 'check_violation';
  end if;

  update public.payouts
     set status = 'PAID',
         provider = 'manual',
         provider_transfer_id = v_ref,
         paid_at = now()
   where id = p_payout_id
     and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'that payout is not awaiting settlement' using errcode = 'check_violation';
  end if;

  -- THE LIABILITY CLEARS, exactly as it does on a provider transfer. The
  -- allocations this payout was made of stop being owed.
  update public.allocations
     set status = 'SETTLED', settled_at = now()
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id = v_payout.payee_id;

  perform public.log_admin_action(
    'PAYOUT_SETTLED_MANUALLY', 'payout', p_payout_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_payout)
  );

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") IS 'A person recording that they sent a payout themselves. Separate from mark_payout_paid(), which is the provider''s road and is service-only: this is an administrative act with a typed reference as its only evidence, so it is refused without one and it appends to admin_actions.';


CREATE OR REPLACE FUNCTION "public"."admin_settlement_overview"() RETURNS TABLE("payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "payee_contact" "text", "order_count" bigint, "owed_pesewas" bigint, "oldest_at" timestamp with time zone, "cadence" "text", "eligible_from" timestamp with time zone, "is_due" boolean, "below_minimum" boolean, "last_paid_at" timestamp with time zone, "failed_payouts" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with cfg as (select * from public.pricing_config where id),
  owed as (
    select a.payee_type, a.payee_id,
           count(*) as order_count,
           sum(a.amount_pesewas)::bigint as owed_pesewas,
           min(o.created_at) as oldest_at
      from public.allocations a
      join public.orders o on o.id = a.order_id
     where a.payee_type in ('VENDOR', 'PARTNER')
       and a.status = 'ELIGIBLE'
       and a.settlement_run_id is null
     group by a.payee_type, a.payee_id
  )
  select w.payee_type,
         w.payee_id,
         case w.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = w.payee_id)
           else                (select u.full_name from public.users u where u.id = w.payee_id)
         end,
         case w.payee_type
           when 'VENDOR'  then (select coalesce(o.phone, v.phone) from public.vendors v
                                  left join public.users o on o.id = v.owner_user_id
                                 where v.id = w.payee_id)
           else                (select u.phone from public.users u where u.id = w.payee_id)
         end,
         w.order_count,
         w.owed_pesewas,
         w.oldest_at,
         -- The cadence, said out loud rather than implied by a helper in a
         -- different language.
         case w.payee_type when 'VENDOR' then 'DAILY' else 'WEEKLY' end,
         -- When this money first becomes settleable: the end of the day it was
         -- earned for a vendor, the end of that week for a Partner.
         case w.payee_type
           when 'VENDOR' then date_trunc('day', w.oldest_at) + interval '1 day'
           else               date_trunc('week', w.oldest_at) + interval '1 week'
         end,
         now() >= case w.payee_type
           when 'VENDOR' then date_trunc('day', w.oldest_at) + interval '1 day'
           else               date_trunc('week', w.oldest_at) + interval '1 week'
         end,
         -- Below the threshold a transfer costs more in fees than it moves, so
         -- a run would claim it and immediately hand it back. Saying so here
         -- stops an operator wondering why the button did nothing.
         w.owed_pesewas < greatest((select coalesce(min_payout_pesewas, 0) from cfg), 1),
         (select max(p.paid_at) from public.payouts p
           where p.payee_type = w.payee_type and p.payee_id = w.payee_id and p.status = 'PAID'),
         (select count(*) from public.payouts p
           where p.payee_type = w.payee_type and p.payee_id = w.payee_id and p.status = 'FAILED')
    from owed w
   where public.is_admin()
   order by w.payee_type, w.owed_pesewas desc;
$$;


ALTER FUNCTION "public"."admin_settlement_overview"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_settlement_payouts"("p_run_id" "uuid") RETURNS TABLE("payout_id" "uuid", "payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "amount_pesewas" bigint, "status" "public"."payout_status", "provider" "text", "provider_transfer_id" "text", "failure_reason" "text", "paid_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.id, p.payee_type, p.payee_id,
         case p.payee_type
           when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
           when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           else 'Campus Dash'
         end,
         p.amount_pesewas, p.status, p.provider, p.provider_transfer_id,
         p.failure_reason, p.paid_at
    from public.payouts p
   where public.is_admin() and p.settlement_run_id = p_run_id
   order by p.amount_pesewas desc;
$$;


ALTER FUNCTION "public"."admin_settlement_payouts"("p_run_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_settlement_runs"("p_limit" integer DEFAULT 50) RETURNS TABLE("run_id" "uuid", "payee_type" "public"."payee_type", "period_start" timestamp with time zone, "period_end" timestamp with time zone, "status" "public"."settlement_run_status", "total_pesewas" bigint, "deferred_pesewas" bigint, "deferred_payees" integer, "payout_count" bigint, "paid_count" bigint, "failed_count" bigint, "created_at" timestamp with time zone, "completed_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select r.id, r.payee_type, r.period_start, r.period_end, r.status, r.total_pesewas,
         r.deferred_pesewas, r.deferred_payee_count,
         (select count(*) from public.payouts p where p.settlement_run_id = r.id),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'PAID'),
         (select count(*) from public.payouts p where p.settlement_run_id = r.id and p.status = 'FAILED'),
         r.created_at, r.completed_at
    from public.settlement_runs r
   where public.is_admin()
   order by r.created_at desc
   limit least(coalesce(p_limit, 50), 200);
$$;


ALTER FUNCTION "public"."admin_settlement_runs"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_undelivered_notifications"("p_limit" integer DEFAULT 100) RETURNS TABLE("id" bigint, "event" "text", "audience" "text", "recipient" "text", "order_id" "uuid", "provider" "text", "provider_message_id" "text", "delivery_status" "text", "delivery_updated_at" timestamp with time zone, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select n.id, n.event, n.audience, n.recipient, n.order_id, n.provider,
         n.provider_message_id, n.delivery_status, n.delivery_updated_at, n.created_at
    from public.notification_events n
   where public.is_admin()
     and n.channel = 'SMS'
     and n.succeeded
     and n.delivery_status is not null
     and n.delivery_status <> 'DELIVERED'
   order by n.delivery_updated_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;


ALTER FUNCTION "public"."admin_undelivered_notifications"("p_limit" integer) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pricing_config" (
    "id" boolean DEFAULT true NOT NULL,
    "delivery_fee_pesewas" bigint NOT NULL,
    "partner_share_of_delivery_bps" integer DEFAULT 10000 NOT NULL,
    "vendor_response_seconds" integer DEFAULT 60 NOT NULL,
    "partner_search_seconds" integer DEFAULT 600 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "customer_absent_wait_seconds" integer DEFAULT 300 NOT NULL,
    "payment_pending_timeout_seconds" integer DEFAULT 900 NOT NULL,
    "min_payout_pesewas" bigint DEFAULT 0 NOT NULL,
    "approved_document_retention_days" integer DEFAULT 90 NOT NULL,
    "rejected_document_retention_days" integer DEFAULT 30 NOT NULL,
    "document_signed_url_seconds" integer DEFAULT 120 NOT NULL,
    "notification_retry_limit" integer DEFAULT 2 NOT NULL,
    "vendor_poll_seconds" integer DEFAULT 8 NOT NULL,
    "partner_poll_seconds" integer DEFAULT 10 NOT NULL,
    "customer_poll_seconds" integer DEFAULT 6 NOT NULL,
    "service_fee_bps" integer DEFAULT 695 NOT NULL,
    "scan_service_fee_pesewas" bigint DEFAULT 200,
    "max_active_deliveries_per_partner" smallint DEFAULT 2 NOT NULL,
    "code_attempt_limit" integer DEFAULT 5 NOT NULL,
    "code_lockout_seconds" integer DEFAULT 300 NOT NULL,
    "partner_min_payout_pesewas" bigint DEFAULT 2000 NOT NULL,
    "partner_delivery_enabled" boolean DEFAULT true NOT NULL,
    "scan_pack_fee_pesewas" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "pricing_config_approved_document_retention_days_check" CHECK (("approved_document_retention_days" > 0)),
    CONSTRAINT "pricing_config_code_attempt_limit_check" CHECK ((("code_attempt_limit" >= 3) AND ("code_attempt_limit" <= 20))),
    CONSTRAINT "pricing_config_code_lockout_seconds_check" CHECK ((("code_lockout_seconds" >= 30) AND ("code_lockout_seconds" <= 3600))),
    CONSTRAINT "pricing_config_customer_absent_wait_seconds_check" CHECK (("customer_absent_wait_seconds" > 0)),
    CONSTRAINT "pricing_config_customer_poll_seconds_check" CHECK ((("customer_poll_seconds" >= 2) AND ("customer_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_delivery_fee_pesewas_check" CHECK (("delivery_fee_pesewas" >= 0)),
    CONSTRAINT "pricing_config_document_signed_url_seconds_check" CHECK ((("document_signed_url_seconds" >= 30) AND ("document_signed_url_seconds" <= 900))),
    CONSTRAINT "pricing_config_max_active_deliveries_check" CHECK ((("max_active_deliveries_per_partner" >= 1) AND ("max_active_deliveries_per_partner" <= 10))),
    CONSTRAINT "pricing_config_min_payout_pesewas_check" CHECK (("min_payout_pesewas" >= 0)),
    CONSTRAINT "pricing_config_notification_retry_limit_check" CHECK ((("notification_retry_limit" >= 0) AND ("notification_retry_limit" <= 10))),
    CONSTRAINT "pricing_config_partner_min_payout_check" CHECK (("partner_min_payout_pesewas" >= 0)),
    CONSTRAINT "pricing_config_partner_poll_seconds_check" CHECK ((("partner_poll_seconds" >= 2) AND ("partner_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_partner_search_seconds_check" CHECK (("partner_search_seconds" > 0)),
    CONSTRAINT "pricing_config_partner_share_of_delivery_bps_check" CHECK ((("partner_share_of_delivery_bps" >= 0) AND ("partner_share_of_delivery_bps" <= 10000))),
    CONSTRAINT "pricing_config_payment_pending_timeout_seconds_check" CHECK (("payment_pending_timeout_seconds" > 0)),
    CONSTRAINT "pricing_config_rejected_document_retention_days_check" CHECK (("rejected_document_retention_days" > 0)),
    CONSTRAINT "pricing_config_scan_pack_fee_check" CHECK (("scan_pack_fee_pesewas" >= 0)),
    CONSTRAINT "pricing_config_scan_service_fee_check" CHECK ((("scan_service_fee_pesewas" IS NULL) OR ("scan_service_fee_pesewas" >= 0))),
    CONSTRAINT "pricing_config_service_fee_bps_check" CHECK ((("service_fee_bps" >= 0) AND ("service_fee_bps" <= 10000))),
    CONSTRAINT "pricing_config_singleton" CHECK ("id"),
    CONSTRAINT "pricing_config_vendor_poll_seconds_check" CHECK ((("vendor_poll_seconds" >= 2) AND ("vendor_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_vendor_response_seconds_check" CHECK (("vendor_response_seconds" > 0))
);


ALTER TABLE "public"."pricing_config" OWNER TO "postgres";


COMMENT ON TABLE "public"."pricing_config" IS 'Platform configuration. Legacy name — holds timeouts and operational limits as well as fees. One row, id = true.';


COMMENT ON COLUMN "public"."pricing_config"."service_fee_bps" IS 'Campus Dash service fee, in basis points of the food subtotal. 695 = 6.95%.';


COMMENT ON COLUMN "public"."pricing_config"."scan_service_fee_pesewas" IS 'Flat Campus Dash fee for one scan delivery, in pesewas. Currently 200 (GH₵2.00). NULL means not configured, and scan ordering is refused until an administrator sets it. NULL is not the same as 0: 0 would mean the errand is deliberately free.';


COMMENT ON COLUMN "public"."pricing_config"."max_active_deliveries_per_partner" IS 'How many deliveries one Partner may carry at once. Default 2. The ceiling of 10 is a guard against a typo emptying the offer board into one person''s hands, not a product opinion.';


COMMENT ON COLUMN "public"."pricing_config"."code_attempt_limit" IS 'Wrong handoff codes tolerated before a lockout. Five, because a counter is noisy and somebody mishearing a digit twice is normal.';


COMMENT ON COLUMN "public"."pricing_config"."code_lockout_seconds" IS 'How long a locked-out handoff stays locked. Long enough to make scripting a four-digit code hopeless, short enough that a genuine mistake is not a ruined delivery.';


COMMENT ON COLUMN "public"."pricing_config"."partner_min_payout_pesewas" IS 'What a Partner''s available earnings must reach before the weekly run pays them. GH₵20 (2000). A balance below it is NOT lost and NOT reset: the run releases its claim in the same transaction, so it is owed again immediately and carried into the next cycle.';


COMMENT ON COLUMN "public"."pricing_config"."partner_delivery_enabled" IS 'Whether Partner delivery may be CHOSEN. False hides it at the checkout and refuses it at submission; collection is unaffected. It reaches no order that already exists — an order paid for as a delivery stays a delivery.';


COMMENT ON COLUMN "public"."pricing_config"."scan_pack_fee_pesewas" IS 'What a meal-scan order is charged for disposable packaging, in pesewas. GH4 in the pilot. SCAN ORDERS ONLY — orders_pack_fee_scan_only enforces that — because a food order arrives in the store''s own packaging and is charged nothing for it. Compulsory on the orders it applies to: the customer is shown the line and cannot remove it.';


CREATE OR REPLACE FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer DEFAULT NULL::integer, "p_delivery_fee_pesewas" bigint DEFAULT NULL::bigint, "p_partner_share_of_delivery_bps" integer DEFAULT NULL::integer, "p_vendor_response_seconds" integer DEFAULT NULL::integer, "p_partner_search_seconds" integer DEFAULT NULL::integer, "p_customer_absent_wait_seconds" integer DEFAULT NULL::integer, "p_payment_pending_timeout_seconds" integer DEFAULT NULL::integer, "p_min_payout_pesewas" bigint DEFAULT NULL::bigint, "p_notification_retry_limit" integer DEFAULT NULL::integer, "p_vendor_poll_seconds" integer DEFAULT NULL::integer, "p_partner_poll_seconds" integer DEFAULT NULL::integer, "p_customer_poll_seconds" integer DEFAULT NULL::integer, "p_scan_service_fee_pesewas" bigint DEFAULT NULL::bigint, "p_max_active_deliveries_per_partner" smallint DEFAULT NULL::smallint, "p_partner_min_payout_pesewas" bigint DEFAULT NULL::bigint, "p_partner_delivery_enabled" boolean DEFAULT NULL::boolean, "p_scan_pack_fee_pesewas" bigint DEFAULT NULL::bigint) RETURNS "public"."pricing_config"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.pricing_config%rowtype;
  v_after  public.pricing_config%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  -- Checked HERE as well as by the column constraint, so an operator who types
  -- 40 reads a sentence about Partners rather than a constraint name.
  if p_max_active_deliveries_per_partner is not null
     and (p_max_active_deliveries_per_partner < 1 or p_max_active_deliveries_per_partner > 10) then
    raise exception 'a Partner may carry between 1 and 10 deliveries at once'
      using errcode = 'check_violation';
  end if;

  if p_partner_min_payout_pesewas is not null and p_partner_min_payout_pesewas < 0 then
    raise exception 'the Partner payout threshold cannot be negative'
      using errcode = 'check_violation';
  end if;

  if p_scan_pack_fee_pesewas is not null and p_scan_pack_fee_pesewas < 0 then
    raise exception 'the pack fee cannot be negative' using errcode = 'check_violation';
  end if;

  select * into v_before from public.pricing_config where id;

  -- NULL MEANS "LEAVE ALONE". An operator changing one fee must not silently
  -- reset a timeout they never looked at.
  update public.pricing_config
     set service_fee_bps                   = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas              = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps     = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds           = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds            = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds      = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds   = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas                = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit          = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds               = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds              = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds             = coalesce(p_customer_poll_seconds, customer_poll_seconds),
         scan_service_fee_pesewas          = coalesce(p_scan_service_fee_pesewas, scan_service_fee_pesewas),
         max_active_deliveries_per_partner = coalesce(p_max_active_deliveries_per_partner, max_active_deliveries_per_partner),
         partner_min_payout_pesewas        = coalesce(p_partner_min_payout_pesewas, partner_min_payout_pesewas),
         partner_delivery_enabled          = coalesce(p_partner_delivery_enabled, partner_delivery_enabled),
         scan_pack_fee_pesewas             = coalesce(p_scan_pack_fee_pesewas, scan_pack_fee_pesewas),
         updated_at = now()
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer, "p_scan_service_fee_pesewas" bigint, "p_max_active_deliveries_per_partner" smallint, "p_partner_min_payout_pesewas" bigint, "p_partner_delivery_enabled" boolean, "p_scan_pack_fee_pesewas" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text" DEFAULT NULL::"text", "p_is_deliverable" boolean DEFAULT NULL::boolean, "p_walk_minutes" integer DEFAULT NULL::integer, "p_sort_order" integer DEFAULT NULL::integer) RETURNS "public"."locations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.locations%rowtype;
  v_after  public.locations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.locations where id = p_location_id;
  if not found then
    raise exception 'location not found' using errcode = 'no_data_found';
  end if;

  -- parent_id is deliberately NOT editable here. Re-parenting a live tree would
  -- silently move the destination zone of orders already in flight; it needs
  -- its own operation with its own thinking.
  update public.locations
     set name           = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         is_deliverable = coalesce(p_is_deliverable, is_deliverable),
         walk_minutes   = coalesce(p_walk_minutes, walk_minutes),
         sort_order     = coalesce(p_sort_order, sort_order)
   where id = p_location_id
  returning * into v_after;

  perform public.log_admin_action(
    'LOCATION_UPDATE', 'location', p_location_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text" DEFAULT NULL::"text", "p_description" "text" DEFAULT NULL::"text", "p_price_pesewas" bigint DEFAULT NULL::bigint, "p_sort_order" integer DEFAULT NULL::integer) RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.menu_items%rowtype;
  v_after  public.menu_items%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  if p_price_pesewas is not null and p_price_pesewas <= 0 then
    raise exception 'price must be a positive whole number of pesewas'
      using errcode = 'check_violation';
  end if;

  update public.menu_items
     set name          = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         description   = coalesce(p_description, description),
         price_pesewas = coalesce(p_price_pesewas, price_pesewas),
         sort_order    = coalesce(p_sort_order, sort_order)
   where id = p_menu_item_id
  returning * into v_after;

  perform public.log_admin_action(
    case when v_after.price_pesewas is distinct from v_before.price_pesewas
         then 'MENU_ITEM_PRICE_CHANGE' else 'MENU_ITEM_UPDATE' end,
    'menu_item', p_menu_item_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_category_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT NULL::"text", "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes_to_campus" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendors%rowtype;
  v_after  public.vendors%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;
  if not found then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  -- NULL means "leave unchanged", so a partial edit form cannot blank a field
  -- it did not intend to touch.
  update public.vendors
     set name                   = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         phone                  = coalesce(p_phone, phone),
         category_id            = coalesce(p_category_id, category_id),
         description            = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
         location_id            = coalesce(p_location_id, location_id),
         location_note          = coalesce(p_location_note, location_note),
         walk_minutes_to_campus = coalesce(p_walk_minutes_to_campus, walk_minutes_to_campus)
   where id = p_vendor_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_UPDATE', 'vendor', p_vendor_id, p_reason, to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_category_id" "uuid", "p_description" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_update_vendor_category"("p_category_id" "uuid", "p_name" "text", "p_sort_order" integer, "p_is_active" boolean, "p_reason" "text") RETURNS "public"."vendor_categories"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendor_categories%rowtype;
  v_after  public.vendor_categories%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendor_categories where id = p_category_id;
  if not found then
    raise exception 'no such category' using errcode = 'no_data_found';
  end if;

  -- DISABLING IS NOT DELETING, and nothing about it touches a vendor row. A
  -- disabled category disappears from the sign-up form and the customer filter;
  -- the stalls already in it keep trading and every historical order keeps the
  -- category it was placed under.
  update public.vendor_categories
     set name       = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         sort_order = coalesce(p_sort_order, sort_order),
         is_active  = coalesce(p_is_active, is_active)
   where id = p_category_id
  returning * into v_after;

  perform public.log_admin_action(
    'VENDOR_CATEGORY_UPDATE', 'vendor_category', p_category_id, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );
  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_vendor_category"("p_category_id" "uuid", "p_name" "text", "p_sort_order" integer, "p_is_active" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_vendor_categories"() RETURNS TABLE("id" "uuid", "slug" "text", "name" "text", "sort_order" integer, "is_active" boolean, "vendor_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select k.id, k.slug, k.name, k.sort_order, k.is_active,
         (select count(*) from public.vendors v where v.category_id = k.id)
    from public.vendor_categories k
   where public.is_admin()
   order by k.sort_order, k.name;
$$;


ALTER FUNCTION "public"."admin_vendor_categories"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_vendors"("p_search" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT NULL::"text", "p_category_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("vendor_id" "uuid", "name" "text", "phone" "text", "status" "public"."vendor_status", "is_accepting_orders" boolean, "can_accept_scans" boolean, "location_path" "text", "category_id" "uuid", "category_name" "text", "description" "text", "applicant_name" "text", "owner_is_student" boolean, "owner_user_id" "uuid", "owner_name" "text", "owner_phone" "text", "rejection_reason" "text", "submitted_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "image_count" bigint, "menu_count" bigint, "order_count" bigint, "owed_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id, v.name, v.phone, v.status, v.is_accepting_orders, v.can_accept_scans,
         public.location_path(v.location_id),
         v.category_id, k.name, v.description,
         v.applicant_name, v.owner_is_student, v.owner_user_id,
         o.full_name, o.phone, v.rejection_reason,
         v.submitted_at, v.reviewed_at,
         (select count(*) from public.vendor_images i where i.vendor_id = v.id),
         (select count(*) from public.menu_items m where m.vendor_id = v.id),
         (select count(*) from public.orders ord where ord.vendor_id = v.id and ord.order_status <> 'DRAFT'),
         (select coalesce(sum(a.amount_pesewas),0)::bigint from public.allocations a
           where a.payee_type = 'VENDOR' and a.payee_id = v.id and a.status in ('PENDING','ELIGIBLE'))
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
    left join public.users o on o.id = v.owner_user_id
   where public.is_admin()
     and (p_status is null or btrim(p_status) = '' or v.status::text = p_status)
     and (p_category_id is null or v.category_id = p_category_id)
     and (p_search is null or btrim(p_search) = ''
          or v.name ilike '%' || btrim(p_search) || '%'
          or coalesce(v.phone,'') ilike '%' || btrim(p_search) || '%'
          or coalesce(v.applicant_name,'') ilike '%' || btrim(p_search) || '%')
   order by
     case v.status when 'PENDING_APPROVAL' then 0 when 'ACTIVE' then 1 else 2 end,
     v.name;
$$;


ALTER FUNCTION "public"."admin_vendors"("p_search" "text", "p_status" "text", "p_category_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_webhook_events"("p_limit" integer DEFAULT 100) RETURNS TABLE("webhook_id" "uuid", "provider" "text", "event_id" "text", "status" "public"."webhook_event_status", "signature_valid" boolean, "error" "text", "received_at" timestamp with time zone, "processed_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select w.id, w.provider, w.event_id, w.status, w.signature_valid, w.error,
         w.received_at, w.processed_at
    from public.webhook_events w
   where public.is_admin()
   order by w.received_at desc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_webhook_events"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assert_service_or_admin"() RETURNS "void"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_service_or_admin() then
    raise exception 'this operation is server-side only'
      using errcode = 'insufficient_privilege';
  end if;
end;
$$;


ALTER FUNCTION "public"."assert_service_or_admin"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "provider_transaction_id" "text",
    "amount_pesewas" bigint NOT NULL,
    "currency" "text" DEFAULT 'GHS'::"text" NOT NULL,
    "status" "public"."payment_txn_status" DEFAULT 'PENDING'::"public"."payment_txn_status" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "failure_reason" "text",
    "raw" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "succeeded_at" timestamp with time zone,
    "split_subaccount_code" "text",
    "split_vendor_pesewas" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "payments_amount_pesewas_check" CHECK (("amount_pesewas" > 0)),
    CONSTRAINT "payments_currency_check" CHECK (("currency" = 'GHS'::"text")),
    CONSTRAINT "payments_split_amount_check" CHECK ((("split_vendor_pesewas" >= 0) AND ("split_vendor_pesewas" <= "amount_pesewas"))),
    CONSTRAINT "payments_split_pair" CHECK ((("split_subaccount_code" IS NULL) = ("split_vendor_pesewas" = 0)))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


COMMENT ON COLUMN "public"."payments"."split_subaccount_code" IS 'The Paystack subaccount this charge was split to, or NULL when it was not split. Recorded at initialisation, so the ledger can say afterwards which orders settled themselves and which need a payout run.';


COMMENT ON COLUMN "public"."payments"."split_vendor_pesewas" IS 'How much of this charge Paystack routed straight to the vendor. Zero when there was no split — including when the split was attempted and refused, because what matters to the ledger is what actually happened.';


CREATE OR REPLACE FUNCTION "public"."attach_payment_split"("p_payment_id" "uuid", "p_subaccount_code" "text", "p_vendor_pesewas" bigint) RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  -- A split is decided before the customer is sent to the checkout and never
  -- afterwards. Rewriting it on a settled payment would rewrite history.
  if v_payment.status <> 'PENDING' then
    raise exception 'a split can only be recorded while the payment is pending'
      using errcode = 'check_violation';
  end if;

  update public.payments
     set split_subaccount_code = nullif(btrim(coalesce(p_subaccount_code, '')), ''),
         split_vendor_pesewas  = case
           when nullif(btrim(coalesce(p_subaccount_code, '')), '') is null then 0
           else coalesce(p_vendor_pesewas, 0) end
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;


ALTER FUNCTION "public"."attach_payment_split"("p_payment_id" "uuid", "p_subaccount_code" "text", "p_vendor_pesewas" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb" DEFAULT NULL::"jsonb") RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  if v_payment.provider_transaction_id is not null then
    if v_payment.provider_transaction_id <> p_provider_transaction_id then
      raise exception 'payment % is already attached to transaction %',
        p_payment_id, v_payment.provider_transaction_id using errcode = 'check_violation';
    end if;

    -- Same transaction, possibly a fresher checkout URL. Merge, never detach.
    update public.payments
       set raw = public.payments.raw || coalesce(p_raw, '{}'::jsonb)
     where id = p_payment_id
    returning * into v_payment;
    return v_payment;
  end if;

  update public.payments
     set provider_transaction_id = p_provider_transaction_id,
         raw = public.payments.raw || coalesce(p_raw, '{}'::jsonb)
   where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;


ALTER FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();

  if nullif(btrim(coalesce(p_recipient_code, '')), '') is null then
    raise exception 'a recipient code is required' using errcode = 'check_violation';
  end if;

  update public.payout_destinations
     set provider = p_provider,
         provider_recipient_code = p_recipient_code,
         provider_synced_at = now()
   where payee_type = p_payee_type and payee_id = p_payee_id
  returning * into v_row;

  if not found then
    raise exception 'no payout destination for % %', p_payee_type, p_payee_id
      using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;


ALTER FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attach_payout_subaccount"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_subaccount_code" "text", "p_error" "text" DEFAULT NULL::"text") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();

  update public.payout_destinations
     set provider = coalesce(p_provider, provider),
         provider_subaccount_code = coalesce(nullif(btrim(coalesce(p_subaccount_code, '')), ''),
                                             provider_subaccount_code),
         subaccount_synced_at = case when nullif(btrim(coalesce(p_subaccount_code, '')), '') is not null
                                     then now() else subaccount_synced_at end,
         subaccount_error = nullif(btrim(coalesce(p_error, '')), '')
   where payee_type = p_payee_type and payee_id = p_payee_id
  returning * into v_row;

  if not found then
    raise exception 'no payout destination for that payee' using errcode = 'no_data_found';
  end if;

  return v_row;
end;
$$;


ALTER FUNCTION "public"."attach_payout_subaccount"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_subaccount_code" "text", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_allocations_balance"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order_id uuid := coalesce(new.order_id, old.order_id);
  v_total    bigint;
  v_sum      bigint;
begin
  select total_pesewas into v_total from public.orders where id = v_order_id;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where order_id = v_order_id and status <> 'CANCELLED';

  -- Zero allocations is legal: the order simply has not been paid yet.
  if v_sum <> 0 and v_sum <> v_total then
    raise exception
      'allocations for order % sum to % but order total is %', v_order_id, v_sum, v_total
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."check_allocations_balance"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_handoff_code"("p_order_id" "uuid", "p_kind" "text", "p_supplied" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_stored  text;
  v_tries   integer;
  v_locked  timestamptz;
  v_limit   integer;
  v_seconds integer;
begin
  select code_attempt_limit, code_lockout_seconds into v_limit, v_seconds
    from public.pricing_config where id;
  v_limit   := coalesce(v_limit, 5);
  v_seconds := coalesce(v_seconds, 300);

  if p_kind = 'PICKUP' then
    select s.pickup_code, s.pickup_attempts, s.pickup_locked_until
      into v_stored, v_tries, v_locked
      from public.order_secrets s where s.order_id = p_order_id
      for update;
  else
    select s.delivery_code, s.delivery_attempts, s.delivery_locked_until
      into v_stored, v_tries, v_locked
      from public.order_secrets s where s.order_id = p_order_id
      for update;
  end if;

  if not found then
    return 'MISMATCH';
  end if;

  -- Locked out. Checked BEFORE the comparison, so a lockout is not a free
  -- oracle that tells an attacker when they have finally guessed right.
  if v_locked is not null and v_locked > now() then
    return 'LOCKED';
  end if;

  -- The lockout has expired: the slate is clean, and the next wrong answer
  -- starts counting again from one.
  if v_locked is not null then
    v_tries := 0;
    if p_kind = 'PICKUP' then
      update public.order_secrets
         set pickup_attempts = 0, pickup_locked_until = null
       where order_id = p_order_id;
    else
      update public.order_secrets
         set delivery_attempts = 0, delivery_locked_until = null
       where order_id = p_order_id;
    end if;
  end if;

  -- A rotated (NULL) code never matches, so a code from a cancelled assignment
  -- is worthless the moment the Partner walks away.
  if v_stored is not null and p_supplied is not null
     and v_stored = btrim(p_supplied) then
    if p_kind = 'PICKUP' then
      update public.order_secrets
         set pickup_attempts = 0, pickup_locked_until = null
       where order_id = p_order_id;
    else
      update public.order_secrets
         set delivery_attempts = 0, delivery_locked_until = null
       where order_id = p_order_id;
    end if;
    return 'OK';
  end if;

  v_tries := v_tries + 1;

  if p_kind = 'PICKUP' then
    update public.order_secrets
       set pickup_attempts = v_tries,
           pickup_locked_until = case when v_tries >= v_limit
                                      then now() + make_interval(secs => v_seconds) end
     where order_id = p_order_id;
  else
    update public.order_secrets
       set delivery_attempts = v_tries,
           delivery_locked_until = case when v_tries >= v_limit
                                        then now() + make_interval(secs => v_seconds) end
     where order_id = p_order_id;
  end if;

  return case when v_tries >= v_limit then 'LOCKED' else 'MISMATCH' end;
end;
$$;


ALTER FUNCTION "public"."check_handoff_code"("p_order_id" "uuid", "p_kind" "text", "p_supplied" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."check_handoff_code"("p_order_id" "uuid", "p_kind" "text", "p_supplied" "text") IS 'Compares a supplied handoff code and counts the failure. SERVER-ONLY: no client role may call it, because a client that could would have an oracle for the code it is meant to be told out loud.';


CREATE TABLE IF NOT EXISTS "public"."customer_profiles" (
    "user_id" "uuid" NOT NULL,
    "student_id_number" "text",
    "level" "text",
    "onboarded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "affiliation" "public"."campus_affiliation" DEFAULT 'STUDENT'::"public"."campus_affiliation" NOT NULL,
    "graduation_year" integer,
    "gender" "public"."customer_gender",
    CONSTRAINT "customer_graduation_year_shape" CHECK (((("affiliation" = 'STAFF'::"public"."campus_affiliation") AND ("graduation_year" IS NULL)) OR (("affiliation" = 'STUDENT'::"public"."campus_affiliation") AND (("graduation_year" >= 2000) AND ("graduation_year" <= 2100))))),
    CONSTRAINT "customer_student_id_shape" CHECK ((("student_id_number" IS NULL) OR ("btrim"("student_id_number") <> ''::"text")))
);


ALTER TABLE "public"."customer_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."customer_profiles" IS 'The CUSTOMER capability. A row here is the capability; there is no flag. Admin and vendor-staff accounts do not get one automatically.';


COMMENT ON COLUMN "public"."customer_profiles"."student_id_number" IS 'HISTORICAL. Campus Dash no longer asks for this: the verified @acity.edu.gh address establishes who a student is, and the Partner application is judged on the card itself. Retained so an account created before the change keeps what it declared and a past review stays auditable. Unique when present.';


COMMENT ON COLUMN "public"."customer_profiles"."level" IS 'HISTORICAL. The 100/200/300/400 year-group this account signed up with, before the column was replaced by graduation_year. Never written any more; kept so an old row still says what it said.';


COMMENT ON COLUMN "public"."customer_profiles"."affiliation" IS 'Student or staff. Staff hold exactly the same CUSTOMER capability and may become Partners — this changes what is ASKED at sign-up, never what is allowed afterwards.';


COMMENT ON COLUMN "public"."customer_profiles"."graduation_year" IS 'The year a student expects to finish. Replaces `level`, which was wrong for three of the four years it described: somebody who signs up as level 100 stays level 100 for ever unless a person remembers to change it. Null for staff, who do not graduate.';


COMMENT ON COLUMN "public"."customer_profiles"."gender" IS 'Optional, and exactly MALE or FEMALE as specified. Nobody is blocked from ordering for declining to say.';


CREATE OR REPLACE FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation" DEFAULT 'STUDENT'::"public"."campus_affiliation", "p_graduation_year" integer DEFAULT NULL::integer, "p_gender" "public"."customer_gender" DEFAULT NULL::"public"."customer_gender", "p_terms_id" "uuid" DEFAULT NULL::"uuid", "p_student_id_number" "text" DEFAULT NULL::"text") RETURNS "public"."customer_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_user    uuid := auth.uid();
  v_email   text;
  v_phone   text := nullif(btrim(coalesce(p_phone, '')), '');
  v_student text := nullif(btrim(coalesce(p_student_id_number, '')), '');
  v_profile public.customer_profiles%rowtype;
  v_doc     public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- THE VERIFIED ADDRESS, read from auth. Not a parameter.
  select lower(btrim(coalesce(u.email, ''))) into v_email
    from auth.users u
   where u.id = v_user and u.email_confirmed_at is not null;

  if coalesce(v_email, '') = '' then
    raise exception 'verify your Academic City email address before completing sign-up'
      using errcode = 'insufficient_privilege';
  end if;

  -- EXACTLY the school domain. A lookalike (@acity.edu.gh.example.com) must not
  -- pass, so this anchors the end of the string rather than searching for it.
  if v_email !~ '@acity\.edu\.gh$' then
    raise exception 'Campus Dash accounts use an @acity.edu.gh address'
      using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_last_name, '')), '') is null then
    raise exception 'your last name is required' using errcode = 'check_violation';
  end if;

  -- A student says which of the four cohorts they are in; staff do not
  -- graduate and are not asked. The offered list and this check are the same
  -- list, so a year the form cannot offer is a year this refuses.
  if p_affiliation = 'STUDENT' then
    if p_graduation_year is null then
      raise exception 'tell us the year you expect to graduate'
        using errcode = 'check_violation';
    end if;
    if p_graduation_year not in (2027, 2028, 2029, 2030) then
      raise exception 'choose one of the graduation years offered'
        using errcode = 'check_violation';
    end if;
  end if;

  -- MALE OR FEMALE, and one of them is answered. See the note at the top.
  if p_gender is null then
    raise exception 'tell us whether you are male or female'
      using errcode = 'check_violation';
  end if;

  -- The phone is how a Partner reaches somebody standing outside their door
  -- with cooling food. It is required for that reason, not as a credential.
  if v_phone is null then
    raise exception 'a phone number is required so a Partner can reach you'
      using errcode = 'check_violation';
  end if;
  if v_phone !~ '^\+[1-9]\d{7,14}$' then
    raise exception 'enter a valid phone number, e.g. 020 123 4567'
      using errcode = 'check_violation';
  end if;

  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null or v_doc.audience <> 'CUSTOMER' then
    raise exception 'the customer terms must be accepted to continue'
      using errcode = 'check_violation';
  end if;
  if v_doc.version <> (
    select max(t.version) from public.terms_documents t
     where t.audience = 'CUSTOMER' and t.published_at is not null
  ) then
    raise exception 'those terms have been superseded; reload and try again'
      using errcode = 'check_violation';
  end if;

  begin
    update public.users
       set first_name = btrim(p_first_name),
           last_name  = btrim(p_last_name),
           email      = v_email,
           phone      = v_phone
     where id = v_user;

    if not found then
      raise exception 'no profile for this account' using errcode = 'no_data_found';
    end if;
  exception when unique_violation then
    -- TWO DIFFERENT CONSTRAINTS, TWO DIFFERENT MISTAKES, and the distinction is
    -- kept HERE, in the log, where it is the thing that makes a support call
    -- answerable. What the person is shown is decided in lib/errors.js, and it
    -- deliberately no longer says which detail collided or that another account
    -- holds it — that would answer "is this number registered?" for anybody who
    -- typed one. The uniqueness rule itself is untouched.
    if sqlerrm like '%users_phone%' then
      raise exception 'that phone number is already used by another Campus Dash account'
        using errcode = 'unique_violation';
    end if;
    raise exception 'that email address is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end;

  begin
    insert into public.customer_profiles (
      user_id, affiliation, graduation_year, gender, student_id_number
    )
    values (
      v_user, p_affiliation,
      case when p_affiliation = 'STUDENT' then p_graduation_year end,
      p_gender, v_student
    )
    -- Re-running sign-up updates the declared facts. It never revokes the
    -- capability, and it never moves onboarded_at: when somebody became a
    -- customer is a historical fact, not a field.
    on conflict (user_id) do update
       set affiliation     = excluded.affiliation,
           graduation_year = excluded.graduation_year,
           gender          = coalesce(excluded.gender, public.customer_profiles.gender),
           student_id_number = coalesce(excluded.student_id_number,
                                        public.customer_profiles.student_id_number)
    returning * into v_profile;
  exception when unique_violation then
    raise exception 'that student ID number is already registered to another account'
      using errcode = 'unique_violation';
  end;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (v_user, v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version)
    do update set accepted_at = public.terms_acceptances.accepted_at;

  return v_profile;
end;
$_$;


ALTER FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_terms_id" "uuid", "p_student_id_number" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_terms_id" "uuid", "p_student_id_number" "text") IS 'The one gate on the CUSTOMER capability. Reads the verified address from auth.users, anchors the school domain, accepts one of the four offered graduation years for a student, requires male or female, and records the terms acceptance in the same transaction.';


CREATE OR REPLACE FUNCTION "public"."confirm_payment"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_amount_pesewas" bigint) RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payment public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_search  integer;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where id = p_payment_id;
  if not found then
    raise exception 'payment not found' using errcode = 'no_data_found';
  end if;

  -- Replayed confirmation: already succeeded, nothing more to do.
  if v_payment.status = 'SUCCEEDED' then
    return v_payment;
  end if;

  -- The provider must have collected exactly what we asked for. A mismatch is a
  -- reconciliation incident, not something to paper over.
  if p_amount_pesewas is distinct from v_payment.amount_pesewas then
    raise exception 'amount mismatch: provider reported % but payment is %',
      p_amount_pesewas, v_payment.amount_pesewas using errcode = 'check_violation';
  end if;

  update public.payments
     set status = 'SUCCEEDED',
         provider_transaction_id = coalesce(p_provider_transaction_id, provider_transaction_id),
         succeeded_at = now()
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  update public.orders
     set payment_status = 'PAID'
   where id = v_payment.order_id and payment_status = 'PENDING'
  returning * into v_order;

  if not found then
    raise exception 'order payment status was not PENDING' using errcode = 'check_violation';
  end if;

  perform public.create_order_allocations(v_payment.order_id);

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_CONFIRMED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'PAID', null,
    jsonb_build_object('payment_id', p_payment_id, 'provider_transaction_id', p_provider_transaction_id));

  select partner_search_seconds into v_search from public.pricing_config where id;

  -- ONE PATH FOR BOTH ORDER TYPES. A paid order reaches the store the moment
  -- it is paid for — there is no accept and no separate "start preparing". For
  -- a scan the store's work is verifying the scan and packing it rather than
  -- cooking, but it is work on a board either way.
  --
  -- DISPATCH OPENS HERE for a Partner order. A Partner found while the order is
  -- being put together is a Partner who is not standing at a counter waiting,
  -- and the offer carries food_is_ready so nobody sets off too early.
  --
  -- Guarded on the current state, so a replayed confirmation cannot restart a
  -- search that has already found somebody.
  update public.orders o
     set order_status   = 'PREPARING',
         preparing_at   = now(),
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case when o.fulfilment_type = 'DELIVERY' then now() end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY'
           then now() + make_interval(secs => v_search) end
   where o.id = v_payment.order_id
     and o.order_status = 'ACCEPTED'
  returning * into v_order;

  if found then
    perform public.log_order_event(v_payment.order_id, 'VENDOR_PREPARING', true, 'SYSTEM',
      'order_status', 'ACCEPTED', 'PREPARING', 'payment confirmed');

    if v_order.fulfilment_type = 'DELIVERY' then
      perform public.log_order_event(v_payment.order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
        'delivery_status', 'NONE', 'SEARCHING');
    end if;
  end if;

  return v_payment;
end;
$$;


ALTER FUNCTION "public"."confirm_payment"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_amount_pesewas" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order    public.orders%rowtype;
  v_vendor   bigint;
  v_platform bigint;
  v_count    integer := 0;
  v_split    bigint := 0;
  v_code     text;
  v_by_split boolean;
begin
  perform public.assert_service_or_admin();

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  -- Already allocated: idempotent no-op, not a duplicate ledger entry.
  if exists (select 1 from public.allocations where order_id = p_order_id) then
    return 0;
  end if;

  -- WHAT THE PROVIDER ACTUALLY SPLIT, read from the payment that succeeded —
  -- not from what we intended, and not from the vendor's current setup.
  select p.split_vendor_pesewas, p.split_subaccount_code
    into v_split, v_code
    from public.payments p
   where p.order_id = p_order_id and p.status = 'SUCCEEDED'
   order by p.created_at desc
   limit 1;

  v_split := coalesce(v_split, 0);

  -- THE STORE'S SHARE: the food it sold, plus the pack it packed. Zero pack on
  -- a food order (orders_pack_fee_scan_only) and zero food on a scan order
  -- (orders_scan_has_no_food_value), so each order type reads its own half.
  v_vendor   := v_order.subtotal_pesewas + coalesce(v_order.pack_fee_pesewas, 0);
  v_platform := v_order.total_pesewas - v_vendor;

  -- A PARTIAL split would leave a remainder nobody was ever going to send, so
  -- only a split covering the whole share settles the row.
  v_by_split := v_code is not null and v_split >= v_vendor;

  -- A food order always has a vendor row. A scan order has one only when the
  -- store is owed something through Campus Dash — the pack. A scan collection
  -- without a pack still writes NO vendor row: a zero-pesewa liability tells a
  -- reader the store is owed something, and it is not.
  if v_order.order_type <> 'SCAN' or v_vendor > 0 then
    insert into public.allocations (
      order_id, payee_type, payee_id, amount_pesewas, status,
      settlement_channel, settled_at
    )
    values (
      p_order_id, 'VENDOR', v_order.vendor_id, v_vendor,
      (case when v_by_split then 'SETTLED' else 'ELIGIBLE' end)::public.allocation_status,
      case when v_by_split then 'SPLIT' else 'TRANSFER' end,
      case when v_by_split then now() end
    );
    v_count := v_count + 1;
  end if;

  -- The service fee, plus the Partner fee until a Partner earns it (see
  -- settle_partner_earnings, which carves it out of this row).
  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status, settlement_channel)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE', 'TRANSFER');
  v_count := v_count + 1;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") IS 'Writes the ledger for a paid order. VENDOR = subtotal + pack (the food on a food order, the pack on a scan order; no row on a scan order with neither). PLATFORM = the rest, from which settle_partner_earnings later carves the Partner''s fee. Idempotent. A VENDOR row paid by a Paystack split that covered the whole share is born SETTLED.';


CREATE OR REPLACE FUNCTION "public"."create_payment_intent"("p_order_id" "uuid", "p_provider" "text", "p_idempotency_key" "text") RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order   public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payment from public.payments where idempotency_key = p_idempotency_key;
  if found then
    if v_payment.order_id <> p_order_id then
      raise exception 'idempotency key reused with a different order'
        using errcode = 'check_violation';
    end if;
    return v_payment;
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  if v_order.order_status <> 'ACCEPTED' then
    raise exception 'order must be ACCEPTED before payment (is %)', v_order.order_status
      using errcode = 'check_violation';
  end if;
  if v_order.fulfilment_type is null then
    raise exception 'choose pickup or delivery before paying' using errcode = 'check_violation';
  end if;
  if v_order.payment_status not in ('UNPAID', 'FAILED') then
    raise exception 'order payment is already % ', v_order.payment_status
      using errcode = 'check_violation';
  end if;

  insert into public.payments (order_id, provider, amount_pesewas, idempotency_key, status)
  values (p_order_id, p_provider, v_order.total_pesewas, p_idempotency_key, 'PENDING')
  returning * into v_payment;

  update public.orders set payment_status = 'PENDING' where id = p_order_id;

  perform public.log_order_event(p_order_id, 'PAYMENT_INTENT_CREATED', true, 'SYSTEM',
    'payment_status', 'UNPAID', 'PENDING', null,
    jsonb_build_object('payment_id', v_payment.id, 'amount_pesewas', v_payment.amount_pesewas));

  return v_payment;
end;
$$;


ALTER FUNCTION "public"."create_payment_intent"("p_order_id" "uuid", "p_provider" "text", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."settlement_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "payee_type" "public"."payee_type" NOT NULL,
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "status" "public"."settlement_run_status" DEFAULT 'OPEN'::"public"."settlement_run_status" NOT NULL,
    "total_pesewas" bigint DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "deferred_payee_count" integer DEFAULT 0 NOT NULL,
    "deferred_pesewas" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "settlement_runs_deferred_payee_count_check" CHECK (("deferred_payee_count" >= 0)),
    CONSTRAINT "settlement_runs_deferred_pesewas_check" CHECK (("deferred_pesewas" >= 0)),
    CONSTRAINT "settlement_runs_period_ordered" CHECK (("period_end" > "period_start")),
    CONSTRAINT "settlement_runs_total_pesewas_check" CHECK (("total_pesewas" >= 0))
);


ALTER TABLE "public"."settlement_runs" OWNER TO "postgres";


COMMENT ON COLUMN "public"."settlement_runs"."deferred_pesewas" IS 'Owed to payees under min_payout_pesewas at run time. NOT claimed by this run — released back to the pool for a later one.';


CREATE OR REPLACE FUNCTION "public"."create_settlement_run"("p_payee_type" "public"."payee_type", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone) RETURNS "public"."settlement_runs"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_run      public.settlement_runs%rowtype;
  v_total    bigint;
  v_minimum  bigint;
  v_deferred record;
begin
  perform public.assert_service_or_admin();

  -- PLATFORM is Campus Dash's own revenue, and its allocations carry no
  -- payee_id, so a PLATFORM run could never produce a payout — it would only
  -- move the platform's own ledger rows to SETTLING and strand them there. It
  -- is refused rather than silently doing that.
  if p_payee_type = 'PLATFORM' then
    raise exception 'PLATFORM revenue is not settled by a payout run'
      using errcode = 'check_violation';
  end if;

  -- Re-running a period returns the existing run rather than creating a second
  -- one that would pay everybody twice.
  select * into v_run from public.settlement_runs
   where payee_type = p_payee_type
     and period_start = p_period_start and period_end = p_period_end;
  if found then
    return v_run;
  end if;

  -- Partners have their own weekly floor; everybody else uses the general one.
  v_minimum := public.payout_threshold_for(p_payee_type);

  -- A payout is only ever created for a positive amount, so the effective floor
  -- is at least one pesewa. Without this a payee summing to exactly zero would
  -- be claimed and then left behind by the `having sum > 0` filter below —
  -- the same stranding, at a different amount.
  v_minimum := greatest(coalesce(v_minimum, 0), 1);

  insert into public.settlement_runs (payee_type, period_start, period_end, status, created_by)
  values (p_payee_type, p_period_start, p_period_end, 'PROCESSING', auth.uid())
  returning * into v_run;

  -- Claim everything eligible up to the end of the period. No lower bound:
  -- anything older than this period is either already claimed by the run that
  -- took it, or was deliberately released back — deferred, failed or reversed —
  -- and is exactly what should be swept up now. THAT RELEASE IS THE ROLLOVER.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at < p_period_end;

  -- Below the threshold the money stays owed. The claim is released in the same
  -- transaction that took it, so nothing is ever attached to a payout that will
  -- not be sent, and it shows up as owed again the moment this function
  -- returns. It is not lost, not reset, and not paid.
  select count(*)::integer as payees, coalesce(sum(owed), 0)::bigint as pesewas
    into v_deferred
    from (
      select a.payee_id, sum(a.amount_pesewas) as owed
        from public.allocations a
       where a.settlement_run_id = v_run.id and a.payee_id is not null
       group by a.payee_id
      having sum(a.amount_pesewas) < v_minimum
    ) under_threshold;

  update public.allocations a
     set settlement_run_id = null, status = 'ELIGIBLE', settled_at = null
   where a.settlement_run_id = v_run.id
     and a.payee_id in (
       select a2.payee_id
         from public.allocations a2
        where a2.settlement_run_id = v_run.id and a2.payee_id is not null
        group by a2.payee_id
       having sum(a2.amount_pesewas) < v_minimum
     );

  -- One payout per payee, summing what is left claimed. The unique index on
  -- (settlement_run_id, payee_type, payee_id) makes a duplicate impossible.
  insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
  select v_run.id, a.payee_type, a.payee_id, sum(a.amount_pesewas),
         'payout:' || v_run.id || ':' || a.payee_type::text || ':' || a.payee_id
    from public.allocations a
   where a.settlement_run_id = v_run.id and a.payee_id is not null
   group by a.payee_type, a.payee_id
  having sum(a.amount_pesewas) >= v_minimum;

  select coalesce(sum(amount_pesewas), 0) into v_total
    from public.payouts where settlement_run_id = v_run.id;

  update public.settlement_runs
     set total_pesewas = v_total,
         deferred_payee_count = v_deferred.payees,
         deferred_pesewas = v_deferred.pesewas
   where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$$;


ALTER FUNCTION "public"."create_settlement_run"("p_payee_type" "public"."payee_type", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") RETURNS TABLE("terms_id" "uuid", "audience" "public"."terms_audience", "version" integer, "title" "text", "body" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select t.id, t.audience, t.version, t.title, t.body
    from public.terms_documents t
   where t.audience = p_audience and t.published_at is not null
   order by t.version desc
   limit 1;
$$;


ALTER FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select auth.uid();
$$;


ALTER FUNCTION "public"."current_user_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_abandon_stuck_payment"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_payment public.payments%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  -- Ownership is proved here, which is what earns the right to skip the
  -- server-context assertion below.
  select p.* into v_payment
    from public.payments p
    join public.orders o on o.id = p.order_id
   where p.order_id = p_order_id
     and o.customer_id = auth.uid()
     and p.status = 'PENDING';

  if not found then
    return row(false, 'there is no payment waiting on this order')::public.transition_result;
  end if;

  if v_payment.created_at > now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds) then
    return row(
      false,
      'we are still waiting to hear from the payment provider — please give it a moment'
    )::public.transition_result;
  end if;

  perform public.mark_payment_failed_internal(v_payment.id, 'customer abandoned a stuck payment');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_abandon_stuck_payment"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.customer_id <> auth.uid() then
    raise exception 'not your order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders
     set order_status        = 'CANCELLED',
         cancelled_at        = now(),
         cancellation_reason = 'the customer abandoned the unpaid order'
   where id = p_order_id
     and customer_id = auth.uid()
     and order_status = 'ACCEPTED'
     and payment_status in ('UNPAID', 'FAILED');

  if not found then
    perform public.log_order_event(p_order_id, 'ORDER_ABANDONED', false, 'CUSTOMER',
      'order_status', v_order.order_status::text, 'CANCELLED',
      'only an order that has not been paid for can be abandoned');
    return row(
      false,
      case
        when v_order.payment_status = 'PENDING'
          then 'a payment on this order is still being confirmed'
        when v_order.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
          then 'this order has been paid for, so it cannot be abandoned'
        else 'this order can no longer be abandoned'
      end
    )::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'ORDER_ABANDONED', true, 'CUSTOMER',
    'order_status', 'ACCEPTED', 'CANCELLED', 'the customer abandoned the unpaid order');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") IS 'The customer abandons their own order before paying for it: ACCEPTED with payment UNPAID or FAILED becomes CANCELLED. Guarded on the payment state, so a paid order or one with a payment in flight is refused and logged, never overwritten. The same end state expire_stale_orders() reaches on its own.';


CREATE OR REPLACE FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order    public.orders%rowtype;
  v_cfg      public.pricing_config%rowtype;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders where id = p_order_id;

  if not found or v_order.customer_id <> auth.uid() then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      return row(false, 'Partner delivery is unavailable right now. Choose collection.')::public.transition_result;
    end if;
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  update public.orders o
     set fulfilment_type          = p_fulfilment_type,
         destination_location_id  = case when p_fulfilment_type = 'DELIVERY'
                                         then p_destination_location_id end,
         destination_note         = case when p_fulfilment_type = 'DELIVERY'
                                         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
         destination_zone_id      = v_zone,
         delivery_fee_pesewas     = v_delivery,
         partner_earnings_pesewas = v_earnings,
         total_pesewas            = o.subtotal_pesewas + o.service_fee_pesewas + v_delivery
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status = 'ACCEPTED'
     and o.payment_status in ('UNPAID', 'FAILED')
     and o.order_type = 'FOOD'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', false, 'CUSTOMER',
      null, null, p_fulfilment_type::text,
      'order was not an unpaid food order');
    return row(false, 'this order is past the point of changing')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'FULFILMENT_CHOSEN', true, 'CUSTOMER',
    null, null, p_fulfilment_type::text, null,
    jsonb_build_object(
      'delivery_fee_pesewas', v_delivery,
      'total_pesewas', v_order.total_pesewas));

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  update public.orders
     set delivery_status = 'NONE'
   where id = p_order_id
     and customer_id = auth.uid()
     and fulfilment_type = 'DELIVERY'
     and delivery_status in ('SEARCHING', 'FAILED_NO_PARTNER')
     and order_status = 'READY'
  returning * into v_order;

  if not found then
    return row(false, 'this order cannot be collected right now')::public.transition_result;
  end if;

  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now()
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'CUSTOMER_WILL_COLLECT', true, 'CUSTOMER',
    'delivery_status', 'SEARCHING', 'NONE',
    'customer chose to collect; delivery fee refund is an admin decision');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_complete_pickup"("p_order_id" "uuid", "p_pickup_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order  public.orders%rowtype;
  v_owner  uuid;
  v_state  public.order_status;
  v_check  text;
begin
  select o.customer_id, o.order_status into v_owner, v_state
    from public.orders o where o.id = p_order_id;

  -- AUTHORISATION failure: raise. A missing order and somebody else's order
  -- get the same message, so probing tells the caller nothing. It comes first,
  -- so a stranger can never burn an attempt on a code that is not theirs.
  if v_owner is null or v_owner is distinct from auth.uid() then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  -- STATE before CODE, so a second tap after a successful collection does not
  -- spend an attempt on a code that has already done its job.
  if v_state is distinct from 'READY' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', v_state::text, 'COMPLETED', 'order was not ready for collection');
    return row(false, 'this order is not ready for collection')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', 'READY', 'COMPLETED', 'collection code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask the vendor to read it out again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', 'READY', 'COMPLETED', 'collection code did not match');
    return row(false, 'that code does not match. Check it with the vendor')::public.transition_result;
  end if;

  update public.orders o
     set order_status = 'COMPLETED',
         completed_at = now(),
         vendor_completed_at = coalesce(o.vendor_completed_at, now())
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status = 'READY'
     -- NOBODY IS BRINGING IT. That covers a collection chosen at the checkout
     -- and a delivery nobody took that the customer decided to fetch — see
     -- customer_collect_instead(), which returns delivery_status to NONE.
     and o.delivery_status = 'NONE'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'CUSTOMER',
      'order_status', null, 'COMPLETED', 'order was not a READY, PAID collection');
    return row(false, 'this order is not ready for collection')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', true, 'CUSTOMER',
    'order_status', 'READY', 'COMPLETED');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_complete_pickup"("p_order_id" "uuid", "p_pickup_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_dispute_delivery"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and customer_id = auth.uid();
  if not found then
    raise exception 'order not found' using errcode = 'no_data_found';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    return row(false, 'please tell us what went wrong')::public.transition_result;
  end if;
  if v_order.disputed_at is not null and v_order.dispute_resolved_at is null then
    return row(true, 'already reported')::public.transition_result;
  end if;
  if v_order.payment_status <> 'PAID' then
    return row(false, 'there is nothing to dispute on an unpaid order')::public.transition_result;
  end if;

  update public.orders
     set disputed_at = now(), dispute_reason = btrim(p_reason), dispute_resolved_at = null
   where id = p_order_id;

  perform public.log_order_event(p_order_id, 'DISPUTE_RAISED', true, 'CUSTOMER',
    null, null, null, btrim(p_reason));

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_dispute_delivery"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_keep_waiting"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg   public.pricing_config%rowtype;
  v_order public.orders%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  update public.orders
     set delivery_status = 'SEARCHING',
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds)
   where id = p_order_id
     and customer_id = auth.uid()
     and delivery_status = 'FAILED_NO_PARTNER'
  returning * into v_order;

  if not found then
    return row(false, 'this order is not waiting for a Partner')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'DISPATCH_REOPENED', true, 'CUSTOMER',
    'delivery_status', 'FAILED_NO_PARTNER', 'SEARCHING', 'customer chose to keep waiting');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_keep_waiting"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_name" "text", "vendor_location" "text", "stage" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "order_type" "public"."order_type", "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "pack_fee_pesewas" bigint, "total_pesewas" bigint, "destination" "text", "destination_note" "text", "submitted_at" timestamp with time zone, "seconds_to_deadline" integer, "seconds_until_partner_search_expires" integer, "server_now" timestamp with time zone, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "assigned_at" timestamp with time zone, "picked_up_at" timestamp with time zone, "completed_at" timestamp with time zone, "cancellation_reason" "text", "payment_id" "uuid", "payment_txn_status" "public"."payment_txn_status", "partner_name" "text", "partner_phone" "text", "delivery_code" "text", "disputed" boolean, "dispute_reason" "text", "can_rate_partner" boolean, "rated_stars" smallint, "items" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, o.vendor_order_no, v.name, public.location_path(v.location_id),
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type, o.order_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas,
         coalesce(o.pack_fee_pesewas, 0), o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- THE PARTNER SEARCH COUNTDOWN, as a number of seconds from a clock
         -- the customer's device does not own. Paired with server_now below so
         -- a screen can anchor a local countdown against the server's idea of
         -- the time rather than its own — a phone with a wrong clock, a tab
         -- that was backgrounded and a refresh all land in the same place.
         case when o.delivery_status = 'SEARCHING' and o.search_deadline_at is not null
              then greatest(0, extract(epoch from (o.search_deadline_at - now()))::integer) end,
         now(),
         o.accepted_at, o.preparing_at, o.ready_at,
         o.assigned_at, o.picked_up_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- THE PARTNER'S FIRST NAME, AND IT SURVIVES THE DELIVERY NOW. It used
         -- to be nulled the moment the delivery ended, so the rating prompt
         -- said "your Partner" and the order history named nobody — which made
         -- rating somebody an oddly anonymous act. A first name is what one
         -- person tells another; the PHONE NUMBER is the thing that closes with
         -- the delivery, and it still does on the line below.
         public.given_name(pu.first_name, pu.full_name),
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         -- THE COLLECTION CODE IS NOT HERE. The vendor holds it and reads it
         -- out; the customer types it in. Returning it to the customer would
         -- put holder and performer on the same side of the counter.
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
         o.order_status = 'COMPLETED'
           and o.delivery_status = 'DELIVERED'
           and o.partner_id is not null
           and rt.order_id is null,
         rt.stars,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot,
                     'quantity', oi.quantity,
                     'unit_price_pesewas', oi.unit_price_pesewas,
                     'line_total_pesewas', oi.line_total_pesewas) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
    left join public.order_secrets s on s.order_id = o.id
    left join public.partner_ratings rt on rt.order_id = o.id
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;


ALTER FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_order_list"("p_limit" integer DEFAULT 30) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_name" "text", "vendor_image_path" "text", "order_type" "public"."order_type", "stage" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "item_count" bigint, "items_summary" "text", "total_pesewas" bigint, "submitted_at" timestamp with time zone, "completed_at" timestamp with time zone, "seconds_to_deadline" integer, "partner_first_name" "text", "cancellation_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, o.vendor_order_no, v.name,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         o.order_type,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         -- "2× Jollof, Water". The names as they were when ordered, so a store
         -- renaming a dish does not rewrite somebody's history.
         (select string_agg(
                   case when oi.quantity > 1
                        then oi.quantity::text || '× ' || oi.name_snapshot
                        else oi.name_snapshot end,
                   ', ' order by oi.created_at)
            from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at, o.completed_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         -- First name only, and it stays after the delivery. The PHONE NUMBER
         -- is what ends with the delivery, and this list never carried one.
         public.given_name(pu.first_name, pu.full_name),
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.users pu on pu.id = o.partner_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;


ALTER FUNCTION "public"."customer_order_list"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."customer_order_list"("p_limit" integer) IS 'The caller''s own orders, newest first, as a history: the store and its primary photo, a one-line summary of the items, the total and the stage. No phone numbers, no codes. Scoped to auth.uid().';


CREATE OR REPLACE FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status" DEFAULT 'NONE'::"public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type" DEFAULT NULL::"public"."fulfilment_type") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    -- Kept so an order placed before paid-first ordering still reads sensibly
    -- in somebody's history. Nothing new ever reaches it.
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'

    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'

    when p_order_status = 'PREPARING' and p_delivery_status = 'ASSIGNED' then 'PREPARING_PARTNER_ASSIGNED'
    -- BEING MADE, AND BEING LOOKED FOR. Both at once, and the screen says both.
    when p_order_status = 'PREPARING' and p_delivery_status = 'SEARCHING' then 'PREPARING_SEARCHING'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

    when p_order_status = 'READY' and p_delivery_status = 'SEARCHING'         then 'SEARCHING_PARTNER'
    when p_order_status = 'READY' and p_delivery_status = 'ASSIGNED'          then 'PARTNER_ASSIGNED'
    when p_order_status = 'READY' and p_delivery_status = 'PICKED_UP'         then 'ON_THE_WAY'
    when p_order_status = 'READY' and p_delivery_status = 'FAILED_NO_PARTNER' then 'NO_PARTNER'
    when p_order_status = 'READY'                                            then 'READY'

    -- THE STORE'S PART CAN END BEFORE THE ORDER DOES. A Partner who has
    -- collected leaves order_status at READY, but an administrator completing
    -- an order by hand moves it to COMPLETED while the delivery is still in
    -- flight. Reading the delivery first keeps the customer's screen on the
    -- journey they are actually watching.
    when p_delivery_status = 'PICKED_UP'                              then 'ON_THE_WAY'
    when p_delivery_status = 'FAILED_CUSTOMER_ABSENT'                 then 'CUSTOMER_ABSENT'
    when p_order_status = 'COMPLETED'                                 then 'COMPLETED'
    when p_order_status = 'REJECTED'                                  then 'REJECTED'
    when p_order_status = 'EXPIRED'                                   then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;


ALTER FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type") IS 'The one stage a customer is shown, computed from all three state dimensions together. The screen decides wording; this decides which state the order is in.';


CREATE OR REPLACE FUNCTION "public"."customer_rate_partner"("p_order_id" "uuid", "p_stars" smallint, "p_comment" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders
   where id = p_order_id and customer_id = auth.uid();

  -- AUTHORISATION failure: raise. A wrong order id and somebody else's order
  -- get the same message, so probing tells the caller nothing.
  if not found then
    raise exception 'that is not your order' using errcode = 'insufficient_privilege';
  end if;

  if p_stars is null or p_stars < 1 or p_stars > 5 then
    raise exception 'choose between one and five stars' using errcode = 'check_violation';
  end if;

  -- STATE failures return, so the caller can be told which one it was without
  -- a rejected rating rolling back anything.
  if v_order.partner_id is null then
    return row(false, 'no Partner brought this order')::public.transition_result;
  end if;
  if v_order.order_status <> 'COMPLETED' or v_order.delivery_status <> 'DELIVERED' then
    return row(false, 'you can rate a delivery once it is complete')::public.transition_result;
  end if;

  -- The Partner comes from the ORDER. Nothing the caller sent decides who is
  -- being rated.
  insert into public.partner_ratings (order_id, partner_id, customer_id, stars, comment)
  values (p_order_id, v_order.partner_id, auth.uid(), p_stars,
          nullif(btrim(coalesce(p_comment, '')), ''))
  on conflict (order_id) do nothing;

  if not found then
    return row(false, 'you have already rated this delivery')::public.transition_result;
  end if;

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_rate_partner"("p_order_id" "uuid", "p_stars" smallint, "p_comment" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_reward_milestones"() RETURNS integer[]
    LANGUAGE "sql" IMMUTABLE
    AS $$ select array[25, 40, 50]::integer[]; $$;


ALTER FUNCTION "public"."customer_reward_milestones"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."customer_reward_milestones"() IS 'The marks on the progress bar, ascending. The LAST one is the goal — reaching it is what creates a customer_rewards row.';


CREATE OR REPLACE FUNCTION "public"."deliverable_locations"() RETURNS TABLE("location_id" "uuid", "path" "text", "zone" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select l.id,
         public.location_path(l.id),
         coalesce((select z.name from public.locations z where z.id = public.location_zone(l.id)), 'Campus')
    from public.locations l
   where l.is_deliverable and l.is_active
   order by public.location_path(l.id);
$$;


ALTER FUNCTION "public"."deliverable_locations"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_partner_search"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_count integer := 0;
  v_id    uuid;
begin
  perform public.assert_service_or_admin();

  for v_id in
    update public.orders
       set delivery_status = 'FAILED_NO_PARTNER'
     where delivery_status = 'SEARCHING' and search_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'DISPATCH_FAILED', true, 'SYSTEM',
      'delivery_status', 'SEARCHING', 'FAILED_NO_PARTNER',
      'no partner accepted within the search window; food order is unaffected');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."expire_partner_search"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_stale_orders"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_count integer := 0;
  v_id    uuid;
begin
  perform public.assert_service_or_admin();

  -- Legacy: an order still waiting on a vendor from before paid-first ordering.
  for v_id in
    update public.orders
       set order_status = 'EXPIRED', cancelled_at = now(),
           cancellation_reason = 'vendor did not respond within the acceptance window'
     where order_status = 'SUBMITTED' and accept_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'ORDER_EXPIRED', true, 'SYSTEM',
      'order_status', 'SUBMITTED', 'EXPIRED', 'vendor acceptance window elapsed');
    v_count := v_count + 1;
  end loop;

  -- Priced, never paid. UNPAID only: a payment in flight is PENDING and belongs
  -- to expire_stale_payments(), which knows how to ask the provider first.
  for v_id in
    update public.orders
       set order_status = 'CANCELLED', cancelled_at = now(),
           cancellation_reason = 'the order was not paid for'
     where order_status = 'ACCEPTED'
       and payment_status = 'UNPAID'
       and accept_deadline_at is not null
       and accept_deadline_at <= now()
    returning id
  loop
    perform public.log_order_event(v_id, 'ORDER_EXPIRED', true, 'SYSTEM',
      'order_status', 'ACCEPTED', 'CANCELLED', 'payment window elapsed');
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."expire_stale_orders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expire_stale_payments"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg     public.pricing_config%rowtype;
  v_count   integer := 0;
  v_payment record;
begin
  perform public.assert_service_or_admin();
  select * into v_cfg from public.pricing_config where id;

  for v_payment in
    select p.id
      from public.payments p
     where p.status = 'PENDING'
       and p.created_at < now() - make_interval(secs => v_cfg.payment_pending_timeout_seconds)
  loop
    perform public.mark_payment_failed_internal(
      v_payment.id,
      'no confirmation from the payment provider within the timeout'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."expire_stale_payments"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_payment"("p_payment_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_service_or_admin();
  return public.mark_payment_failed_internal(p_payment_id, p_reason);
end;
$$;


ALTER FUNCTION "public"."fail_payment"("p_payment_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."payouts"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- Money already out of the door is not un-sent by a late failure event.
  if v_payout.status = 'PAID' then
    return v_payout;
  end if;
  -- Already terminal: idempotent replay, and a failure after a reversal has
  -- nothing left to unwind.
  if v_payout.status in ('FAILED', 'REVERSED') then
    return v_payout;
  end if;

  update public.payouts
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not failable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'ELIGIBLE', settlement_run_id = null, settled_at = null
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id
     and status = 'SETTLING';

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forbid_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;


ALTER FUNCTION "public"."forbid_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fulfilment_options"("p_order_id" "uuid") RETURNS TABLE("fulfilment_type" "public"."fulfilment_type", "delivery_fee_pesewas" bigint, "total_pesewas" bigint, "is_available" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select f.fulfilment_type,
         case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         o.subtotal_pesewas + o.service_fee_pesewas
           + case when f.fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         -- Pickup is always on offer. Delivery depends on whether there are
         -- Partners to be had, which is an administrator's switch.
         case when f.fulfilment_type = 'DELIVERY'
              then coalesce(c.partner_delivery_enabled, true) else true end
    from public.orders o
    cross join public.pricing_config c
    cross join (values ('PICKUP'::public.fulfilment_type), ('DELIVERY'::public.fulfilment_type))
                 as f(fulfilment_type)
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and c.id
   order by f.fulfilment_type;
$$;


ALTER FUNCTION "public"."fulfilment_options"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_numeric_code"("p_digits" integer DEFAULT 4) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_bytes bytea := extensions.gen_random_bytes(4);
  v_num   bigint;
begin
  v_num := (get_byte(v_bytes, 0)::bigint << 24)
         | (get_byte(v_bytes, 1)::bigint << 16)
         | (get_byte(v_bytes, 2)::bigint << 8)
         |  get_byte(v_bytes, 3)::bigint;
  return lpad((v_num % power(10, p_digits)::bigint)::text, p_digits, '0');
end;
$$;


ALTER FUNCTION "public"."generate_numeric_code"("p_digits" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_delivery_offers"() RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_name" "text", "vendor_location" "text", "destination_zone" "text", "destination_floor" "text", "walk_minutes" integer, "earnings_pesewas" bigint, "item_count" bigint, "ready_at" timestamp with time zone, "food_is_ready" boolean, "order_type" "public"."order_type", "seconds_until_search_expires" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    o.id, o.order_number, o.vendor_order_no, v.name, public.location_path(v.location_id),
    -- BLOCK AND FLOOR, never the room. The exact destination arrives with the
    -- assignment, to the one person who then needs it.
    coalesce(z.name, 'Campus'),
    public.location_floor(o.destination_location_id),
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    -- WHETHER THERE IS ANYTHING TO COLLECT YET. Offers go out while the order
    -- is still being put together, so this is the difference between "go now"
    -- and "it is yours, wait for the store".
    (o.order_status = 'READY'),
    o.order_type,
    -- How long this offer has left before the search gives up. The Partner sees
    -- the same deadline the customer is counting down against.
    case when o.search_deadline_at is not null
         then greatest(0, extract(epoch from (o.search_deadline_at - now()))::integer) end
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  cross join public.pricing_config c
  where c.id
    and o.delivery_status = 'SEARCHING'
    and o.order_status in ('PREPARING', 'READY')
    and o.payment_status = 'PAID'
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- A Partner already at capacity is shown nothing, rather than shown offers
    -- that would be refused on acceptance. How many that is, is an
    -- administrator's setting — not a number in this file.
    and (
      select count(*) from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    ) < c.max_active_deliveries_per_partner
    and o.customer_id <> auth.uid()
    and v.owner_user_id is distinct from auth.uid()
  order by o.ready_at asc nulls last, o.created_at asc;
$$;


ALTER FUNCTION "public"."get_delivery_offers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_delivery_code"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_code text;
begin
  select s.delivery_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id and o.customer_id = auth.uid();

  if v_code is null then
    raise exception 'no delivery code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."get_my_delivery_code"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_code text;
begin
  select s.pickup_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and o.customer_id = auth.uid()
     -- Only for an order they are actually collecting. A delivery order's
     -- pickup code belongs to the vendor and the Partner, never to them.
     and o.fulfilment_type = 'PICKUP'
     and o.payment_status = 'PAID';

  if v_code is null then
    raise exception 'no collection code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select coalesce(
    nullif(btrim(coalesce(p_first, '')), ''),
    nullif(split_part(btrim(coalesce(p_full, '')), ' ', 1), '')
  );
$$;


ALTER FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") IS 'The first name to show, falling back to the first word of a legacy full_name. One definition, so every screen calls the same person the same thing.';


CREATE OR REPLACE FUNCTION "public"."handle_auth_user_phone_confirmed"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if (new.phone_confirmed_at is not null and old.phone_confirmed_at is null)
     or (new.email_confirmed_at is not null and old.email_confirmed_at is null) then
    perform public.handle_new_auth_user_for(new.id);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_auth_user_phone_confirmed"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_auth_user_phone_confirmed"() IS 'Provisions public.users when a contact detail is CONFIRMED — a phone for a vendor, an address for a customer. Named for the phone case it was written for; it has handled both since email sign-in arrived. Only confirmation provisions: GoTrue inserts the auth.users row when a code is first requested, and creating a profile then would let anyone claim an address or a number they do not own simply by asking for a code.';


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.phone_confirmed_at is null and new.email_confirmed_at is null then
    return new;
  end if;

  perform public.handle_new_auth_user_for(new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_new_auth_user"() IS 'Provisions public.users for an account created already confirmed. Delegates to handle_new_auth_user_for() so the handling of a contested phone or address lives in exactly one place.';


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user  auth.users%rowtype;
  v_phone text;
  v_email text;
  v_name  text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found then
    return;
  end if;

  -- Only a CONFIRMED contact detail provisions anything. GoTrue inserts the
  -- auth.users row when a code is first requested, before anything is proven.
  if v_user.phone_confirmed_at is null and v_user.email_confirmed_at is null then
    return;
  end if;

  -- GoTrue stores phone numbers without the leading '+'. Our E.164 check wants it.
  v_phone := nullif(v_user.phone, '');
  if v_phone is not null and left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;
  if v_user.phone_confirmed_at is null then
    v_phone := null;
  end if;

  v_email := case
               when v_user.email_confirmed_at is not null
               then lower(nullif(v_user.email, ''))
             end;
  v_name := nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), '');

  -- Already carried by ANOTHER identity, so not ours to take. Dropped from this
  -- insert rather than fought over, and reported so it is findable.
  if v_phone is not null and exists (
    select 1 from public.users u where u.phone = v_phone and u.id <> p_user_id
  ) then
    raise warning 'handle_new_auth_user_for: phone % already belongs to another identity; provisioning % without it', v_phone, p_user_id;
    v_phone := null;
  end if;

  if v_email is not null and exists (
    select 1 from public.users u where lower(u.email) = v_email and u.id <> p_user_id
  ) then
    raise warning 'handle_new_auth_user_for: email already belongs to another identity; provisioning % without it', p_user_id;
    v_email := null;
  end if;

  insert into public.users (id, phone, email, full_name)
  values (p_user_id, v_phone, v_email, v_name)
  on conflict (id) do nothing;

exception
  -- BELT AND BRACES. The checks above are not atomic against a concurrent
  -- insert, and a lost race must still not reach GoTrue as a 500. Provision the
  -- bare identity so confirmation completes; the contact details are the
  -- application's problem, not auth's.
  when unique_violation then
    raise warning 'handle_new_auth_user_for: lost a race on a contact detail for %; provisioning without phone or email (%)', p_user_id, sqlerrm;
    insert into public.users (id, full_name)
    values (p_user_id, v_name)
    on conflict (id) do nothing;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") IS 'Provisions public.users when a contact detail is CONFIRMED. A phone or address already held by another identity is DROPPED from the insert rather than contested — never reassigned, never allowed to raise. An escaping unique_violation here aborts GoTrue''s confirmation transaction and surfaces as an opaque 500 "Error confirming user".';


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.users u
     where u.id = auth.uid() and u.is_admin and not u.is_suspended
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_approved_partner"("p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
      from public.partner_profiles p
      join public.users u on u.id = p.user_id
     where p.user_id = coalesce(p_user_id, auth.uid())
       and p.status = 'APPROVED'
       and not u.is_suspended
  );
$$;


ALTER FUNCTION "public"."is_approved_partner"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_customer"("p_user_id" "uuid" DEFAULT NULL::"uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
      from public.customer_profiles c
      join public.users u on u.id = c.user_id
     where c.user_id = coalesce(p_user_id, auth.uid())
       and not u.is_suspended
  );
$$;


ALTER FUNCTION "public"."is_customer"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_service_or_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'role')
      = 'service_role'
    or session_user in ('postgres', 'supabase_admin')
    or public.is_admin();
$$;


ALTER FUNCTION "public"."is_service_or_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (select 1 from public.my_vendor_ids() v where v = p_vendor_id);
$$;


ALTER FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."location_floor"("p_location_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with recursive up as (
    select l.id, l.parent_id, l.kind, l.name
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.kind, l.name
      from public.locations l
      join up on l.id = up.parent_id
  )
  select name from up where kind = 'FLOOR' limit 1;
$$;


ALTER FUNCTION "public"."location_floor"("p_location_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."location_floor"("p_location_id" "uuid") IS 'The FLOOR a destination sits on, or null. Shown on an offer beside the block: a fourth-floor room and a ground-floor one are the same block and a very different walk. The ROOM is never on an offer.';


CREATE OR REPLACE FUNCTION "public"."location_path"("p_location_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with recursive up as (
    select l.id, l.parent_id, l.name, 0 as depth
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.name, up.depth + 1
      from public.locations l
      join up on l.id = up.parent_id
  )
  select string_agg(name, ' / ' order by depth desc) from up;
$$;


ALTER FUNCTION "public"."location_path"("p_location_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."location_zone"("p_location_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with recursive up as (
    select l.id, l.parent_id, l.kind
      from public.locations l
     where l.id = p_location_id
    union all
    select l.id, l.parent_id, l.kind
      from public.locations l
      join up on l.id = up.parent_id
  )
  select id from up where kind = 'BLOCK' limit 1;
$$;


ALTER FUNCTION "public"."location_zone"("p_location_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."locations_prevent_cycle"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_ancestor uuid := new.parent_id;
  v_hops     integer := 0;
begin
  while v_ancestor is not null loop
    if v_ancestor = new.id then
      raise exception 'location cycle detected at %', new.id using errcode = 'check_violation';
    end if;
    v_hops := v_hops + 1;
    if v_hops > 32 then
      raise exception 'location tree deeper than 32 levels' using errcode = 'check_violation';
    end if;
    select parent_id into v_ancestor from public.locations where id = v_ancestor;
  end loop;
  return new;
end;
$$;


ALTER FUNCTION "public"."locations_prevent_cycle"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_admin_action"("p_action" "text", "p_target_type" "text", "p_target_id" "uuid", "p_reason" "text", "p_before" "jsonb" DEFAULT NULL::"jsonb", "p_after" "jsonb" DEFAULT NULL::"jsonb", "p_details" "jsonb" DEFAULT '{}'::"jsonb") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_id    bigint;
  v_admin uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.admin_actions (
    admin_user_id, action, target_type, target_id, reason, before_state, after_state, details
  )
  values (v_admin, p_action, p_target_type, p_target_id, p_reason, p_before, p_after, p_details)
  returning id into v_id;

  return v_id;
end;
$$;


ALTER FUNCTION "public"."log_admin_action"("p_action" "text", "p_target_type" "text", "p_target_id" "uuid", "p_reason" "text", "p_before" "jsonb", "p_after" "jsonb", "p_details" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_order_event"("p_order_id" "uuid", "p_event" "text", "p_accepted" boolean, "p_actor_role" "text" DEFAULT 'SYSTEM'::"text", "p_dimension" "text" DEFAULT NULL::"text", "p_from" "text" DEFAULT NULL::"text", "p_to" "text" DEFAULT NULL::"text", "p_reason" "text" DEFAULT NULL::"text", "p_details" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  insert into public.order_events (
    order_id, actor_id, actor_role, event, dimension,
    from_state, to_state, accepted, reason, details
  )
  values (
    p_order_id, auth.uid(), p_actor_role, p_event, p_dimension,
    p_from, p_to, p_accepted, p_reason, p_details
  );
$$;


ALTER FUNCTION "public"."log_order_event"("p_order_id" "uuid", "p_event" "text", "p_accepted" boolean, "p_actor_role" "text", "p_dimension" "text", "p_from" "text", "p_to" "text", "p_reason" "text", "p_details" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_payment_failed_internal"("p_payment_id" "uuid", "p_reason" "text") RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payment public.payments%rowtype;
begin
  update public.payments
     set status = 'FAILED', failure_reason = p_reason
   where id = p_payment_id and status = 'PENDING'
  returning * into v_payment;

  if not found then
    raise exception 'payment was not PENDING' using errcode = 'check_violation';
  end if;

  -- Back to FAILED, from which the customer may retry. The food order is
  -- untouched: the vendor's acceptance still stands.
  update public.orders set payment_status = 'FAILED'
   where id = v_payment.order_id and payment_status = 'PENDING';

  perform public.log_order_event(v_payment.order_id, 'PAYMENT_FAILED', true, 'SYSTEM',
    'payment_status', 'PENDING', 'FAILED', p_reason);

  return v_payment;
end;
$$;


ALTER FUNCTION "public"."mark_payment_failed_internal"("p_payment_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_payout_paid"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text", "p_amount_pesewas" bigint DEFAULT NULL::bigint) RETURNS "public"."payouts"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  if v_payout.status = 'PAID' then
    return v_payout;  -- idempotent replay
  end if;

  -- The provider must have moved exactly what was owed. A mismatch is a
  -- reconciliation incident, not something to paper over — the same rule
  -- confirm_payment applies to money coming in.
  if p_amount_pesewas is not null and p_amount_pesewas <> v_payout.amount_pesewas then
    raise exception 'payout amount mismatch: provider reported % but payout is %',
      p_amount_pesewas, v_payout.amount_pesewas using errcode = 'check_violation';
  end if;

  update public.payouts
     set status = 'PAID', provider = p_provider,
         provider_transfer_id = p_provider_transfer_id, paid_at = now()
   where id = p_payout_id and status in ('PENDING', 'PROCESSING')
  returning * into v_payout;

  if not found then
    raise exception 'payout was not payable' using errcode = 'check_violation';
  end if;

  update public.allocations
     set status = 'SETTLED', settled_at = now()
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id = v_payout.payee_id;

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."mark_payout_paid"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text", "p_amount_pesewas" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_payout_processing"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text") RETURNS "public"."payouts"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- A webhook can beat the HTTP response that started the transfer. Winning
  -- that race must not drag a PAID payout backwards.
  if v_payout.status in ('PAID', 'PROCESSING') then
    return v_payout;
  end if;

  update public.payouts
     set status = 'PROCESSING', provider = p_provider,
         provider_transfer_id = p_provider_transfer_id
   where id = p_payout_id and status = 'PENDING'
  returning * into v_payout;

  if not found then
    raise exception 'payout was not PENDING' using errcode = 'check_violation';
  end if;

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."mark_payout_processing"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_webhook_processed"("p_webhook_id" "uuid", "p_status" "public"."webhook_event_status", "p_error" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  update public.webhook_events
     set status = p_status, processed_at = now(), error = p_error
   where id = p_webhook_id;
$$;


ALTER FUNCTION "public"."mark_webhook_processed"("p_webhook_id" "uuid", "p_status" "public"."webhook_event_status", "p_error" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_capabilities"() RETURNS "jsonb"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select case
    when auth.uid() is null then jsonb_build_object('authenticated', false)
    else (
      select jsonb_build_object(
        'authenticated',    true,
        'user_id',          u.id,
        'phone',            u.phone,
        'full_name',        u.full_name,
        'first_name',       public.given_name(u.first_name, u.full_name),
        'last_name',        u.last_name,
        'email',            u.email,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,

        'is_customer',      (c.user_id is not null) and not u.is_suspended,
        'can_order',        (c.user_id is not null) and not u.is_suspended,
        'customer_status',  case when c.user_id is not null then 'ONBOARDED'
                                 else 'NOT_ONBOARDED' end,
        'affiliation',      c.affiliation,
        'graduation_year',  c.graduation_year,
        'gender',           c.gender,
        'student_id_number', c.student_id_number,
        -- HISTORICAL. Never written any more; kept so an account created before
        -- graduation_year replaced it still reports what it holds.
        'level',            c.level,

        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),

        'vendor_ids',       coalesce(
                              (select jsonb_agg(v.id)
                                 from public.vendors v
                                where v.owner_user_id = u.id
                                  and v.status = 'ACTIVE'
                                  and not u.is_suspended),
                              '[]'::jsonb),
        'vendor_status',    coalesce(
                              (select v.status::text from public.vendors v
                                where v.owner_user_id = u.id),
                              'NOT_APPLIED'),
        'vendor_id',        (select v.id from public.vendors v where v.owner_user_id = u.id)
      )
      from public.users u
      left join public.customer_profiles c on c.user_id = u.id
      left join public.partner_profiles  p on p.user_id = u.id
      where u.id = auth.uid()
    )
  end;
$$;


ALTER FUNCTION "public"."my_capabilities"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_customer_profile"() RETURNS TABLE("student_id_number" "text", "level" "text", "onboarded_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select c.student_id_number, c.level, c.onboarded_at
    from public.customer_profiles c
   where c.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_customer_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_order_summary"() RETURNS TABLE("total_orders" bigint, "completed_orders" bigint, "active_orders" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*) filter (where o.order_status <> 'DRAFT'),
         count(*) filter (where o.order_status = 'COMPLETED'),
         count(*) filter (
           where o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
         )
    from public.orders o
   where o.customer_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_order_summary"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."my_order_summary"() IS 'Counts for the customer account screen. Derived from the orders themselves, so it can never disagree with the list underneath it.';


CREATE OR REPLACE FUNCTION "public"."my_outstanding_terms"() RETURNS TABLE("audience" "public"."terms_audience", "version" integer, "title" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with required as (
    select 'CUSTOMER'::public.terms_audience as audience
     where exists (select 1 from public.customer_profiles c where c.user_id = auth.uid())
    union all
    select 'VENDOR'::public.terms_audience
     where exists (select 1 from public.vendors v where v.owner_user_id = auth.uid())
    union all
    select 'PARTNER'::public.terms_audience
     where exists (
       select 1 from public.partner_profiles p
        where p.user_id = auth.uid() and p.status = 'APPROVED'
     )
  ),
  current_docs as (
    select distinct on (t.audience) t.audience, t.version, t.title
      from public.terms_documents t
     where t.published_at is not null
     order by t.audience, t.version desc
  )
  select c.audience, c.version, c.title
    from required r
    join current_docs c on c.audience = r.audience
   where not exists (
     select 1 from public.terms_acceptances a
      where a.user_id = auth.uid() and a.audience = c.audience and a.version = c.version
   );
$$;


ALTER FUNCTION "public"."my_outstanding_terms"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_partner_activity"() RETURNS TABLE("is_online" boolean, "current_session_seconds" integer, "online_seconds_today" bigint, "online_seconds_this_week" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with bounds as (
    select date_trunc('day', now()) as day_start,
           date_trunc('week', now()) as week_start
  ),
  windowed as (
    select greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.day_start)))) as today_seconds,
           greatest(0, extract(epoch from (
             least(coalesce(s.ended_at, now()), now())
             - greatest(s.started_at, b.week_start)))) as week_seconds
      from public.partner_sessions s
      cross join bounds b
     where s.user_id = auth.uid()
       and coalesce(s.ended_at, now()) >= b.week_start
  )
  select p.is_available,
         (select extract(epoch from (now() - s.started_at))::integer
            from public.partner_sessions s
           where s.user_id = auth.uid() and s.ended_at is null
           limit 1),
         (select coalesce(sum(w.today_seconds), 0)::bigint from windowed w),
         (select coalesce(sum(w.week_seconds), 0)::bigint from windowed w)
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_partner_activity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_partner_application"() RETURNS TABLE("status" "public"."partner_application_status", "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "review_notes" "text", "is_available" boolean, "has_documents" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.status, p.applied_at, p.reviewed_at, p.review_notes, p.is_available,
         nullif(btrim(coalesce(p.student_id_image_path, '')), '') is not null
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_partner_application"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_partner_payouts"("p_limit" integer DEFAULT 20) RETURNS TABLE("payout_id" "uuid", "amount_pesewas" bigint, "status" "text", "period_start" timestamp with time zone, "period_end" timestamp with time zone, "created_at" timestamp with time zone, "paid_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.id, p.amount_pesewas,
         case p.status
           when 'PAID' then 'PAID'
           when 'REVERSED' then 'RETURNED'
           -- PENDING, PROCESSING and FAILED all read as "being processed": a
           -- failed transfer releases the money back into the next run, so from
           -- the Partner's side nothing has gone wrong and nothing is lost.
           else 'PROCESSING'
         end,
         r.period_start, r.period_end, p.created_at, p.paid_at
    from public.payouts p
    left join public.settlement_runs r on r.id = p.settlement_run_id
   where p.payee_type = 'PARTNER' and p.payee_id = auth.uid()
   order by p.created_at desc
   limit least(coalesce(p_limit, 20), 100);
$$;


ALTER FUNCTION "public"."my_partner_payouts"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_partner_rating"() RETURNS TABLE("rating_count" bigint, "average_stars" numeric, "last_rated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*), round(avg(r.stars), 2), max(r.created_at)
    from public.partner_ratings r
   where r.partner_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_partner_rating"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."my_partner_rating"() IS 'A Partner''s own average. An aggregate on purpose: a Partner who could read individual rows could work out who left which one.';


CREATE OR REPLACE FUNCTION "public"."my_payout_destination"() RETURNS TABLE("payee_type" "public"."payee_type", "payee_id" "uuid", "momo_network" "text", "account_last3" "text", "account_name" "text", "transfers_ready" boolean, "split_ready" boolean, "setup_error" "text", "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select d.payee_type, d.payee_id,
         d.momo_network, right(d.account_number, 3), d.account_name,
         d.provider_recipient_code is not null,
         d.provider_subaccount_code is not null,
         d.subaccount_error,
         d.updated_at
    from public.payout_destinations d
   where (d.payee_type = 'PARTNER' and d.payee_id = auth.uid())
      or (d.payee_type = 'VENDOR'
          and exists (select 1 from public.vendors v
                       where v.id = d.payee_id and v.owner_user_id = auth.uid()))
   order by d.payee_type;
$$;


ALTER FUNCTION "public"."my_payout_destination"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_reward_progress"() RETURNS TABLE("completed_orders" integer, "goal_orders" integer, "milestones" integer[], "milestones_reached" integer[], "next_milestone" integer, "orders_to_next" integer, "reward_unlocked" boolean, "reward_unlocked_at" timestamp with time zone, "reward_status" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with counted as (
    select (select count(*)::integer from public.orders o
             where o.customer_id = auth.uid() and o.order_status = 'COMPLETED') as done,
           public.customer_reward_milestones() as marks
  ),
  shaped as (
    select done, marks,
           marks[array_length(marks, 1)] as goal,
           array(select m from unnest(marks) m where m <= done order by m) as reached,
           (select min(m) from unnest(marks) m where m > done) as next
      from counted
  ),
  latest as (
    select r.unlocked_at, r.status
      from public.customer_rewards r
     where r.user_id = auth.uid()
     order by r.cycle desc
     limit 1
  )
  select s.done, s.goal, s.marks, s.reached, s.next,
         case when s.next is not null then s.next - s.done end,
         l.unlocked_at is not null,
         l.unlocked_at,
         l.status
    from shaped s
    left join latest l on true
   where auth.uid() is not null;
$$;


ALTER FUNCTION "public"."my_reward_progress"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."my_reward_progress"() IS 'The customer''s own progress towards the order goal. Counts COMPLETED orders and nothing else, so there is no second number that can disagree with the order list.';


CREATE OR REPLACE FUNCTION "public"."my_scan_order"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "scan_status" "public"."scan_status", "details" "text", "uploaded_at" timestamp with time zone, "released_at" timestamp with time zone, "redeemed_at" timestamp with time zone, "refused_at" timestamp with time zone, "refusal_reason" "text", "pack_fee_pesewas" bigint, "scanned_value_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.scan_status, s.details, s.uploaded_at, s.released_at,
         s.redeemed_at, s.refused_at, s.refusal_reason,
         coalesce(o.pack_fee_pesewas, 0),
         (select coalesce(sum(oi.line_total_pesewas), 0)
            from public.order_items oi where oi.order_id = o.id)
    from public.orders o
    join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and (o.customer_id = auth.uid() or public.is_admin());
$$;


ALTER FUNCTION "public"."my_scan_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_vendor_application"() RETURNS TABLE("vendor_id" "uuid", "name" "text", "status" "public"."vendor_status", "description" "text", "category_id" "uuid", "category_name" "text", "applicant_name" "text", "owner_is_student" boolean, "is_accepting_orders" boolean, "rejection_reason" "text", "submitted_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "location_id" "uuid", "location_note" "text", "walk_minutes_to_campus" integer, "can_accept_scans" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id, v.name, v.status, v.description, v.category_id, k.name,
         v.applicant_name, v.owner_is_student, v.is_accepting_orders,
         v.rejection_reason, v.submitted_at, v.reviewed_at,
         v.location_id, v.location_note, v.walk_minutes_to_campus,
         v.can_accept_scans
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.owner_user_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_vendor_application"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_vendor_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id
    from public.vendors v
    join public.users u on u.id = v.owner_user_id
   where v.owner_user_id = auth.uid() and not u.is_suspended;
$$;


ALTER FUNCTION "public"."my_vendor_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_vendor_order_no"("p_vendor_id" "uuid", "p_day" "date") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_no integer;
begin
  insert into public.vendor_order_counters as c (vendor_id, order_day, last_no)
  values (p_vendor_id, p_day, 1)
  on conflict (vendor_id, order_day) do update
     set last_no = c.last_no + 1,
         updated_at = now()
  returning c.last_no into v_no;

  return v_no;
end;
$$;


ALTER FUNCTION "public"."next_vendor_order_no"("p_vendor_id" "uuid", "p_day" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."next_vendor_order_no"("p_vendor_id" "uuid", "p_day" "date") IS 'The next queue number for this store today. Atomic: the upsert''s DO UPDATE locks the counter row, so simultaneous orders queue behind one another rather than sharing a number.';


CREATE OR REPLACE FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.notification_events
     where dedupe_key = p_dedupe_key and succeeded
  );
$$;


ALTER FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notification_events_append_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'DELETE' then
    -- The one permitted exception: an audited administrative purge, in progress
    -- in THIS transaction. See admin_purge_notification_events().
    if coalesce(current_setting('campus_dash.notification_purge', true), '') = 'on' then
      return old;
    end if;
    raise exception 'notification_events is append-only; DELETE is not permitted'
      using errcode = 'insufficient_privilege';
  end if;

  if (to_jsonb(new) - 'delivery_status' - 'delivery_updated_at' - 'provider_message_id')
     is distinct from
     (to_jsonb(old) - 'delivery_status' - 'delivery_updated_at' - 'provider_message_id')
  then
    raise exception
      'notification_events is append-only; only a provider delivery report may be added'
      using errcode = 'insufficient_privilege';
  end if;

  if old.provider_message_id is not null
     and new.provider_message_id is distinct from old.provider_message_id
  then
    raise exception
      'notification_events is append-only; provider_message_id cannot be rewritten'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."notification_events_append_only"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."notification_events_append_only"() IS 'Keeps notification_events append-only. DELETE is refused unless an audited administrative purge is in progress in the same transaction — a transaction-local flag only admin_purge_notification_events() sets. UPDATE remains limited to provider delivery fields, with no exception at all.';


CREATE OR REPLACE FUNCTION "public"."order_events_append_only"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if tg_op = 'DELETE' then
    if coalesce(current_setting('campus_dash.notification_purge', true), '') = 'on' then
      return old;
    end if;
  end if;
  raise exception '% is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end;
$$;


ALTER FUNCTION "public"."order_events_append_only"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."order_events_append_only"() IS 'Keeps order_events append-only. DELETE is refused unless an audited administrative purge is in progress in the same transaction. UPDATE and INSERT-over are refused unconditionally. admin_actions deliberately does NOT share this exception.';


CREATE OR REPLACE FUNCTION "public"."orders_award_customer_reward"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_goal      integer;
  v_completed integer;
  v_cycle     integer;
begin
  v_goal := (public.customer_reward_milestones())[array_length(public.customer_reward_milestones(), 1)];

  select count(*) into v_completed
    from public.orders
   where customer_id = new.customer_id
     and order_status = 'COMPLETED';

  v_cycle := v_completed / v_goal;
  if v_cycle < 1 then
    return null;
  end if;

  -- ON CONFLICT DO NOTHING is the duplicate guard, and it is the unique index
  -- doing the work rather than a read-then-write that two concurrent
  -- completions could both pass.
  insert into public.customer_rewards (user_id, cycle, goal_orders, completed_orders_at_unlock)
  values (new.customer_id, v_cycle, v_goal, v_completed)
  on conflict (user_id, cycle) do nothing;

  return null;
end;
$$;


ALTER FUNCTION "public"."orders_award_customer_reward"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") RETURNS TABLE("success" boolean, "reason" "text", "order_number" "text", "vendor_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_slot    smallint;
  v_max     smallint;
  v_full    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders o
      join public.vendors v on v.id = o.vendor_id
     where o.id = p_order_id and v.owner_user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a store you own'
      using errcode = 'insufficient_privilege';
  end if;

  select max_active_deliveries_per_partner into v_max from public.pricing_config where id;
  v_max := coalesce(v_max, 2);

  v_full := case
    when v_max = 1 then 'You already have an active delivery. Finish it first.'
    else 'You already have ' || v_max || ' active deliveries. Finish one first.'
  end;

  select s into v_slot
    from generate_series(1, v_max) s
   where not exists (
     select 1 from public.orders a
      where a.partner_id = v_partner
        and a.partner_slot = s
        and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
   )
   order by s
   limit 1;

  if v_slot is null then
    return query select false, v_full, null::text, null::text;
    return;
  end if;

  begin
    update public.orders o
       set partner_id = v_partner,
           partner_slot = v_slot,
           delivery_status = 'ASSIGNED',
           assigned_at = now()
     where o.id = p_order_id
       and o.delivery_status = 'SEARCHING'
       -- PREPARING as well as READY. The offer pool opens at payment now, so
       -- the winner is often decided while the food is still on the stove.
       and o.order_status in ('PREPARING', 'READY')
       and o.payment_status = 'PAID'
       and o.partner_id is null
       and exists (
         select 1 from public.partner_profiles p
          where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
       )
       and (
         select count(*) from public.orders a
          where a.partner_id = v_partner
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < v_max
       and o.customer_id <> v_partner
       and not exists (
         select 1 from public.vendors v
          where v.id = o.vendor_id and v.owner_user_id = v_partner
       )
    returning * into v_order;
  exception
    when unique_violation then
      perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
        'delivery_status', null, 'ASSIGNED', 'partner delivery slot already taken');
      return query select false, v_full, null::text, null::text;
      return;
  end;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text;
    return;
  end if;

  -- Fresh codes, and a fresh attempt counter with them. A Partner who inherits
  -- an order somebody else fumbled starts at zero failures, and the previous
  -- Partner's lockout does not follow the order around.
  update public.order_secrets
     set pickup_code = public.generate_numeric_code(4),
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         pickup_attempts = 0,
         pickup_locked_until = null,
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now()),
         delivery_attempts = 0,
         delivery_locked_until = null
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED', null,
    jsonb_build_object('partner_slot', v_slot));

  return query
    select true, null::text, v_order.order_number, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;


ALTER FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_active_delivery"() RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "partner_slot" smallint, "delivery_status" "public"."delivery_status", "food_is_ready" boolean, "vendor_name" "text", "vendor_location" "text", "vendor_phone" "text", "destination_zone" "text", "destination" "text", "destination_note" "text", "customer_name" "text", "customer_first_name" "text", "customer_phone" "text", "earnings_pesewas" bigint, "item_count" bigint, "assigned_at" timestamp with time zone, "picked_up_at" timestamp with time zone, "customer_absent_reported_at" timestamp with time zone, "seconds_until_absent_allowed" integer, "order_type" "public"."order_type", "scan_status" "public"."scan_status")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.partner_slot,
         o.delivery_status,
         (o.order_status = 'READY'),
         v.name,
         public.location_path(v.location_id),
         -- The vendor's phone is operational, not private: the Partner may need
         -- to say they are running late.
         v.phone,
         coalesce(z.name, 'Campus'),
         -- THE EXACT DESTINATION AND THE CUSTOMER'S NUMBER, from assignment.
         -- A Partner who cannot find a room needs to ring before they are
         -- holding food that is going cold, not after.
         public.location_path(o.destination_location_id),
         o.destination_note,
         c.full_name,
         public.given_name(c.first_name, c.full_name),
         c.phone,
         o.partner_earnings_pesewas,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.assigned_at,
         o.picked_up_at,
         o.customer_absent_reported_at,
         case when o.customer_absent_reported_at is not null
              then greatest(
                0,
                extract(epoch from (
                  o.customer_absent_reported_at
                    + make_interval(secs => (select customer_absent_wait_seconds
                                               from public.pricing_config where id))
                  - now()))::integer
              ) end,
         o.order_type,
         o.scan_status
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    join public.users c on c.id = o.customer_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     -- The window, in the one place it is actually enforced for this screen.
     -- DELIVERED is absent on purpose: a finished delivery stops showing a
     -- phone number, and partner_delivery_history never carried one.
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
   order by o.partner_slot, o.assigned_at;
$$;


ALTER FUNCTION "public"."partner_active_delivery"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_apply"("p_student_id_image_path" "text", "p_terms_id" "uuid" DEFAULT NULL::"uuid") RETURNS "public"."partner_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
  v_status  public.partner_application_status;
  v_doc     public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- PARTNER ⇒ CUSTOMER. The foreign key would refuse this anyway; checking it
  -- here turns a constraint violation into a sentence a person can act on. It
  -- is also the reason no email verification happens here: holding the CUSTOMER
  -- capability already means a verified @acity.edu.gh address.
  if not exists (select 1 from public.customer_profiles where user_id = v_user) then
    raise exception 'finish signing up as a customer before applying to be a Partner'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null then
    raise exception 'a photograph of your student ID is required'
      using errcode = 'check_violation';
  end if;

  -- The terms. Optional in the signature so a caller that predates this can
  -- still work, and refused below when a document IS named but is the wrong
  -- one — a silently ignored terms id would be worse than no terms id.
  if p_terms_id is not null then
    select * into v_doc from public.terms_documents where id = p_terms_id;
    if not found or v_doc.published_at is null or v_doc.audience <> 'PARTNER' then
      raise exception 'the Partner terms must be accepted to continue'
        using errcode = 'check_violation';
    end if;
    if v_doc.version <> (
      select max(t.version) from public.terms_documents t
       where t.audience = 'PARTNER' and t.published_at is not null
    ) then
      raise exception 'those terms have been superseded; reload and try again'
        using errcode = 'check_violation';
    end if;
  end if;

  select status into v_status from public.partner_profiles where user_id = v_user;

  if v_status = 'APPROVED' then
    raise exception 'you are already an approved Partner' using errcode = 'check_violation';
  end if;
  if v_status = 'SUSPENDED' then
    raise exception 'your Partner access is suspended; contact Campus Dash support'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.partner_profiles (
    user_id, status, student_id_image_path, is_available, applied_at
  )
  values (v_user, 'PENDING_REVIEW', btrim(p_student_id_image_path), false, now())
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         student_id_image_path = excluded.student_id_image_path,
         -- A re-application clears any photograph a previous one left behind.
         -- Campus Dash no longer asks for one, so it should not keep one.
         face_image_path       = null,
         is_available          = false,
         applied_at            = now(),
         reviewed_at           = null,
         reviewed_by           = null,
         review_notes          = null,
         documents_purge_after = null
  returning * into v_profile;

  if v_doc.id is not null then
    insert into public.terms_acceptances (user_id, terms_id, audience, version)
    values (v_user, v_doc.id, v_doc.audience, v_doc.version)
    on conflict (user_id, audience, version)
      do update set accepted_at = public.terms_acceptances.accepted_at;
  end if;

  return v_profile;
end;
$$;


ALTER FUNCTION "public"."partner_apply"("p_student_id_image_path" "text", "p_terms_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_availability_follows_status"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'APPROVED' and new.is_available then
      insert into public.partner_sessions (user_id) values (new.user_id)
      on conflict (user_id) where ended_at is null do nothing;
    end if;
    return new;
  end if;

  -- Approval grants availability; losing approval withdraws it. Done before
  -- the session work below, so one update settles both facts.
  if new.status = 'APPROVED' and old.status is distinct from 'APPROVED' then
    new.is_available := true;
  elsif new.status is distinct from 'APPROVED' and old.status = 'APPROVED' then
    new.is_available := false;
  end if;

  -- A Partner is only ever online while APPROVED, whatever the flag says.
  if new.status <> 'APPROVED' then
    new.is_available := false;
  end if;

  if new.is_available and not coalesce(old.is_available, false) then
    insert into public.partner_sessions (user_id) values (new.user_id)
    on conflict (user_id) where ended_at is null do nothing;
  elsif not new.is_available and coalesce(old.is_available, false) then
    update public.partner_sessions
       set ended_at = now(),
           ended_reason = case when new.status <> 'APPROVED' then 'approval withdrawn' end
     where user_id = new.user_id and ended_at is null;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."partner_availability_follows_status"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_cfg     public.pricing_config%rowtype;
begin
  select * into v_cfg from public.pricing_config where id;

  update public.orders o
     set partner_id = null,
         partner_slot = null,
         delivery_status = 'SEARCHING',
         assigned_at = null,
         -- A FRESH WINDOW. The customer is now waiting for a Partner who has
         -- not been found yet, and counting them down against a deadline set
         -- when a different Partner took the job would expire the search under
         -- somebody who had done nothing wrong.
         search_started_at = now(),
         search_deadline_at = now() + make_interval(secs => v_cfg.partner_search_seconds),
         dispatch_generation = o.dispatch_generation + 1
   where o.id = p_order_id
     and o.partner_id = v_partner
     -- Only before handoff. Once PICKED_UP the Partner holds the food and this
     -- is an admin problem, not a self-service cancellation.
     and o.delivery_status = 'ASSIGNED'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_CANCEL', false, 'PARTNER',
      'delivery_status', null, 'SEARCHING', 'not the assigned partner, or food already collected');
    return row(false, 'you are not the assigned partner, or the food is already collected')::public.transition_result;
  end if;

  -- ROTATE. The previous pickup code dies here, immediately.
  update public.order_secrets
     set pickup_code = null,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = null
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_CANCEL', true, 'PARTNER',
    'delivery_status', 'ASSIGNED', 'SEARCHING', p_reason,
    jsonb_build_object('pickup_code_rotated', true,
                       'dispatch_generation', v_order.dispatch_generation,
                       'search_reopened', true));

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_capacity"() RETURNS TABLE("max_active" integer, "active_now" integer, "slots_free" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select c.max_active_deliveries_per_partner::integer,
         v.live::integer,
         greatest(0, c.max_active_deliveries_per_partner - v.live)::integer
    from public.pricing_config c
    cross join lateral (
      select count(*)::integer as live
        from public.orders o
       where o.partner_id = auth.uid()
         and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
    ) v
   where c.id and auth.uid() is not null;
$$;


ALTER FUNCTION "public"."partner_capacity"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."partner_capacity"() IS 'How many deliveries this Partner may hold and how many they hold now. For display only — partner_accept_delivery() re-checks both, and the unique slot index is what actually enforces the limit.';


CREATE OR REPLACE FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner  uuid := auth.uid();
  v_order    public.orders%rowtype;
  v_check    text;
  v_assigned uuid;
  v_state    public.delivery_status;
begin
  select o.partner_id, o.delivery_status
    into v_assigned, v_state
    from public.orders o
   where o.id = p_order_id;

  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  -- STATE failure: the rightful Partner, at the wrong moment. Routine, so it is
  -- logged and returned rather than raised — a replayed completion is evidence,
  -- and evidence that rolls itself back is no evidence at all. Checked before
  -- the code, so a replay does not burn an attempt.
  if v_state <> 'PICKED_UP' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', v_state::text, 'DELIVERED',
      'order is not awaiting delivery completion');
    return row(false, 'this delivery is not awaiting completion')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'DELIVERY', p_delivery_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', 'PICKED_UP', 'DELIVERED', 'delivery code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask for the code again')::public.transition_result;
  end if;

  -- A Partner cannot simply declare "delivered": the customer holds the code.
  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', false, 'PARTNER',
      'delivery_status', 'PICKED_UP', 'DELIVERED', 'delivery code did not match');
    return row(false, 'delivery code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'DELIVERED', delivered_at = now(),
         order_status = 'COMPLETED', completed_at = now()
   where o.id = p_order_id and o.delivery_status = 'PICKED_UP' and o.order_status = 'READY'
  returning * into v_order;

  if not found then
    return row(false, 'order is not in a completable state')::public.transition_result;
  end if;

  -- The Partner's money is carved out of the platform allocation only now, when
  -- a real Partner has actually earned it. It becomes eligible for the next
  -- weekly settlement run.
  perform public.settle_partner_earnings(p_order_id);

  perform public.log_order_event(p_order_id, 'PARTNER_COMPLETE', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'DELIVERED');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order  public.orders%rowtype;
  v_wait   integer;
  v_result public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and partner_id = auth.uid();
  if not found then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  if v_order.customer_absent_reported_at is null then
    return row(false, 'report that the customer is not responding first')::public.transition_result;
  end if;

  select customer_absent_wait_seconds into v_wait from public.pricing_config where id;

  if now() < v_order.customer_absent_reported_at + make_interval(secs => v_wait) then
    return row(
      false,
      format('please keep waiting — you can close this %s seconds after reporting',  v_wait)
    )::public.transition_result;
  end if;

  update public.orders
     set delivery_status = 'FAILED_CUSTOMER_ABSENT', delivered_at = null
   where id = p_order_id and delivery_status = 'PICKED_UP'
  returning * into v_result;

  if not found then
    return row(false, 'this delivery is no longer in progress')::public.transition_result;
  end if;

  -- The Partner did the work: they collected the food and travelled. The
  -- earning stands, and the food question becomes an admin matter.
  perform public.settle_partner_earnings(p_order_id);

  perform public.log_order_event(p_order_id, 'DELIVERY_FAILED_CUSTOMER_ABSENT', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'FAILED_CUSTOMER_ABSENT',
    'customer did not respond within the waiting period');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner  uuid := auth.uid();
  v_assigned uuid;
  v_state    public.delivery_status;
  v_order_state public.order_status;
  v_check    text;
  v_order    public.orders%rowtype;
begin
  select o.partner_id, o.delivery_status, o.order_status
    into v_assigned, v_state, v_order_state
    from public.orders o
   where o.id = p_order_id;

  -- AUTHORISATION failure: raise. Covers the wrong Partner, an order with no
  -- Partner attached, and an order id that does not exist — all three get the
  -- same message, so probing tells the caller nothing. It comes FIRST, so an
  -- unauthorised caller never reaches the attempt counter and cannot lock a
  -- delivery out from under the Partner actually carrying it.
  if v_assigned is null or v_assigned is distinct from v_partner then
    raise exception 'this delivery is not assigned to you' using errcode = 'insufficient_privilege';
  end if;

  -- STATE before CODE. The order is not made yet, so there is nothing to
  -- collect and no attempt to spend finding that out. For a scan order READY
  -- additionally means the store has verified the scan.
  if v_order_state is distinct from 'READY' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'order is not ready yet');
    return row(false, 'this is not ready yet. Wait for the store to mark it ready')::public.transition_result;
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes, then ask the store to read it out again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'pickup code did not match');
    return row(false, 'that pickup code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'PICKED_UP',
         picked_up_at = now(),
         -- THE STORE IS FINISHED. Their board clears here, and the customer
         -- stays in tracking because order_status has not moved.
         vendor_completed_at = coalesce(o.vendor_completed_at, now())
   where o.id = p_order_id
     and o.delivery_status = 'ASSIGNED'
     and o.order_status = 'READY'
     and o.partner_id = v_partner
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', false, 'PARTNER',
      'delivery_status', v_state::text, 'PICKED_UP', 'delivery was not ASSIGNED');
    return row(false, 'this order is not awaiting pickup')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PARTNER_CONFIRM_PICKUP', true, 'PARTNER',
    'delivery_status', 'ASSIGNED', 'PICKED_UP', null,
    jsonb_build_object('vendor_completed', true));
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_delivery_history"("p_limit" integer DEFAULT 30) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_name" "text", "destination_zone" "text", "delivery_status" "public"."delivery_status", "earnings_pesewas" bigint, "delivered_at" timestamp with time zone, "paid_out" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, o.vendor_order_no, v.name, coalesce(z.name, 'Campus'),
         o.delivery_status, o.partner_earnings_pesewas, o.delivered_at,
         exists (
           select 1 from public.allocations a
            where a.order_id = o.id and a.payee_type = 'PARTNER'
              and a.payee_id = auth.uid() and a.status = 'SETTLED'
         )
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     and o.delivery_status in ('DELIVERED', 'FAILED_CUSTOMER_ABSENT')
   order by o.delivered_at desc nulls last, o.updated_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;


ALTER FUNCTION "public"."partner_delivery_history"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_earnings_summary"() RETURNS TABLE("delivered_count" bigint, "earned_pesewas" bigint, "awaiting_pesewas" bigint, "settled_pesewas" bigint, "available_pesewas" bigint, "in_progress_pesewas" bigint, "payout_threshold_pesewas" bigint, "eligible_for_payout" boolean, "pesewas_to_threshold" bigint, "rating_count" bigint, "average_stars" numeric, "last_paid_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with mine as (
    select a.status, a.amount_pesewas
      from public.allocations a
     where a.payee_type = 'PARTNER' and a.payee_id = auth.uid()
       and a.status <> 'CANCELLED'
  ),
  totals as (
    select count(*)::bigint as delivered,
           coalesce(sum(amount_pesewas), 0)::bigint as earned,
           coalesce(sum(amount_pesewas) filter (where status <> 'SETTLED'), 0)::bigint as awaiting,
           coalesce(sum(amount_pesewas) filter (where status = 'SETTLED'), 0)::bigint as settled,
           coalesce(sum(amount_pesewas) filter (where status in ('PENDING', 'ELIGIBLE')), 0)::bigint as available,
           coalesce(sum(amount_pesewas) filter (where status = 'SETTLING'), 0)::bigint as in_progress
      from mine
  )
  select t.delivered, t.earned, t.awaiting, t.settled, t.available, t.in_progress,
         public.payout_threshold_for('PARTNER'),
         t.available >= public.payout_threshold_for('PARTNER'),
         greatest(0, public.payout_threshold_for('PARTNER') - t.available),
         (select count(*) from public.partner_ratings r where r.partner_id = auth.uid()),
         (select round(avg(r.stars), 2) from public.partner_ratings r where r.partner_id = auth.uid()),
         (select max(p.paid_at) from public.payouts p
           where p.payee_type = 'PARTNER' and p.payee_id = auth.uid() and p.status = 'PAID')
    from totals t
   where auth.uid() is not null;
$$;


ALTER FUNCTION "public"."partner_earnings_summary"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1
      from public.order_scans s
      join public.orders o on o.id = s.order_id
     where s.order_id = p_order_id
       and s.released_to is not null
       and s.released_to = auth.uid()
       and o.partner_id = auth.uid()
       and o.delivery_status in ('ASSIGNED', 'PICKED_UP')
  );
$$;


ALTER FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") IS 'Whether the caller is the Partner currently carrying this scan order: released to them AND still assigned, ASSIGNED or PICKED_UP. The one predicate behind both the order_scans policy and scan_image_path(), so the row and the image can never disagree. It closes at DELIVERED, where released_to alone does not — partner_id is kept after completion for earnings and history, so an authorisation keyed on it would outlive the errand it was granted for.';


CREATE OR REPLACE FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders
   where id = p_order_id and partner_id = auth.uid();

  if not found then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;
  if v_order.delivery_status <> 'PICKED_UP' then
    return row(false, 'you can only report this once you are carrying the order')::public.transition_result;
  end if;
  if v_order.customer_absent_reported_at is not null then
    return row(true, 'already reported')::public.transition_result;
  end if;

  update public.orders set customer_absent_reported_at = now() where id = p_order_id;

  perform public.log_order_event(p_order_id, 'CUSTOMER_ABSENT_REPORTED', true, 'PARTNER',
    'delivery_status', 'PICKED_UP', 'PICKED_UP',
    'partner reports the customer is not responding');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_scan_brief"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "restaurant_name" "text", "details" "text", "scan_status" "public"."scan_status", "items" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, o.vendor_order_no, v.name, s.details, o.scan_status,
         coalesce(
           (select jsonb_agg(jsonb_build_object(
                     'name', oi.name_snapshot, 'quantity', oi.quantity) order by oi.created_at)
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb)
    from public.order_scans s
    join public.orders o on o.id = s.order_id
    join public.vendors v on v.id = o.vendor_id
   where s.order_id = p_order_id
     and s.released_to = auth.uid()
     and o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;


ALTER FUNCTION "public"."partner_scan_brief"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_set_availability"("p_available" boolean) RETURNS "public"."partner_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- THE FLAG IS ALL THIS SETS. The session is opened or closed by the trigger
  -- below, so the column and the table cannot disagree however the column is
  -- written — including by a migration, an administrator or a fixture.
  update public.partner_profiles p
     set is_available = p_available
   where p.user_id = v_user
     -- ONLY AN APPROVED PARTNER GOES ONLINE. An applicant flipping this would
     -- appear in no dispatch query — is_approved_partner() guards those too —
     -- but it would start a session and make the activity report a fiction.
     and p.status = 'APPROVED'
  returning * into v_profile;

  if not found then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  return v_profile;
end;
$$;


ALTER FUNCTION "public"."partner_set_availability"("p_available" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_row    public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if not exists (
    select 1 from public.partner_profiles
     where user_id = auth.uid() and status = 'APPROVED'
  ) then
    raise exception 'only an approved Partner has a payout destination'
      using errcode = 'insufficient_privilege';
  end if;

  if left(v_number, 4) = '+233' then
    v_number := '0' || substring(v_number from 5);
  elsif left(v_number, 3) = '233' then
    v_number := '0' || substring(v_number from 4);
  end if;

  if v_number !~ '^0[0-9]{9}$' then
    raise exception 'a Ghanaian mobile money number is required, e.g. 0551234567'
      using errcode = 'check_violation';
  end if;
  if p_momo_network not in ('MTN', 'VODAFONE', 'AIRTELTIGO') then
    raise exception 'choose MTN, VODAFONE or AIRTELTIGO' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_account_name, '')), '') is null then
    raise exception 'the name on the mobile money account is required'
      using errcode = 'check_violation';
  end if;

  insert into public.payout_destinations (
    payee_type, payee_id, momo_network, account_number, account_name
  )
  values ('PARTNER', auth.uid(), p_momo_network, v_number, btrim(p_account_name))
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         provider                 = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider end,
         provider_recipient_code  = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at       = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_synced_at end,
         provider_subaccount_code = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_subaccount_code end,
         subaccount_synced_at     = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.subaccount_synced_at end,
         subaccount_error         = null
  returning * into v_row;

  return v_row;
end;
$_$;


ALTER FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partners_to_notify_of_offer"("p_order_id" "uuid") RETURNS TABLE("user_id" "uuid", "phone" "text", "full_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_service_or_admin();

  return query
    select u.id, u.phone, u.full_name
      from public.partner_profiles pp
      join public.users u on u.id = pp.user_id
      join public.orders o on o.id = p_order_id
      join public.vendors v on v.id = o.vendor_id
      cross join public.pricing_config c
     where c.id
       and pp.status = 'APPROVED'
       and pp.is_available
       and not u.is_suspended
       and u.phone is not null
       and o.delivery_status = 'SEARCHING'
       and o.order_status in ('PREPARING', 'READY')
       and o.payment_status = 'PAID'
       -- The same two conflicts of interest, and the configured capacity limit.
       and o.customer_id <> u.id
       and v.owner_user_id is distinct from u.id
       and (
         select count(*) from public.orders a
          where a.partner_id = u.id
            and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
       ) < c.max_active_deliveries_per_partner;
end;
$$;


ALTER FUNCTION "public"."partners_to_notify_of_offer"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_url text;
begin
  perform public.assert_service_or_admin();
  select raw ->> 'authorization_url' into v_url from public.payments where id = p_payment_id;
  return v_url;
end;
$$;


ALTER FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_row public.payout_destinations%rowtype;
begin
  perform public.assert_service_or_admin();
  select * into v_row from public.payout_destinations
   where payee_type = p_payee_type and payee_id = p_payee_id;
  return v_row;
end;
$$;


ALTER FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text" DEFAULT NULL::"text") RETURNS "public"."payouts"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
  v_id     text;
begin
  perform public.assert_service_or_admin();

  if p_provider_transfer_id is not null then
    select * into v_payout from public.payouts
     where provider = p_provider and provider_transfer_id = p_provider_transfer_id;
    if found then
      return v_payout;
    end if;
  end if;

  if p_reference is not null then
    v_id := substring(p_reference from '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})');
    if v_id is not null then
      select * into v_payout from public.payouts where id = v_id::uuid;
    end if;
  end if;

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payout_recipient_contact"("p_payout_id" "uuid") RETURNS TABLE("payee_type" "public"."payee_type", "phone" "text", "display_name" "text", "amount_pesewas" bigint)
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_service_or_admin();

  return query
    select p.payee_type,
           case p.payee_type
             when 'VENDOR'  then (select coalesce(ow.phone, v.phone) from public.vendors v
                                    left join public.users ow on ow.id = v.owner_user_id
                                   where v.id = p.payee_id)
             when 'PARTNER' then (select u.phone from public.users u where u.id = p.payee_id)
           end,
           case p.payee_type
             when 'VENDOR'  then (select v.name from public.vendors v where v.id = p.payee_id)
             when 'PARTNER' then (select u.full_name from public.users u where u.id = p.payee_id)
           end,
           p.amount_pesewas
      from public.payouts p
     where p.id = p_payout_id and p.payee_type in ('VENDOR', 'PARTNER');
end;
$$;


ALTER FUNCTION "public"."payout_recipient_contact"("p_payout_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") RETURNS bigint
    LANGUAGE "sql" STABLE
    SET "search_path" TO ''
    AS $$
  select case p_payee_type
           when 'PARTNER' then coalesce(c.partner_min_payout_pesewas, 0)
           else coalesce(c.min_payout_pesewas, 0)
         end
    from public.pricing_config c where c.id;
$$;


ALTER FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") IS 'The minimum a payee must be owed before a run will pay them. Partners have their own weekly floor; everybody else uses the general one.';


CREATE OR REPLACE FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  -- Owns a store, in any state. A rejected or pending applicant still has to
  -- get in to read why, so this is "has a store" rather than "has a live one".
  select exists (
    select 1
      from public.vendors v
      join public.users u on u.id = v.owner_user_id
     where u.phone = p_phone
  );
$$;


ALTER FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") IS 'Whether this number belongs to an account that owns a store. Called before a vendor sign-in code is sent, so /login/vendor cannot be used to send an SMS to an arbitrary number or to provision an identity for somebody with no store. Returns a boolean and nothing else — no name, no store, no account id.';


CREATE OR REPLACE FUNCTION "public"."platform_config"() RETURNS "public"."pricing_config"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select * from public.pricing_config where id;
$$;


ALTER FUNCTION "public"."platform_config"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_items" "jsonb") RETURNS TABLE("subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "total_pesewas" bigint, "lines" "jsonb")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  -- A CLOSED store takes no new orders. Existing ones are untouched: this
  -- guards submission, not the lifecycle of work already in the kitchen.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_menu.price_pesewas,
      'quantity',           v_qty,
      'line_total_pesewas', v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. UNCHANGED, and
  -- deliberately restated rather than refactored away: this expression is the
  -- platform's entire revenue model and it should be readable in one place.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;

  return query select v_subtotal, v_service, v_subtotal + v_service, v_lines;
end;
$$;


ALTER FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."price_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_wants_pack" boolean DEFAULT false) RETURNS TABLE("scanned_value_pesewas" bigint, "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "pack_fee_pesewas" bigint, "partner_earnings_pesewas" bigint, "total_pesewas" bigint, "destination_zone_id" "uuid", "lines" "jsonb")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_scanned  bigint := 0;
  v_service  bigint;
  v_delivery bigint := 0;
  v_pack     bigint := 0;
  v_earnings bigint := 0;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id
       and status = 'ACTIVE'
       and is_accepting_orders
       and can_accept_scans
  ) then
    raise exception 'this store is not accepting meal scans right now'
      using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'choose at least one item' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  -- The refusal that keeps an unpriced product off the shelf: null is
  -- "undecided", and guessing here would be inventing revenue policy in a
  -- pricing function.
  if v_cfg.scan_service_fee_pesewas is null then
    raise exception
      'meal scans are not configured yet: an administrator must set the scan service fee'
      using errcode = 'check_violation';
  end if;

  -- SCAN ELIGIBILITY IS CHECKED HERE, per item, against the live menu. A screen
  -- that only offered eligible items is a convenience; this is the enforcement.
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available
       and scan_eligible;

    if not found then
      raise exception 'that item cannot be paid for with a meal scan'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id',       v_menu.id,
      'name',               v_menu.name,
      'unit_price_pesewas', v_menu.price_pesewas,
      'quantity',           v_qty,
      'line_total_pesewas', v_menu.price_pesewas * v_qty
    );

    v_scanned := v_scanned + (v_menu.price_pesewas * v_qty);
  end loop;

  -- FLAT, ALWAYS, AND NEVER A SHARE OF THE SCANNED VALUE. The scanned value is
  -- the store's price for food Campus Dash did not sell; a percentage of it
  -- would be a commission on somebody else's transaction.
  v_service := v_cfg.scan_service_fee_pesewas;

  if p_fulfilment_type = 'DELIVERY' then
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'no Partners are available right now'
        using errcode = 'check_violation';
    end if;

    if p_destination_location_id is null then
      raise exception 'choose where the Partner should bring it'
        using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'that is not a place a Partner can bring an order to'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Same carve as a food order. The Partner is paid for the errand, and the
    -- errand is identical work whether the food was bought or scanned.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;

    -- THE PACK COMES WITH THE PARTNER, and p_wants_pack is not consulted. A
    -- Partner cannot carry a meal without something to carry it in, so the
    -- screen never offers the choice — and a request that reached here without
    -- passing the screen is overridden rather than honoured.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  elsif coalesce(p_wants_pack, false) then
    -- A COLLECTION MAY BRING ITS OWN CONTAINER. Charging GH4 for a pack
    -- somebody refused is charging for nothing.
    v_pack := coalesce(v_cfg.scan_pack_fee_pesewas, 0);
  end if;

  return query select
    v_scanned,
    -- WHAT CAMPUS DASH SOLD, which is no food at all. This is the number the
    -- ledger divides on, and it must stay zero or a store would appear to be
    -- owed money for a meal the university already paid for.
    0::bigint,
    v_service,
    v_delivery,
    v_pack,
    v_earnings,
    v_service + v_delivery + v_pack,
    case when p_fulfilment_type = 'DELIVERY'
         then public.location_zone(p_destination_location_id) end,
    v_lines;
end;
$$;


ALTER FUNCTION "public"."price_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."price_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) IS 'Prices a meal-scan order. The food is GH0 through Campus Dash — the scan pays the store — and the service fee is FLAT (scan_service_fee_pesewas), never a share of the scanned value: that value is the store''s price for food we did not sell. The pack is the customer''s choice on a collection and compulsory with a Partner, who cannot carry a meal without one.';


CREATE OR REPLACE FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type" DEFAULT NULL::"public"."fulfilment_type") RETURNS TABLE("subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "total_pesewas" bigint, "delivery_available" boolean, "lines" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.subtotal_pesewas,
         p.service_fee_pesewas,
         case when p_fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         p.total_pesewas
           + case when p_fulfilment_type = 'DELIVERY' then c.delivery_fee_pesewas else 0 end,
         coalesce(c.partner_delivery_enabled, true),
         p.lines
    from public.price_order(p_vendor_id, p_items) p
    cross join public.pricing_config c
   where c.id;
$$;


ALTER FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."quote_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type" DEFAULT 'PICKUP'::"public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_wants_pack" boolean DEFAULT false) RETURNS TABLE("scanned_value_pesewas" bigint, "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "pack_fee_pesewas" bigint, "total_pesewas" bigint, "partner_available" boolean, "pack_is_compulsory" boolean, "lines" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.scanned_value_pesewas, p.subtotal_pesewas, p.service_fee_pesewas,
         p.delivery_fee_pesewas, p.pack_fee_pesewas, p.total_pesewas,
         coalesce(c.partner_delivery_enabled, true),
         -- SO THE SCREEN DOES NOT HAVE TO KNOW THE RULE. A checkout that
         -- decided for itself when to hide the pack toggle would be a second
         -- copy of this policy, and the two would drift.
         (p_fulfilment_type = 'DELIVERY'),
         p.lines
    from public.price_scan_order(
           p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id, p_wants_pack) p
    cross join public.pricing_config c
   where c.id;
$$;


ALTER FUNCTION "public"."quote_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text" DEFAULT NULL::"text", "p_provider_message_id" "text" DEFAULT NULL::"text", "p_error" "text" DEFAULT NULL::"text", "p_order_id" "uuid" DEFAULT NULL::"uuid", "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_dedupe_key" "text" DEFAULT NULL::"text", "p_correlation_id" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_id bigint;
begin
  perform public.assert_service_or_admin();

  insert into public.notification_events (
    event, audience, channel, user_id, order_id, recipient,
    succeeded, provider, provider_message_id, error, dedupe_key, correlation_id
  )
  values (
    p_event, p_audience, coalesce(p_channel, 'SMS'), p_user_id, p_order_id, p_recipient,
    p_succeeded, p_provider, p_provider_message_id, p_error, p_dedupe_key, p_correlation_id
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;  -- null when it was a duplicate
end;
$$;


ALTER FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text", "p_provider_message_id" "text", "p_error" "text", "p_order_id" "uuid", "p_user_id" "uuid", "p_dedupe_key" "text", "p_correlation_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text" DEFAULT NULL::"text") RETURNS TABLE("matched" boolean, "notification_id" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_id bigint;
begin
  perform public.assert_service_or_admin();

  if p_correlation_id is null or p_status is null then
    return query select false, null::bigint;
    return;
  end if;

  -- Matched on the correlation reference ALONE. It is a UUID we generated and
  -- handed to exactly one provider, so it identifies the message on its own;
  -- and the caller has already proved which provider it is by signature.
  --
  -- It deliberately does NOT also filter on provider name. That looked like a
  -- sensible extra guard and was a bug: a message sent through one provider and
  -- reported while another is configured — which is every development run,
  -- where sends go through the fake provider — silently matched nothing and
  -- reported success.
  update public.notification_events
     set delivery_status     = p_status,
         delivery_updated_at = now(),
         -- Write-once, and the EXISTING value wins. The append-only guard
         -- refuses to let a recorded provider id be changed to a different one,
         -- so the coalesce has to agree with it: a report fills this in when
         -- the send did not record one (Arkesel v1 returns no id), and leaves
         -- it alone when the send did. Written the other way round, every
         -- report for a message that already had an id raised and came back a
         -- 500 — which is exactly how this was found.
         provider_message_id = coalesce(provider_message_id, p_provider_message_id)
   where correlation_id = p_correlation_id
  returning id into v_id;

  return query select v_id is not null, v_id;
end;
$$;


ALTER FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) RETURNS TABLE("webhook_id" "uuid", "is_new" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_id     uuid;
  v_is_new boolean;
begin
  perform public.assert_service_or_admin();

  insert into public.webhook_events (provider, event_id, payload, signature_valid, status)
  values (p_provider, p_event_id, p_payload, p_signature_valid,
          case when p_signature_valid
               then 'RECEIVED'::public.webhook_event_status
               else 'INVALID_SIGNATURE'::public.webhook_event_status end)
  on conflict (provider, event_id) do nothing
  returning id into v_id;

  v_is_new := v_id is not null;

  if not v_is_new then
    select id into v_id from public.webhook_events
     where provider = p_provider and event_id = p_event_id;
  end if;

  return query select v_id, v_is_new;
end;
$$;


ALTER FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."release_scan_on_assignment"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.order_type <> 'SCAN' then
    return new;
  end if;

  -- Assigned to somebody: that somebody, and nobody else, may read it.
  if new.partner_id is not null
     and new.delivery_status in ('ASSIGNED', 'PICKED_UP')
     and new.partner_id is distinct from old.partner_id then
    update public.order_scans
       set released_to = new.partner_id,
           released_at = now()
     where order_id = new.id;

    if new.scan_status = 'UPLOADED' then
      new.scan_status := 'RELEASED';
    end if;

  -- The assignment went away — cancelled, reassigned, search reopened. The
  -- read right goes with it. A redeemed scan keeps its history; what is
  -- revoked is the ability to fetch the image.
  elsif new.partner_id is null and old.partner_id is not null then
    update public.order_scans
       set released_to = null,
           released_at = null
     where order_id = new.id;

    if new.scan_status = 'RELEASED' then
      new.scan_status := 'UPLOADED';
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."release_scan_on_assignment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."retry_payout"("p_payout_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
  v_run    public.settlement_runs%rowtype;
  v_sum    bigint;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    return (false, 'payout not found')::public.transition_result;
  end if;
  if v_payout.status = 'PAID' then
    return (false, 'this payout is already paid')::public.transition_result;
  end if;
  -- A reversal is not retried here. The allocations went back into the pool, so
  -- the money is settled again by the NEXT run, under a new payout — never by
  -- re-sending a transfer that already completed once.
  if v_payout.status = 'REVERSED' then
    return (false,
      'this payout was reversed; the money is owed again and the next run will settle it')
      ::public.transition_result;
  end if;
  if v_payout.status <> 'FAILED' then
    return (false, 'only a failed payout is retried')::public.transition_result;
  end if;

  select * into v_run from public.settlement_runs where id = v_payout.settlement_run_id;

  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = v_payout.payee_type
     and a.payee_id   = v_payout.payee_id
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at < v_run.period_end;

  select coalesce(sum(amount_pesewas), 0) into v_sum
    from public.allocations
   where settlement_run_id = v_run.id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id;

  if v_sum <> v_payout.amount_pesewas then
    -- Put back whatever we just took, so a refused retry changes nothing.
    update public.allocations
       set settlement_run_id = null, status = 'ELIGIBLE'
     where settlement_run_id = v_run.id
       and payee_type = v_payout.payee_type
       and payee_id   = v_payout.payee_id
       and status = 'SETTLING';
    return (false,
      'the allocations behind this payout have moved to another run; settle it there')
      ::public.transition_result;
  end if;

  update public.payouts
     set status = 'PENDING', failure_reason = null,
         provider_transfer_id = null,
         -- The next attempt therefore builds a DIFFERENT provider reference.
         transfer_attempt = transfer_attempt + 1
   where id = p_payout_id and status = 'FAILED';

  return (true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."retry_payout"("p_payout_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."payouts"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payout public.payouts%rowtype;
begin
  perform public.assert_service_or_admin();

  select * into v_payout from public.payouts where id = p_payout_id;
  if not found then
    raise exception 'payout not found' using errcode = 'no_data_found';
  end if;

  -- Idempotent: a provider that sends the reversal five times reverses once.
  if v_payout.status = 'REVERSED' then
    return v_payout;
  end if;

  -- A reversal that arrives for a payout which never reached PAID is simply a
  -- failure, and is recorded as one. Nothing was settled, so there is nothing
  -- to unwind beyond releasing the claim.
  if v_payout.status in ('PENDING', 'PROCESSING') then
    return public.fail_payout(p_payout_id, coalesce(p_reason, 'provider reported REVERSED'));
  end if;

  if v_payout.status <> 'PAID' then
    return v_payout;  -- FAILED or CANCELLED: already not owed to anybody
  end if;

  update public.payouts
     set status = 'REVERSED',
         failure_reason = coalesce(p_reason, 'provider reversed this transfer'),
         paid_at = null
   where id = p_payout_id and status = 'PAID'
  returning * into v_payout;

  if not found then
    raise exception 'payout was not reversible' using errcode = 'check_violation';
  end if;

  -- The liability comes back. These were SETTLED by mark_payout_paid; they are
  -- owed again, so they return to the pool for the next run.
  update public.allocations
     set status = 'ELIGIBLE', settlement_run_id = null, settled_at = null
   where settlement_run_id = v_payout.settlement_run_id
     and payee_type = v_payout.payee_type
     and payee_id   = v_payout.payee_id
     and status = 'SETTLED';

  return v_payout;
end;
$$;


ALTER FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."scan_image_path"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and (
       s.customer_id = auth.uid()
       or public.partner_may_read_scan(p_order_id)
       or public.is_admin()
     );
$$;


ALTER FUNCTION "public"."scan_image_path"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."scan_image_path"("p_order_id" "uuid") IS 'The scan image path for the customer who uploaded it, the Partner CURRENTLY carrying it, or an administrator. The store has its own door, vendor_scan_image_path(). Every window here closes: the Partner''s at the end of the delivery, not merely when the assignment is taken away.';


CREATE OR REPLACE FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") RETURNS TABLE("id" "uuid", "name" "text", "description" "text", "price_pesewas" bigint, "is_available" boolean, "image_path" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select m.id, m.name, m.description, m.price_pesewas, m.is_available, m.image_path
    from public.menu_items m
    join public.vendors v on v.id = m.vendor_id
   where m.vendor_id = p_vendor_id
     and m.scan_eligible
     and v.status = 'ACTIVE'
     and v.can_accept_scans
   order by m.sort_order, m.name;
$$;


ALTER FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."scan_restaurants"() RETURNS TABLE("id" "uuid", "name" "text", "location_path" "text", "is_accepting_orders" boolean, "image_path" "text", "eligible_item_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id, v.name, public.location_path(v.location_id), v.is_accepting_orders,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.menu_items m
           where m.vendor_id = v.id and m.scan_eligible and m.is_available)
    from public.vendors v
   where v.status = 'ACTIVE'
     and v.can_accept_scans
     and exists (
       select 1 from public.menu_items m
        where m.vendor_id = v.id and m.scan_eligible and m.is_available
     )
   order by v.is_accepting_orders desc, v.name;
$$;


ALTER FUNCTION "public"."scan_restaurants"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_my_email"("p_email" "text") RETURNS "public"."users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_user  public.users%rowtype;
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if v_email = '' then
    raise exception 'an email address is required' using errcode = 'check_violation';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address does not look like an address'
      using errcode = 'check_violation';
  end if;

  update public.users set email = v_email where id = auth.uid()
  returning * into v_user;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  return v_user;
end;
$_$;


ALTER FUNCTION "public"."set_my_email"("p_email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order    public.orders%rowtype;
  v_earnings bigint;
begin
  select * into v_order from public.orders where id = p_order_id;

  if v_order.partner_id is null or v_order.partner_earnings_pesewas = 0 then
    return 0;
  end if;

  -- Idempotent: a Partner allocation already exists for this order.
  if exists (
    select 1 from public.allocations where order_id = p_order_id and payee_type = 'PARTNER'
  ) then
    return 0;
  end if;

  v_earnings := v_order.partner_earnings_pesewas;

  update public.allocations
     set amount_pesewas = amount_pesewas - v_earnings
   where order_id = p_order_id and payee_type = 'PLATFORM';

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status, settlement_channel)
  values (p_order_id, 'PARTNER', v_order.partner_id, v_earnings, 'ELIGIBLE', 'TRANSFER');

  return 1;
end;
$$;


ALTER FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") RETURNS TABLE("vendor_id" "uuid", "name" "text", "description" "text", "category_id" "uuid", "category_name" "text", "category_slug" "text", "location_path" "text", "location_note" "text", "walk_minutes_to_campus" integer, "is_accepting_orders" boolean, "can_accept_scans" boolean, "images" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.location_note, v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', i.id, 'storage_path', i.storage_path, 'caption', i.caption
                   ) order by i.sort_order, i.created_at)
                     from (select * from public.vendor_images i2
                            where i2.vendor_id = v.id
                            order by i2.sort_order, i2.created_at
                            limit 4) i), '[]'::jsonb)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.id = p_vendor_id and v.status = 'ACTIVE';
$$;


ALTER FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."storefront_vendors"("p_category_id" "uuid" DEFAULT NULL::"uuid", "p_search" "text" DEFAULT NULL::"text") RETURNS TABLE("vendor_id" "uuid", "name" "text", "description" "text", "category_id" "uuid", "category_name" "text", "category_slug" "text", "location_path" "text", "walk_minutes_to_campus" integer, "is_accepting_orders" boolean, "can_accept_scans" boolean, "image_path" "text", "image_count" bigint, "menu_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select v.id, v.name, v.description,
         v.category_id, k.name, k.slug,
         public.location_path(v.location_id), v.walk_minutes_to_campus,
         v.is_accepting_orders, v.can_accept_scans,
         (select i.storage_path from public.vendor_images i
           where i.vendor_id = v.id order by i.sort_order, i.created_at limit 1),
         (select count(*) from public.vendor_images i where i.vendor_id = v.id),
         (select count(*) from public.menu_items m where m.vendor_id = v.id and m.is_available)
    from public.vendors v
    left join public.vendor_categories k on k.id = v.category_id
   where v.status = 'ACTIVE'
     and (p_category_id is null or v.category_id = p_category_id)
     and (p_search is null or btrim(p_search) = ''
          or v.name ilike '%' || btrim(p_search) || '%'
          or coalesce(v.description,'') ilike '%' || btrim(p_search) || '%')
   -- Open stalls first. A CLOSED one still appears, with its menu, because
   -- "they are closed right now" is information a customer wants; a stall that
   -- vanishes at 9pm reads as one that has left the platform.
   order by v.is_accepting_orders desc, v.name;
$$;


ALTER FUNCTION "public"."storefront_vendors"("p_category_id" "uuid", "p_search" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(
      auth.uid(), p_vendor_id, p_items,
      p_fulfilment_type, p_destination_location_id, p_destination_note);
end;
$$;


ALTER FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_no       integer;
  v_day      date := (now() at time zone 'UTC')::date;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_total    bigint;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  if not public.is_customer(p_customer_id) then
    raise exception 'this account has not completed customer sign-up'
      using errcode = 'insufficient_privilege';
  end if;

  -- A CLOSED store takes no new orders. Orders already in the kitchen are
  -- untouched by closing: this guards submission and nothing else.
  if not exists (
    select 1 from public.vendors
     where id = p_vendor_id and status = 'ACTIVE' and is_accepting_orders
  ) then
    raise exception 'vendor is not accepting orders' using errcode = 'check_violation';
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    raise exception 'order must contain at least one item' using errcode = 'check_violation';
  end if;

  if p_fulfilment_type is null then
    raise exception 'choose pickup or delivery' using errcode = 'check_violation';
  end if;

  select * into v_cfg from public.pricing_config where id;

  if p_fulfilment_type = 'DELIVERY' then
    -- THE GLOBAL SWITCH, checked at submission and nowhere else that matters.
    -- Turning Partner delivery off stops NEW delivery orders. It does not
    -- reach an order somebody has already paid for, and must not.
    if not coalesce(v_cfg.partner_delivery_enabled, true) then
      raise exception 'partner delivery is unavailable right now; choose pickup'
        using errcode = 'check_violation';
    end if;
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location'
        using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  v_no := public.next_vendor_order_no(p_vendor_id, v_day);

  -- ONE ORDER, ONE VENDOR. Enforced by the column: there is no basket spanning
  -- two kitchens and no way to express one.
  --
  -- ACCEPTED at birth. The state name is inherited and now means "priced and
  -- payable" — there is nobody left to accept anything. accept_deadline_at is
  -- reused as the PAY-BY deadline, so an order nobody pays for is swept rather
  -- than sitting in the customer's list for ever.
  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accepted_at, accept_deadline_at,
    order_day, vendor_order_no
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'ACCEPTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    case when p_fulfilment_type = 'DELIVERY'
         then nullif(btrim(coalesce(p_destination_note, '')), '') end,
    v_zone,
    0, 0, v_delivery, v_earnings, v_delivery,
    'NONE', now(), now(),
    now() + make_interval(secs => v_cfg.payment_pending_timeout_seconds),
    v_day, v_no
  )
  returning id, orders.order_number into v_order_id, v_number;

  -- --- PRICE SNAPSHOT ------------------------------------------------------
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'quantity')::integer;
    if v_qty is null or v_qty < 1 then
      raise exception 'invalid quantity' using errcode = 'check_violation';
    end if;

    select * into v_menu
      from public.menu_items
     where id = (v_item ->> 'menu_item_id')::uuid
       and vendor_id = p_vendor_id
       and is_available;

    if not found then
      raise exception 'menu item % is unavailable', v_item ->> 'menu_item_id'
        using errcode = 'check_violation';
    end if;

    if v_menu.id = any(v_seen) then
      raise exception 'item % appears more than once; send a single line with a quantity', v_menu.name
        using errcode = 'check_violation';
    end if;
    v_seen := v_seen || v_menu.id;

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- 5% of the food, rounded half-up, in whole pesewas. The delivery fee is not
  -- in the base: the service fee is a share of what the food costs.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'ACCEPTED',
    null, jsonb_build_object(
      'total_pesewas', v_total,
      'item_count', jsonb_array_length(p_items),
      'fulfilment_type', p_fulfilment_type::text,
      'vendor_order_no', v_no)
  );

  return query select v_order_id, v_number, v_no, v_total;
end;
$$;


ALTER FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_details" "text" DEFAULT NULL::"text", "p_destination_note" "text" DEFAULT NULL::"text", "p_wants_pack" boolean DEFAULT false) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_customer uuid := auth.uid();
  v_price    record;
  v_order    public.orders%rowtype;
  v_prefix   text;
  v_details  text := nullif(btrim(coalesce(p_details, '')), '');
  v_day      date := (now() at time zone 'UTC')::date;
  v_no       integer;
  v_line     jsonb;
  v_cfg      public.pricing_config%rowtype;
begin
  if v_customer is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- ORDERING IS A CAPABILITY. Browsing needs no account; this needs completed
  -- student onboarding, exactly like a food order.
  if not public.is_customer(v_customer) then
    raise exception 'complete your student details before ordering'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_scan_image_path, '')), '') is null then
    raise exception 'attach your meal scan' using errcode = 'check_violation';
  end if;

  -- THE DETAILS FIELD IS OPTIONAL NOW, and that is a consequence of the items
  -- being real. It used to be the only way anybody knew what to hand over, so
  -- it had to be compulsory; the order itself says that now, and what is left
  -- is genuinely optional context — "no pepper", "the back counter".
  if v_details is not null and length(v_details) > 1000 then
    raise exception 'keep the details under 1000 characters' using errcode = 'check_violation';
  end if;

  -- THE PATH MUST BE THE CALLER'S OWN. Uploads land under <user_id>/scans/…,
  -- so anything else is either a mistake or an attempt to attach a scan the
  -- caller does not own. Checked here as well as at upload, because this
  -- function is the one that grants a later right to read it.
  v_prefix := v_customer::text || '/scans/';
  if left(p_scan_image_path, length(v_prefix)) <> v_prefix then
    raise exception 'that scan does not belong to this account'
      using errcode = 'insufficient_privilege';
  end if;

  -- Prices come from the server, always. Nothing the client sent is trusted:
  -- the pack choice is a REQUEST that price_scan_order() may override, and
  -- every figure below is read back off its answer rather than off the request.
  select * into v_price
    from public.price_scan_order(
      p_vendor_id, p_items, p_fulfilment_type, p_destination_location_id, p_wants_pack);

  select * into v_cfg from public.pricing_config where id;

  -- A QUEUE NUMBER, like every other order. The store calls this out; nobody is
  -- ever asked to read a CD- reference down a counter.
  v_no := public.next_vendor_order_no(p_vendor_id, v_day);

  insert into public.orders (
    customer_id, vendor_id, order_type, fulfilment_type,
    order_status, payment_status, delivery_status, scan_status,
    vendor_order_no, order_day,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, pack_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    submitted_at, accepted_at, accept_deadline_at
  )
  values (
    v_customer, p_vendor_id, 'SCAN', p_fulfilment_type,
    -- ACCEPTED means "priced and payable", exactly as it does for food. No
    -- store sees it until the money lands.
    'ACCEPTED', 'UNPAID', 'NONE', 'UPLOADED',
    v_no, v_day,
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    nullif(btrim(coalesce(p_destination_note, '')), ''),
    v_price.destination_zone_id,
    0, v_price.service_fee_pesewas, v_price.delivery_fee_pesewas, v_price.pack_fee_pesewas,
    v_price.partner_earnings_pesewas, v_price.total_pesewas,
    -- accept_deadline_at is the PAY-BY deadline, exactly as it is on a food
    -- order, so a scan nobody pays for is swept by expire_stale_orders()
    -- rather than sitting in somebody's list for ever holding a queue number.
    now(), now(), now() + make_interval(secs => v_cfg.payment_pending_timeout_seconds)
  )
  returning * into v_order;

  -- THE ITEMS. Priced at the menu price so the counter can see what was asked
  -- for and what it is normally worth; the customer is charged none of it,
  -- which is why orders.subtotal_pesewas above is zero and not this sum.
  for v_line in select * from jsonb_array_elements(v_price.lines) loop
    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    ) values (
      v_order.id,
      (v_line ->> 'menu_item_id')::uuid,
      v_line ->> 'name',
      (v_line ->> 'unit_price_pesewas')::bigint,
      (v_line ->> 'quantity')::integer,
      (v_line ->> 'line_total_pesewas')::bigint
    );
  end loop;

  insert into public.order_scans (order_id, customer_id, image_path, content_type, byte_size, details)
  values (v_order.id, v_customer, p_scan_image_path, p_content_type, p_byte_size, v_details);

  -- Same secrets row a food order gets: vendor_mark_ready() mints the collection
  -- code into it, and partner_accept_delivery() fills in the delivery code.
  insert into public.order_secrets (order_id) values (v_order.id);

  perform public.log_order_event(
    v_order.id, 'SCAN_ORDER_SUBMITTED', true, 'CUSTOMER',
    'order_status', null, 'ACCEPTED', null,
    jsonb_build_object('vendor_id', p_vendor_id,
                       'scan_status', 'UPLOADED',
                       'fulfilment_type', p_fulfilment_type::text,
                       'scanned_value_pesewas', v_price.scanned_value_pesewas,
                       'pack_fee_pesewas', v_price.pack_fee_pesewas,
                       'vendor_order_no', v_no)
  );

  return query select v_order.id, v_order.order_number, v_order.vendor_order_no, v_order.total_pesewas;
end;
$$;


ALTER FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid", "p_details" "text", "p_destination_note" "text", "p_wants_pack" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_my_verified_phone"() RETURNS "public"."users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user  public.users%rowtype;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select nullif(u.phone, '') into v_phone
    from auth.users u
   where u.id = auth.uid() and u.phone_confirmed_at is not null;

  if v_phone is null then
    raise exception 'verify the phone number first' using errcode = 'check_violation';
  end if;

  -- GoTrue stores numbers without the leading '+'. The profile wants E.164.
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  if exists (select 1 from public.users where phone = v_phone and id <> auth.uid()) then
    raise exception 'that phone number is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end if;

  update public.users set phone = v_phone where id = auth.uid()
  returning * into v_user;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  return v_user;
end;
$$;


ALTER FUNCTION "public"."sync_my_verified_phone"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sync_my_verified_phone"() IS 'Copies the caller''s VERIFIED auth phone onto their profile. Takes no parameter: the number is read from auth.users, where GoTrue wrote it after checking the code. Used when a customer opens a store, so the number a Partner rings and the number the vendor signs in with are one number on one identity.';


CREATE OR REPLACE FUNCTION "public"."update_my_profile"("p_first_name" "text", "p_last_name" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_affiliation" "public"."campus_affiliation" DEFAULT NULL::"public"."campus_affiliation", "p_graduation_year" integer DEFAULT NULL::integer, "p_gender" "public"."customer_gender" DEFAULT NULL::"public"."customer_gender") RETURNS "public"."users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_user  public.users%rowtype;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_is_credential boolean;
  v_target public.campus_affiliation;
  v_profile public.customer_profiles%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_first_name, '')), '') is null then
    raise exception 'your first name is required' using errcode = 'check_violation';
  end if;

  -- A YEAR THAT IS BEING CHANGED IS CHECKED AGAINST THE OFFERED LIST. Null
  -- still means "leave it", so an account carrying an older year keeps it until
  -- somebody actually answers the question again.
  if p_graduation_year is not null and p_graduation_year not in (2027, 2028, 2029, 2030) then
    raise exception 'choose one of the graduation years offered'
      using errcode = 'check_violation';
  end if;

  -- WHOSE NUMBER IS A CREDENTIAL. A vendor signs in with theirs, so a settings
  -- form must not be able to move it — that would be an account takeover with
  -- a text input. A customer's number is a profile fact and is theirs to
  -- change. An administrator has no number at all and is not given one here.
  select exists (
    select 1 from public.vendors v where v.owner_user_id = auth.uid()
  ) or exists (
    select 1 from public.users u where u.id = auth.uid() and u.is_admin
  ) into v_is_credential;

  if v_phone is not null then
    if v_is_credential then
      raise exception 'your phone number is how you sign in; contact Campus Dash to change it'
        using errcode = 'insufficient_privilege';
    end if;
    if v_phone !~ '^\+[1-9]\d{7,14}$' then
      raise exception 'enter a valid phone number, e.g. 020 123 4567'
        using errcode = 'check_violation';
    end if;
  end if;

  begin
    update public.users
       set first_name = btrim(p_first_name),
           last_name  = nullif(btrim(coalesce(p_last_name, '')), ''),
           -- NULL means "leave it": clearing a number a Partner rings on
           -- arrival is not something a name form should be able to do.
           phone      = coalesce(v_phone, phone)
     where id = auth.uid()
    returning * into v_user;
  exception when unique_violation then
    raise exception 'that phone number is already used by another Campus Dash account'
      using errcode = 'unique_violation';
  end;

  if not found then
    raise exception 'no profile for this account' using errcode = 'no_data_found';
  end if;

  -- THE CUSTOMER FACTS, and only for somebody who has them. An administrator
  -- or a vendor-only account holds no customer_profiles row, and editing their
  -- name must not invent one — that would grant the CUSTOMER capability from a
  -- settings form.
  select * into v_profile from public.customer_profiles where user_id = auth.uid();

  if found and (p_affiliation is not null or p_graduation_year is not null
                or p_gender is not null) then
    v_target := coalesce(p_affiliation, v_profile.affiliation);

    if v_target = 'STUDENT'
       and coalesce(p_graduation_year, v_profile.graduation_year) is null then
      raise exception 'tell us the year you expect to graduate'
        using errcode = 'check_violation';
    end if;

    update public.customer_profiles
       set affiliation = v_target,
           graduation_year = case
             when v_target = 'STAFF' then null
             else coalesce(p_graduation_year, graduation_year) end,
           gender = coalesce(p_gender, gender)
     where user_id = auth.uid();
  end if;

  return v_user;
end;
$_$;


ALTER FUNCTION "public"."update_my_profile"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."users_sync_full_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.first_name := nullif(btrim(coalesce(new.first_name, '')), '');
  new.last_name  := nullif(btrim(coalesce(new.last_name,  '')), '');

  -- The parts win when either is present. When neither is, full_name is left
  -- exactly as the caller set it: an account created before this migration and
  -- never edited keeps the name it has.
  if new.first_name is not null or new.last_name is not null then
    new.full_name := nullif(btrim(concat_ws(' ', new.first_name, new.last_name)), '');
  else
    new.full_name := nullif(btrim(coalesce(new.full_name, '')), '');
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."users_sync_full_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  -- CONDITIONAL UPDATE: only SUBMITTED may become ACCEPTED, and only before the
  -- deadline. A vendor cannot accept a READY order, or one already expired.
  update public.orders
     set order_status = 'ACCEPTED', accepted_at = now()
   where id = p_order_id
     and order_status = 'SUBMITTED'
     and accept_deadline_at > now()
  returning * into v_order;

  if not found then
    -- Re-read. v_prev was captured BEFORE the update, so after losing a race it
    -- describes the world as it was, not as it is — and "cannot be accepted
    -- from state SUBMITTED" is nonsense to the colleague who was a second slow.
    select order_status into v_prev from public.orders where id = p_order_id;

    -- Nothing to attach a log entry to, and order_events has a foreign key to
    -- orders — so bail out before logging rather than after.
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;

    perform public.log_order_event(p_order_id, 'VENDOR_ACCEPT', false, 'VENDOR',
      'order_status', v_prev::text, 'ACCEPTED', 'order was not SUBMITTED within its window');

    if v_prev = 'SUBMITTED' then
      -- Still SUBMITTED but the update matched nothing: the answer window has
      -- closed and the sweep has not caught up yet.
      return row(false, 'the 60-second answer window has closed')::public.transition_result;
    elsif v_prev = 'ACCEPTED' then
      return row(false, 'someone else already accepted this order')::public.transition_result;
    else
      return row(false, format('order cannot be accepted from state %s', v_prev))::public.transition_result;
    end if;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_ACCEPT', true, 'VENDOR',
    'order_status', 'SUBMITTED', 'ACCEPTED');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.payment_status = 'PAID'
     and o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
     and public.is_vendor_staff(p_vendor_id);
$$;


ALTER FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") IS 'Orders still on this vendor''s board: paid and ACCEPTED, PREPARING or READY. Unlike vendor_pending_count() this includes READY, so the board can tell when a handoff has taken an order off it. Staff-only, enforced by is_vendor_staff() in the body.';


CREATE TABLE IF NOT EXISTS "public"."vendor_images" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vendor_id" "uuid" NOT NULL,
    "storage_path" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "byte_size" bigint NOT NULL,
    "caption" "text",
    "sort_order" integer DEFAULT 0 NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendor_images_byte_size_check" CHECK (("byte_size" > 0)),
    CONSTRAINT "vendor_images_path_shape" CHECK (("btrim"("storage_path") <> ''::"text"))
);


ALTER TABLE "public"."vendor_images" OWNER TO "postgres";


COMMENT ON TABLE "public"."vendor_images" IS 'A vendor''s storefront gallery. The objects live in the PUBLIC vendor-images bucket, because an unauthenticated visitor browsing the marketplace has to be able to see them and a signed URL per photo per page load is a cost with no matching secret. Nothing private is ever put here; the bucket takes no client writes, so what appears in it went through a server that checked who was asking.';


CREATE OR REPLACE FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text" DEFAULT NULL::"text") RETURNS "public"."vendor_images"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_image public.vendor_images%rowtype;
  v_count integer;
  v_next  integer;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;
  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'no image was received' using errcode = 'check_violation';
  end if;

  -- Serialised per store, so two uploads racing each other cannot both see
  -- three photos and leave five.
  perform 1 from public.vendors where id = p_vendor_id for update;

  select count(*), coalesce(max(sort_order) + 1, 0)
    into v_count, v_next
    from public.vendor_images where vendor_id = p_vendor_id;

  if v_count >= 4 then
    raise exception 'a store may have at most 4 photos; remove one first'
      using errcode = 'check_violation';
  end if;

  insert into public.vendor_images (
    vendor_id, storage_path, content_type, byte_size, caption, sort_order, uploaded_by
  )
  values (
    p_vendor_id, btrim(p_storage_path), p_content_type, p_byte_size,
    nullif(btrim(coalesce(p_caption, '')), ''), v_next, auth.uid()
  )
  returning * into v_image;

  return v_image;
end;
$$;


ALTER FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text") IS 'Records one store photo, at the END of the order, so the first photo a store uploads is its primary one. At most four per store, checked under a lock on the store row. Owner or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_clear_menu_item_image"("p_menu_item_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item     public.menu_items%rowtype;
  v_previous text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    return null;
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  v_previous := v_item.image_path;

  update public.menu_items
     set image_path = null, image_content_type = null, image_byte_size = null, updated_at = now()
   where id = p_menu_item_id;

  return v_previous;
end;
$$;


ALTER FUNCTION "public"."vendor_clear_menu_item_image"("p_menu_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid", "p_pickup_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order  public.orders%rowtype;
  v_check  text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  v_check := public.check_handoff_code(p_order_id, 'PICKUP', p_pickup_code);

  if v_check = 'LOCKED' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'collection code locked out after repeated failures');
    return row(false, 'too many wrong codes. Wait a few minutes and try again')::public.transition_result;
  end if;

  if v_check <> 'OK' then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'collection code did not match');
    return row(false, 'that collection code does not match')::public.transition_result;
  end if;

  update public.orders o
     set order_status = 'COMPLETED', completed_at = now()
   where o.id = p_order_id
     and o.order_status = 'READY'
     and o.fulfilment_type = 'PICKUP'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', false, 'VENDOR',
      'order_status', null, 'COMPLETED', 'order was not a READY, PAID pickup order');
    return row(false, 'order is not a ready pickup order')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'PICKUP_COMPLETE', true, 'VENDOR',
    'order_status', 'READY', 'COMPLETED');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid", "p_pickup_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text" DEFAULT NULL::"text", "p_scan_eligible" boolean DEFAULT false) RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item public.menu_items%rowtype;
  v_next integer;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if v_name is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;
  if length(v_name) > 120 then
    raise exception 'keep the name under 120 characters' using errcode = 'check_violation';
  end if;

  -- MONEY IS INTEGER PESEWAS. A caller sending 35.50 is a bug, not a rounding
  -- opportunity, so it is refused rather than truncated.
  if p_price_pesewas is null or p_price_pesewas <= 0 then
    raise exception 'give the item a price' using errcode = 'check_violation';
  end if;
  if p_price_pesewas > 100000 then
    raise exception 'that price looks wrong — the most an item can cost is GHS 1000'
      using errcode = 'check_violation';
  end if;

  -- A menu, not a catalogue. Sixty is more than any pilot store will use and
  -- small enough that the storefront stays a page.
  if (select count(*) from public.menu_items where vendor_id = p_vendor_id) >= 60 then
    raise exception 'a store may have at most 60 items; delete one first'
      using errcode = 'check_violation';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_next
    from public.menu_items where vendor_id = p_vendor_id;

  insert into public.menu_items (
    vendor_id, name, description, price_pesewas, sort_order, scan_eligible
  )
  values (
    p_vendor_id, v_name, nullif(btrim(coalesce(p_description, '')), ''),
    p_price_pesewas, v_next, coalesce(p_scan_eligible, false)
  )
  returning * into v_item;

  return v_item;
end;
$$;


ALTER FUNCTION "public"."vendor_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer DEFAULT 30) RETURNS TABLE("order_day" "date", "order_count" integer, "sales_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with day_orders as (
    select o.id,
           o.order_day,
           (o.payment_status = 'PAID' and a.id is not null) as is_sale,
           coalesce(a.amount_pesewas, 0) as amount_pesewas
      from public.orders o
      left join public.allocations a
        on a.order_id = o.id
       and a.payee_type = 'VENDOR'
       and a.payee_id = o.vendor_id
       and a.status <> 'CANCELLED'
     where o.vendor_id = p_vendor_id
       and (o.order_type = 'FOOD' or coalesce(o.pack_fee_pesewas, 0) > 0)
       and o.order_status <> 'DRAFT'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and o.order_day >= (now() at time zone 'UTC')::date
                          - (least(greatest(coalesce(p_days, 30), 1), 366) - 1)
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
  )
  select d.order_day,
         (count(distinct d.id) filter (where d.is_sale))::integer,
         (coalesce(sum(d.amount_pesewas) filter (where d.is_sale), 0))::bigint
    from day_orders d
   group by d.order_day
   order by d.order_day desc;
$$;


ALTER FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer) IS 'One row per day with sales for this vendor: orders with a live VENDOR allocation, and the sum of those allocations. The vendor''s own amount only. Staff or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_delete_image"("p_image_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_image public.vendor_images%rowtype;
begin
  select * into v_image from public.vendor_images where id = p_image_id;
  if not found then
    raise exception 'no such image' using errcode = 'no_data_found';
  end if;
  if not public.is_vendor_staff(v_image.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  delete from public.vendor_images where id = p_image_id;

  -- The caller deletes the object itself; SQL cannot reach the Storage API.
  return v_image.storage_path;
end;
$$;


ALTER FUNCTION "public"."vendor_delete_image"("p_image_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item   public.menu_items%rowtype;
  v_orders integer;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    return false;
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_orders from public.order_items where menu_item_id = p_menu_item_id;
  if v_orders > 0 then
    raise exception
      'somebody has ordered this before, so it cannot be deleted. Take it off the menu instead.'
      using errcode = 'foreign_key_violation';
  end if;

  delete from public.menu_items where id = p_menu_item_id;
  return true;
end;
$$;


ALTER FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") RETURNS TABLE("order_count" bigint, "earned_pesewas" bigint, "awaiting_pesewas" bigint, "settled_pesewas" bigint, "today_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*),
         coalesce(sum(a.amount_pesewas), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status <> 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where o.created_at >= date_trunc('day', now())), 0)::bigint
    from public.allocations a
    join public.orders o on o.id = a.order_id
   where a.payee_type = 'VENDOR'
     and a.payee_id = p_vendor_id
     and a.status <> 'CANCELLED'
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin());
$$;


ALTER FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_code text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  select s.pickup_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and o.payment_status = 'PAID'
     and (
       -- A Partner is at the counter for this order.
       o.delivery_status = 'ASSIGNED'
       -- Or the customer is, and the food is made. DELIVERY_STATUS, not
       -- fulfilment_type: a delivery nobody took, which the customer then chose
       -- to collect themselves, is a collection in every way that matters here.
       -- customer_collect_instead() sets delivery_status back to NONE and mints
       -- a code, and keying on the fulfilment they originally chose would leave
       -- that code unreadable and the order uncompletable.
       or (o.order_status = 'READY' and o.delivery_status = 'NONE')
     );

  if v_code is null then
    raise exception 'no handoff code on this order right now'
      using errcode = 'no_data_found';
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") IS 'The four digits the store reads out at the counter — to a Partner collecting a delivery, or to a customer collecting their own order. The store never types it: whoever is taking the food does that in their own app.';


CREATE OR REPLACE FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  -- Preparation starts only once the money is actually in. The vendor never
  -- cooks on the strength of a browser saying the customer paid.
  update public.orders
     set order_status = 'PREPARING', preparing_at = now()
   where id = p_order_id and order_status = 'ACCEPTED' and payment_status = 'PAID'
  returning * into v_order;

  if not found then
    select order_status into v_prev from public.orders where id = p_order_id;
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;
    perform public.log_order_event(p_order_id, 'VENDOR_PREPARING', false, 'VENDOR',
      'order_status', v_prev::text, 'PREPARING', 'order was not ACCEPTED and PAID');
    return row(false, format('order cannot start preparing from state %s (payment must be PAID)', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_PREPARING', true, 'VENDOR',
    'order_status', 'ACCEPTED', 'PREPARING');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
  v_type  public.order_type;
  v_scan  public.scan_status;
  v_cfg   public.pricing_config%rowtype;
begin
  select order_status, order_type, scan_status into v_prev, v_type, v_scan
    from public.orders where id = p_order_id;
  select * into v_cfg from public.pricing_config where id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_type = 'SCAN' and v_scan is distinct from 'REDEEMED' then
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'the meal scan has not been verified yet');
    return row(false, 'check the meal scan first, then mark it ready')::public.transition_result;
  end if;

  update public.orders o
     set order_status = 'READY',
         ready_at = now(),
         -- Belt only. Dispatch opened at payment; this catches an order that
         -- somehow reached READY with its search never started.
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() else o.search_started_at end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY' and o.delivery_status = 'NONE'
           then now() + make_interval(secs => v_cfg.partner_search_seconds)
           else o.search_deadline_at end
   where o.id = p_order_id
     and o.order_status = 'PREPARING'
     and o.payment_status = 'PAID'
  returning * into v_order;

  if not found then
    select order_status into v_prev from public.orders where id = p_order_id;
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'order was not a paid order being prepared');
    return row(false, format('order cannot be marked ready from state %s', v_prev))::public.transition_result;
  end if;

  -- THE COLLECTION CODE IS MINTED HERE, and only for a collection. It is the
  -- store's to read out; the customer types it in. Minting it at the moment the
  -- order is ready means a code never exists for food that is not.
  if v_order.delivery_status = 'NONE' then
    update public.order_secrets
       set pickup_code = public.generate_numeric_code(4),
           pickup_code_version = pickup_code_version + 1,
           pickup_code_set_at = now(),
           pickup_attempts = 0,
           pickup_locked_until = null
     where order_secrets.order_id = p_order_id;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_READY', true, 'VENDOR',
    'order_status', 'PREPARING', 'READY');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from public.orders o
     where o.id = p_order_id
       and o.order_type = 'SCAN'
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
       and o.order_status in ('ACCEPTED', 'PREPARING', 'READY')
       and public.is_vendor_staff(o.vendor_id)
  );
$$;


ALTER FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") IS 'Whether the caller staffs the store this scan order belongs to AND the order is still live on its board. The one predicate behind both the order_scans policy and vendor_scan_image_path(), so the row and the image can never disagree about who may look.';


CREATE OR REPLACE FUNCTION "public"."vendor_menu"("p_vendor_id" "uuid") RETURNS TABLE("id" "uuid", "name" "text", "description" "text", "price_pesewas" bigint, "is_available" boolean, "unavailable_reason" "text", "scan_eligible" boolean, "image_path" "text", "sort_order" integer, "order_count" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select m.id, m.name, m.description, m.price_pesewas,
         m.is_available, m.unavailable_reason, m.scan_eligible, m.image_path, m.sort_order,
         -- WHETHER IT CAN BE DELETED, answered on the row rather than by
         -- letting somebody press Delete and read an error. An item any order
         -- references is withdrawn, never removed.
         (select count(*) from public.order_items oi where oi.menu_item_id = m.id)
    from public.menu_items m
   where m.vendor_id = p_vendor_id
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   order by m.sort_order, m.name;
$$;


ALTER FUNCTION "public"."vendor_menu"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer DEFAULT 20) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "bucket" "text", "order_type" "public"."order_type", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "scan_status" "public"."scan_status", "item_count" bigint, "vendor_amount_pesewas" bigint, "scan_value_pesewas" bigint, "pack_included" boolean, "submitted_at" timestamp with time zone, "age_seconds" integer, "vendor_completed_at" timestamp with time zone, "awaiting_handoff" boolean, "cancellation_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       and o.order_status <> 'DRAFT'
       -- PAID ONLY. A store is never shown an order somebody has not paid for.
       and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket_for(v.order_status, v.vendor_completed_at)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.vendor_order_no,
         r.bucket,
         r.order_type,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         r.scan_status,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         -- THE STORE'S AMOUNT THROUGH CAMPUS DASH. The food on a food order,
         -- the pack on a scan order. Never the total, never a Campus Dash fee.
         r.subtotal_pesewas + coalesce(r.pack_fee_pesewas, 0),
         case when r.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = r.id)
              else 0::bigint end,
         coalesce(r.pack_fee_pesewas, 0) > 0,
         r.submitted_at,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         r.vendor_completed_at,
         (r.vendor_completed_at is null and r.order_status = 'READY'
            and (r.delivery_status = 'ASSIGNED' or r.delivery_status = 'NONE')),
         r.cancellation_reason
    from ranked r
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'READY' then 1 else 2 end,
     case when r.bucket = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;


ALTER FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) IS 'The store''s board: paid orders only, the store''s own amount (subtotal + pack) and never a customer total, a destination or a phone number. pack_included is the operational fact a counter needs on a scan order. Staff or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    -- ACCEPTED only ever appears here for a moment: confirm_payment moves a
    -- paid order straight to PREPARING, and an unpaid one is not on the board.
    when p_order_status in ('ACCEPTED', 'PREPARING') then 'NEW'
    when p_order_status = 'READY'                    then 'READY'
    else 'CLOSED'
  end;
$$;


ALTER FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when p_vendor_completed_at is not null                then 'CLOSED'
    when p_order_status in ('ACCEPTED', 'PREPARING')      then 'NEW'
    when p_order_status = 'READY'                         then 'READY'
    else 'CLOSED'
  end;
$$;


ALTER FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) IS 'Which column of the store''s board an order belongs in. Keyed on the store''s own completion rather than the order''s, so a Partner order leaves the counter at handoff.';


CREATE OR REPLACE FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_order_no" integer, "vendor_id" "uuid", "bucket" "text", "order_type" "public"."order_type", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "scan_status" "public"."scan_status", "scan_details" "text", "scan_value_pesewas" bigint, "vendor_amount_pesewas" bigint, "vendor_pack_pesewas" bigint, "submitted_at" timestamp with time zone, "age_seconds" integer, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "vendor_completed_at" timestamp with time zone, "handoff_code_available" boolean, "cancellation_reason" "text", "items" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.vendor_order_no,
         o.vendor_id,
         public.vendor_order_bucket_for(o.order_status, o.vendor_completed_at),
         o.order_type,
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.scan_status,
         -- The customer's optional note about the FOOD, which is the store's
         -- business. The destination note is a different column and is not here.
         case when o.order_type = 'SCAN' then s.details end,
         case when o.order_type = 'SCAN'
              then (select coalesce(sum(oi.line_total_pesewas), 0)
                      from public.order_items oi where oi.order_id = o.id)
              else 0::bigint end,
         o.subtotal_pesewas + coalesce(o.pack_fee_pesewas, 0),
         -- THE STORE'S PACK MONEY, as its own figure, so the order screen can
         -- say what the pack is worth to the store without doing arithmetic.
         coalesce(o.pack_fee_pesewas, 0),
         o.submitted_at,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.vendor_completed_at,
         (o.payment_status = 'PAID' and o.vendor_completed_at is null and (
            o.delivery_status = 'ASSIGNED'
            or (o.order_status = 'READY' and o.delivery_status = 'NONE'))),
         o.cancellation_reason,
         coalesce(
           (select jsonb_agg(
                     jsonb_build_object(
                       'name', oi.name_snapshot,
                       'quantity', oi.quantity,
                       'unit_price_pesewas', oi.unit_price_pesewas,
                       'line_total_pesewas', oi.line_total_pesewas
                     ) order by oi.created_at
                   )
              from public.order_items oi where oi.order_id = o.id),
           '[]'::jsonb
         )
    from public.orders o
    left join public.order_scans s on s.order_id = o.id
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;


ALTER FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") IS 'One paid order, as its store sees it: items, the store''s amount (subtotal + pack) and, on a scan order, the scanned value and the pack. No destination, no phone number, no customer total. Staff or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") RETURNS TABLE("order_id" "uuid", "vendor_order_no" integer, "order_status" "public"."order_status", "payment_status" "public"."payment_status", "fulfilment_type" "public"."fulfilment_type", "item_count" bigint, "vendor_amount_pesewas" bigint, "counts_as_sale" boolean, "submitted_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.vendor_order_no,
         o.order_status,
         o.payment_status,
         o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.subtotal_pesewas + coalesce(o.pack_fee_pesewas, 0),
         -- The same rule vendor_daily_sales() sums by, so a day's list and its
         -- History row always agree.
         o.payment_status = 'PAID'
         and exists (
           select 1 from public.allocations a
            where a.order_id = o.id
              and a.payee_type = 'VENDOR'
              and a.payee_id = o.vendor_id
              and a.status <> 'CANCELLED'
         ),
         o.submitted_at
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.order_day = p_day
     and (o.order_type = 'FOOD' or coalesce(o.pack_fee_pesewas, 0) > 0)
     and o.order_status <> 'DRAFT'
     and o.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED')
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
   order by o.vendor_order_no desc nulls last, o.created_at desc;
$$;


ALTER FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") IS 'The paid orders behind one vendor_daily_sales() row, newest queue number first, with the vendor''s own amount. Staff or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_owner_contact"("p_vendor_id" "uuid") RETURNS TABLE("user_id" "uuid", "phone" "text", "full_name" "text", "store_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  perform public.assert_service_or_admin();

  return query
    select u.id, u.phone, u.full_name, v.name
      from public.vendors v
      join public.users u on u.id = v.owner_user_id
     where v.id = p_vendor_id and u.phone is not null;
end;
$$;


ALTER FUNCTION "public"."vendor_owner_contact"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.payment_status = 'PAID'
     and o.vendor_completed_at is null
     and o.order_status in ('ACCEPTED', 'PREPARING')
     and public.is_vendor_staff(p_vendor_id);
$$;


ALTER FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_pickup_code"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_code text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  select s.pickup_code into v_code
    from public.order_secrets s
    join public.orders o on o.id = s.order_id
   where s.order_id = p_order_id
     and o.delivery_status = 'ASSIGNED';

  if v_code is null then
    raise exception 'no pickup code on this order right now'
      using errcode = 'no_data_found';
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."vendor_pickup_code"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_redeem_scan"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order from public.orders where id = p_order_id;

  -- AUTHORISATION failures raise; state failures return. Hard rule 9.
  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  update public.orders o
     set scan_status = 'REDEEMED'
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.payment_status = 'PAID'
     -- UPLOADED or RELEASED: a Partner may or may not have been assigned by
     -- now, and the store does not wait on dispatch to check a scan.
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING');

  if not found then
    perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', false, 'VENDOR',
      'scan_status', v_order.scan_status::text, 'REDEEMED',
      'scan was already settled, or the order is not a paid order being prepared');
    return row(false, 'this scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set redeemed_at = now(), redeemed_by = auth.uid()
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REDEEMED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REDEEMED', 'verified at the counter');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_redeem_scan"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_refuse_scan"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order  public.orders%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_order from public.orders where id = p_order_id;

  if not found or not (public.is_vendor_staff(v_order.vendor_id) or public.is_admin()) then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  if v_reason is null then
    return row(false, 'say why the scan could not be honoured')::public.transition_result;
  end if;

  if v_order.order_type <> 'SCAN' then
    return row(false, 'this order is not a meal scan')::public.transition_result;
  end if;

  update public.orders o
     set scan_status = 'REFUSED'
   where o.id = p_order_id
     and o.order_type = 'SCAN'
     and o.scan_status in ('UPLOADED', 'RELEASED')
     and o.order_status in ('ACCEPTED', 'PREPARING');

  if not found then
    return row(false, 'this scan has already been dealt with')::public.transition_result;
  end if;

  update public.order_scans
     set refused_at = now(), refusal_reason = v_reason
   where order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'SCAN_REFUSED', true, 'VENDOR',
    'scan_status', v_order.scan_status::text, 'REFUSED', v_reason);

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_refuse_scan"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
  v_prev  public.order_status;
begin
  select order_status into v_prev from public.orders where id = p_order_id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders
     set order_status = 'REJECTED', cancelled_at = now(), cancellation_reason = p_reason
   where id = p_order_id and order_status = 'SUBMITTED'
  returning * into v_order;

  if not found then
    select order_status into v_prev from public.orders where id = p_order_id;
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;
    perform public.log_order_event(p_order_id, 'VENDOR_REJECT', false, 'VENDOR',
      'order_status', v_prev::text, 'REJECTED', 'order was not SUBMITTED');
    return row(false, format('order cannot be rejected from state %s', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_REJECT', true, 'VENDOR',
    'order_status', 'SUBMITTED', 'REJECTED', p_reason);
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") RETURNS "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select s.image_path
    from public.order_scans s
   where s.order_id = p_order_id
     and public.vendor_may_read_scan(p_order_id);
$$;


ALTER FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") IS 'The scan image, for the store that is about to redeem it. Live orders only: the right opens when the order is paid and closes when it leaves the board, exactly as the assigned Partner''s does.';


CREATE OR REPLACE FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_before public.vendors%rowtype;
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  select * into v_before from public.vendors where id = p_vendor_id;

  update public.vendors set is_accepting_orders = p_accepting
   where id = p_vendor_id and status = 'ACTIVE'
  returning * into v_vendor;

  if not found then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;

  -- CLOSED → OPEN clears every SOLD-OUT mark, and nothing else. A vendor who
  -- has to untick fourteen items before they can sell anything will stop
  -- bothering; a vendor whose withdrawn dishes reappear overnight will stop
  -- trusting the switch. Guarded on the transition, so pressing Open twice does
  -- not reset a mark somebody set deliberately a minute ago while already open.
  if p_accepting and not coalesce(v_before.is_accepting_orders, false) then
    update public.menu_items
       set is_available = true, unavailable_reason = null
     where vendor_id = p_vendor_id
       and not is_available
       and unavailable_reason is distinct from 'WITHDRAWN';
  end if;

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text" DEFAULT 'SOLD_OUT'::"text") RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item public.menu_items%rowtype;
  v_reason text := upper(coalesce(p_reason, 'SOLD_OUT'));
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if not p_available and v_reason not in ('SOLD_OUT', 'WITHDRAWN') then
    raise exception 'unknown reason' using errcode = 'check_violation';
  end if;

  update public.menu_items m
     set is_available = p_available,
         unavailable_reason = case when p_available then null else v_reason end,
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;


ALTER FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_set_menu_item_image"("p_menu_item_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint) RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item     public.menu_items%rowtype;
  v_previous text;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_storage_path, '')), '') is null then
    raise exception 'no image was received' using errcode = 'check_violation';
  end if;

  v_previous := v_item.image_path;

  update public.menu_items
     set image_path = btrim(p_storage_path),
         image_content_type = p_content_type,
         image_byte_size = p_byte_size,
         updated_at = now()
   where id = p_menu_item_id;

  -- THE PATH THAT WAS REPLACED, so the caller can delete the object it points
  -- at. Replacing a photograph without this leaves the old file in the bucket
  -- for ever, which is how a storage bill grows with nothing to show for it.
  return v_previous;
end;
$$;


ALTER FUNCTION "public"."vendor_set_menu_item_image"("p_menu_item_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_set_payout_destination"("p_vendor_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") RETURNS "public"."payout_destinations"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_row    public.payout_destinations%rowtype;
  v_number text := regexp_replace(coalesce(p_account_number, ''), '[^0-9+]', '', 'g');
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- OWNERSHIP, not membership. vendors.owner_user_id is the whole model.
  if not exists (
    select 1 from public.vendors v
     where v.id = p_vendor_id and v.owner_user_id = auth.uid()
  ) then
    raise exception 'you do not own that store' using errcode = 'insufficient_privilege';
  end if;

  if left(v_number, 4) = '+233' then
    v_number := '0' || substring(v_number from 5);
  elsif left(v_number, 3) = '233' then
    v_number := '0' || substring(v_number from 4);
  end if;

  if v_number !~ '^0[0-9]{9}$' then
    raise exception 'a Ghanaian mobile money number is required, e.g. 0551234567'
      using errcode = 'check_violation';
  end if;
  if p_momo_network not in ('MTN', 'VODAFONE', 'AIRTELTIGO') then
    raise exception 'choose MTN, VODAFONE or AIRTELTIGO' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_account_name, '')), '') is null then
    raise exception 'the name on the mobile money account is required'
      using errcode = 'check_violation';
  end if;

  insert into public.payout_destinations (
    payee_type, payee_id, momo_network, account_number, account_name
  )
  values ('VENDOR', p_vendor_id, p_momo_network, v_number, btrim(p_account_name))
  -- CHANGING THE NUMBER INVALIDATES BOTH PROVIDER IDENTITIES. A subaccount code
  -- points at the old account; keeping it would route the next order's food
  -- money to a number the vendor has just told us is wrong.
  on conflict (payee_type, payee_id) do update
     set momo_network   = excluded.momo_network,
         account_number = excluded.account_number,
         account_name   = excluded.account_name,
         provider                 = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider end,
         provider_recipient_code  = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_recipient_code end,
         provider_synced_at       = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_synced_at end,
         provider_subaccount_code = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.provider_subaccount_code end,
         subaccount_synced_at     = case when public.payout_destinations.account_number <> excluded.account_number
                                          or public.payout_destinations.momo_network   <> excluded.momo_network
                                         then null else public.payout_destinations.subaccount_synced_at end,
         subaccount_error         = null
  returning * into v_row;

  return v_row;
end;
$_$;


ALTER FUNCTION "public"."vendor_set_payout_destination"("p_vendor_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") RETURNS "public"."vendor_images"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_image public.vendor_images%rowtype;
  v_first integer;
begin
  select * into v_image from public.vendor_images where id = p_image_id;
  if not found then
    raise exception 'no such image' using errcode = 'no_data_found';
  end if;
  if not public.is_vendor_staff(v_image.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  select min(sort_order) into v_first
    from public.vendor_images where vendor_id = v_image.vendor_id;

  -- Already first: nothing to do, and nothing to renumber.
  if v_image.sort_order = v_first then
    return v_image;
  end if;

  -- In front of everything else, and everything else keeps its own order.
  update public.vendor_images
     set sort_order = v_first - 1
   where id = p_image_id
  returning * into v_image;

  return v_image;
end;
$$;


ALTER FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") IS 'Moves one store photo to the front, making it the photo used wherever a single picture of the store is shown. The rest keep their order. Owner or admin, enforced in the body.';


CREATE OR REPLACE FUNCTION "public"."vendor_signup"("p_applicant_name" "text", "p_store_name" "text", "p_is_student" boolean, "p_description" "text", "p_category_id" "uuid", "p_terms_id" "uuid") RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user   uuid := auth.uid();
  v_phone  text;
  v_vendor public.vendors%rowtype;
  v_doc    public.terms_documents%rowtype;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  -- The verified number IS the vendor's credential, so it is read from the
  -- identity row rather than accepted as a parameter.
  select phone into v_phone from public.users where id = v_user;
  if coalesce(v_phone, '') = '' then
    raise exception 'verify your phone number before registering a store'
      using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_applicant_name, '')), '') is null then
    raise exception 'your name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_store_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_description, '')), '') is null then
    raise exception 'describe what your store sells' using errcode = 'check_violation';
  end if;
  if p_is_student is null then
    raise exception 'say whether you are a student' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.vendor_categories where id = p_category_id and is_active
  ) then
    raise exception 'choose a business category' using errcode = 'check_violation';
  end if;

  select * into v_doc from public.terms_documents where id = p_terms_id;
  if not found or v_doc.published_at is null or v_doc.audience <> 'VENDOR' then
    raise exception 'the vendor terms must be accepted to continue'
      using errcode = 'check_violation';
  end if;
  if v_doc.version <> (
    select max(t.version) from public.terms_documents t
     where t.audience = 'VENDOR' and t.published_at is not null
  ) then
    raise exception 'those terms have been superseded; reload and try again'
      using errcode = 'check_violation';
  end if;

  select * into v_vendor from public.vendors where owner_user_id = v_user;

  if found then
    -- RESUBMISSION. A rejected applicant corrects what was wrong and comes
    -- back; that is the whole point of telling them the reason. Anything else
    -- is not a second application.
    if v_vendor.status <> 'REJECTED' then
      raise exception 'this account already has a store (%)' , v_vendor.status
        using errcode = 'check_violation';
    end if;

    update public.vendors
       set name             = btrim(p_store_name),
           description      = btrim(p_description),
           category_id      = p_category_id,
           applicant_name   = btrim(p_applicant_name),
           owner_is_student = p_is_student,
           phone            = v_phone,
           status           = 'PENDING_APPROVAL',
           rejection_reason = null,
           reviewed_at      = null,
           reviewed_by      = null,
           submitted_at     = now()
     where id = v_vendor.id
    returning * into v_vendor;
  else
    insert into public.vendors (
      name, phone, status, is_accepting_orders,
      owner_user_id, category_id, description, applicant_name, owner_is_student,
      submitted_at
    )
    values (
      btrim(p_store_name), v_phone, 'PENDING_APPROVAL', false,
      v_user, p_category_id, btrim(p_description), btrim(p_applicant_name),
      p_is_student, now()
    )
    returning * into v_vendor;
  end if;

  insert into public.terms_acceptances (user_id, terms_id, audience, version)
  values (v_user, v_doc.id, v_doc.audience, v_doc.version)
  on conflict (user_id, audience, version)
    do update set accepted_at = public.terms_acceptances.accepted_at;

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."vendor_signup"("p_applicant_name" "text", "p_store_name" "text", "p_is_student" boolean, "p_description" "text", "p_category_id" "uuid", "p_terms_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_update_menu_item"("p_menu_item_id" "uuid", "p_name" "text" DEFAULT NULL::"text", "p_price_pesewas" bigint DEFAULT NULL::bigint, "p_description" "text" DEFAULT NULL::"text", "p_scan_eligible" boolean DEFAULT NULL::boolean) RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_item public.menu_items%rowtype;
begin
  select * into v_item from public.menu_items where id = p_menu_item_id;
  if not found then
    raise exception 'that item no longer exists' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_item.vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  if p_price_pesewas is not null and (p_price_pesewas <= 0 or p_price_pesewas > 100000) then
    raise exception 'give the item a sensible price' using errcode = 'check_violation';
  end if;
  if p_name is not null and nullif(btrim(p_name), '') is null then
    raise exception 'give the item a name' using errcode = 'check_violation';
  end if;

  -- A PRICE CHANGE REACHES NO EXISTING ORDER. price_order() snapshots every
  -- figure onto the order at submission and order_items keeps its own copy, so
  -- this moves what the NEXT customer is quoted and nothing else. That is the
  -- whole reason a store can be trusted with its own prices.
  update public.menu_items m
     set name = coalesce(nullif(btrim(p_name), ''), m.name),
         price_pesewas = coalesce(p_price_pesewas, m.price_pesewas),
         description = case
           when p_description is null then m.description
           else nullif(btrim(p_description), '') end,
         scan_eligible = coalesce(p_scan_eligible, m.scan_eligible),
         updated_at = now()
   where m.id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;


ALTER FUNCTION "public"."vendor_update_menu_item"("p_menu_item_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_update_profile"("p_vendor_id" "uuid", "p_name" "text", "p_description" "text", "p_category_id" "uuid", "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this store' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_name, '')), '') is null then
    raise exception 'a store name is required' using errcode = 'check_violation';
  end if;
  if p_category_id is not null and not exists (
    select 1 from public.vendor_categories where id = p_category_id
  ) then
    raise exception 'that category does not exist' using errcode = 'check_violation';
  end if;
  if p_walk_minutes is not null and p_walk_minutes < 0 then
    raise exception 'walking time cannot be negative' using errcode = 'check_violation';
  end if;
  if p_location_id is not null and not exists (
    select 1 from public.locations where id = p_location_id
  ) then
    raise exception 'that location does not exist' using errcode = 'check_violation';
  end if;

  update public.vendors
     set name                   = btrim(p_name),
         description            = nullif(btrim(coalesce(p_description, '')), ''),
         category_id            = coalesce(p_category_id, category_id),
         location_id            = p_location_id,
         location_note          = nullif(btrim(coalesce(p_location_note, '')), ''),
         walk_minutes_to_campus = p_walk_minutes
   where id = p_vendor_id
  returning * into v_vendor;

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."vendor_update_profile"("p_vendor_id" "uuid", "p_name" "text", "p_description" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes" integer) OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."admin_actions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."admin_actions_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."admin_actions_id_seq" OWNED BY "public"."admin_actions"."id";


CREATE TABLE IF NOT EXISTS "public"."allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "payee_type" "public"."payee_type" NOT NULL,
    "payee_id" "uuid",
    "amount_pesewas" bigint NOT NULL,
    "status" "public"."allocation_status" DEFAULT 'PENDING'::"public"."allocation_status" NOT NULL,
    "settlement_run_id" "uuid",
    "settled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "settlement_channel" "text",
    CONSTRAINT "allocations_amount_pesewas_check" CHECK (("amount_pesewas" >= 0)),
    CONSTRAINT "allocations_payee_id_presence" CHECK (((("payee_type" = 'PLATFORM'::"public"."payee_type") AND ("payee_id" IS NULL)) OR (("payee_type" <> 'PLATFORM'::"public"."payee_type") AND ("payee_id" IS NOT NULL)))),
    CONSTRAINT "allocations_settlement_channel_check" CHECK ((("settlement_channel" IS NULL) OR ("settlement_channel" = ANY (ARRAY['SPLIT'::"text", 'TRANSFER'::"text"]))))
);


ALTER TABLE "public"."allocations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."allocations"."settlement_channel" IS 'How this money reaches the payee. SPLIT means Paystack routed it at the moment of the charge and it was never in the Campus Dash balance; TRANSFER means a settlement run moves it. NULL on rows written before split settlement existed — historical, and deliberately not backfilled with a guess.';


CREATE TABLE IF NOT EXISTS "public"."idempotency_keys" (
    "key" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "user_id" "uuid",
    "request_hash" "text" NOT NULL,
    "response" "jsonb",
    "status" "text" DEFAULT 'IN_PROGRESS'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval) NOT NULL
);


ALTER TABLE "public"."idempotency_keys" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."notification_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."notification_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."notification_events_id_seq" OWNED BY "public"."notification_events"."id";


CREATE TABLE IF NOT EXISTS "public"."order_events" (
    "id" bigint NOT NULL,
    "order_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "actor_role" "text" NOT NULL,
    "event" "text" NOT NULL,
    "dimension" "text",
    "from_state" "text",
    "to_state" "text",
    "accepted" boolean NOT NULL,
    "reason" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."order_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."order_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."order_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."order_events_id_seq" OWNED BY "public"."order_events"."id";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid" NOT NULL,
    "menu_item_id" "uuid",
    "name_snapshot" "text" NOT NULL,
    "unit_price_pesewas" bigint NOT NULL,
    "quantity" integer NOT NULL,
    "line_total_pesewas" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "order_items_line_total_is_product" CHECK (("line_total_pesewas" = ("unit_price_pesewas" * "quantity"))),
    CONSTRAINT "order_items_line_total_pesewas_check" CHECK (("line_total_pesewas" > 0)),
    CONSTRAINT "order_items_quantity_check" CHECK ((("quantity" > 0) AND ("quantity" <= 50))),
    CONSTRAINT "order_items_unit_price_pesewas_check" CHECK (("unit_price_pesewas" > 0))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."order_number_seq"
    START WITH 1000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."order_number_seq" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_scans" (
    "order_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "image_path" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "byte_size" bigint NOT NULL,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "released_to" "uuid",
    "released_at" timestamp with time zone,
    "redeemed_at" timestamp with time zone,
    "redeemed_by" "uuid",
    "refused_at" timestamp with time zone,
    "refusal_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "details" "text",
    CONSTRAINT "order_scans_byte_size_check" CHECK (("byte_size" > 0)),
    CONSTRAINT "order_scans_details_length" CHECK ((("details" IS NULL) OR (("btrim"("details") <> ''::"text") AND ("length"("details") <= 1000)))),
    CONSTRAINT "order_scans_redeem_pair" CHECK ((("redeemed_by" IS NULL) = ("redeemed_at" IS NULL))),
    CONSTRAINT "order_scans_release_pair" CHECK ((("released_to" IS NULL) = ("released_at" IS NULL)))
);


ALTER TABLE "public"."order_scans" OWNER TO "postgres";


COMMENT ON TABLE "public"."order_scans" IS 'The customer''s uploaded scan image and its release/redemption audit. The image itself lives in the private scan-documents bucket; this row holds the path and decides who is currently allowed to be shown it.';


COMMENT ON COLUMN "public"."order_scans"."details" IS 'What the customer wants done with this scan, in their own words. Required on every new errand; NULL only on errands created before the field existed.';


CREATE TABLE IF NOT EXISTS "public"."order_secrets" (
    "order_id" "uuid" NOT NULL,
    "pickup_code" "text",
    "pickup_code_version" integer DEFAULT 0 NOT NULL,
    "pickup_code_set_at" timestamp with time zone,
    "delivery_code" "text",
    "delivery_code_set_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "pickup_attempts" integer DEFAULT 0 NOT NULL,
    "pickup_locked_until" timestamp with time zone,
    "delivery_attempts" integer DEFAULT 0 NOT NULL,
    "delivery_locked_until" timestamp with time zone,
    CONSTRAINT "order_secrets_attempts_nonneg" CHECK ((("pickup_attempts" >= 0) AND ("delivery_attempts" >= 0))),
    CONSTRAINT "order_secrets_delivery_code_format" CHECK ((("delivery_code" IS NULL) OR ("delivery_code" ~ '^\d{4}$'::"text"))),
    CONSTRAINT "order_secrets_pickup_code_format" CHECK ((("pickup_code" IS NULL) OR ("pickup_code" ~ '^\d{4}$'::"text")))
);


ALTER TABLE "public"."order_secrets" OWNER TO "postgres";


COMMENT ON COLUMN "public"."order_secrets"."pickup_attempts" IS 'Consecutive wrong pickup codes. Reset by a correct one and by a newly generated code. Server-only, like everything else on this table.';


COMMENT ON COLUMN "public"."order_secrets"."delivery_attempts" IS 'Consecutive wrong delivery codes. Reset by a correct one.';


CREATE TABLE IF NOT EXISTS "public"."partner_ratings" (
    "order_id" "uuid" NOT NULL,
    "partner_id" "uuid" NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "stars" smallint NOT NULL,
    "comment" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "partner_ratings_comment_length" CHECK ((("comment" IS NULL) OR ("length"("comment") <= 500))),
    CONSTRAINT "partner_ratings_not_self" CHECK (("partner_id" <> "customer_id")),
    CONSTRAINT "partner_ratings_stars_check" CHECK ((("stars" >= 1) AND ("stars" <= 5)))
);


ALTER TABLE "public"."partner_ratings" OWNER TO "postgres";


COMMENT ON TABLE "public"."partner_ratings" IS 'One rating per completed delivery. The order is the primary key, so a duplicate is impossible rather than merely guarded against.';


CREATE TABLE IF NOT EXISTS "public"."partner_sessions" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    "ended_reason" "text",
    CONSTRAINT "partner_sessions_ends_after_start" CHECK ((("ended_at" IS NULL) OR ("ended_at" >= "started_at")))
);


ALTER TABLE "public"."partner_sessions" OWNER TO "postgres";


COMMENT ON TABLE "public"."partner_sessions" IS 'One row per period a Partner was online and willing to take work. Opened by partner_set_availability(true) and closed by the matching false, so online time is MEASURED rather than inferred from page visits — which would measure whether somebody looked at their phone.';


ALTER TABLE "public"."partner_sessions" ALTER COLUMN "id" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "public"."partner_sessions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


CREATE TABLE IF NOT EXISTS "public"."terms_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "audience" "public"."terms_audience" NOT NULL,
    "version" integer NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "terms_documents_version_check" CHECK (("version" > 0))
);


ALTER TABLE "public"."terms_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vendor_order_counters" (
    "vendor_id" "uuid" NOT NULL,
    "order_day" "date" NOT NULL,
    "last_no" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vendor_order_counters_last_no_check" CHECK (("last_no" >= 0))
);


ALTER TABLE "public"."vendor_order_counters" OWNER TO "postgres";


COMMENT ON TABLE "public"."vendor_order_counters" IS 'One row per store per day, holding the last queue number issued. Server-only: there are no client grants, and the number is allocated inside submit_order_for().';


CREATE TABLE IF NOT EXISTS "public"."webhook_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" NOT NULL,
    "event_id" "text" NOT NULL,
    "status" "public"."webhook_event_status" DEFAULT 'RECEIVED'::"public"."webhook_event_status" NOT NULL,
    "signature_valid" boolean DEFAULT false NOT NULL,
    "payload" "jsonb" NOT NULL,
    "error" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone
);


ALTER TABLE "public"."webhook_events" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_actions" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."admin_actions_id_seq"'::"regclass");


ALTER TABLE ONLY "public"."notification_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."notification_events_id_seq"'::"regclass");


ALTER TABLE ONLY "public"."order_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."order_events_id_seq"'::"regclass");


ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."allocations"
    ADD CONSTRAINT "allocations_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."customer_profiles"
    ADD CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("user_id");


ALTER TABLE ONLY "public"."customer_rewards"
    ADD CONSTRAINT "customer_rewards_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."customer_rewards"
    ADD CONSTRAINT "customer_rewards_user_cycle_unique" UNIQUE ("user_id", "cycle");


ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key");


ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."order_events"
    ADD CONSTRAINT "order_events_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."order_scans"
    ADD CONSTRAINT "order_scans_pkey" PRIMARY KEY ("order_id");


ALTER TABLE ONLY "public"."order_secrets"
    ADD CONSTRAINT "order_secrets_pkey" PRIMARY KEY ("order_id");


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."partner_profiles"
    ADD CONSTRAINT "partner_profiles_pkey" PRIMARY KEY ("user_id");


ALTER TABLE ONLY "public"."partner_ratings"
    ADD CONSTRAINT "partner_ratings_pkey" PRIMARY KEY ("order_id");


ALTER TABLE ONLY "public"."partner_sessions"
    ADD CONSTRAINT "partner_sessions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."payout_destinations"
    ADD CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("payee_type", "payee_id");


ALTER TABLE ONLY "public"."payouts"
    ADD CONSTRAINT "payouts_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."pricing_config"
    ADD CONSTRAINT "pricing_config_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."settlement_runs"
    ADD CONSTRAINT "settlement_runs_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."terms_documents"
    ADD CONSTRAINT "terms_documents_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."vendor_categories"
    ADD CONSTRAINT "vendor_categories_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."vendor_images"
    ADD CONSTRAINT "vendor_images_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."vendor_order_counters"
    ADD CONSTRAINT "vendor_order_counters_pkey" PRIMARY KEY ("vendor_id", "order_day");


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."webhook_events"
    ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");


CREATE INDEX "admin_actions_admin_idx" ON "public"."admin_actions" USING "btree" ("admin_user_id", "created_at" DESC);


CREATE INDEX "admin_actions_created_idx" ON "public"."admin_actions" USING "btree" ("created_at" DESC);


CREATE INDEX "admin_actions_target_idx" ON "public"."admin_actions" USING "btree" ("target_type", "target_id", "created_at" DESC);


CREATE INDEX "allocations_channel_idx" ON "public"."allocations" USING "btree" ("payee_type", "settlement_channel", "status");


CREATE UNIQUE INDEX "allocations_order_payee_unique" ON "public"."allocations" USING "btree" ("order_id", "payee_type", COALESCE("payee_id", '00000000-0000-0000-0000-000000000000'::"uuid"));


CREATE INDEX "allocations_payee_idx" ON "public"."allocations" USING "btree" ("payee_type", "payee_id", "status");


CREATE INDEX "allocations_settlement_idx" ON "public"."allocations" USING "btree" ("settlement_run_id") WHERE ("settlement_run_id" IS NOT NULL);


CREATE UNIQUE INDEX "customer_profiles_student_id_unique" ON "public"."customer_profiles" USING "btree" ("student_id_number") WHERE ("student_id_number" IS NOT NULL);


CREATE INDEX "customer_rewards_open_idx" ON "public"."customer_rewards" USING "btree" ("unlocked_at" DESC) WHERE ("status" = 'UNLOCKED'::"text");


CREATE INDEX "customer_rewards_user_idx" ON "public"."customer_rewards" USING "btree" ("user_id", "unlocked_at" DESC);


CREATE INDEX "idempotency_keys_expiry_idx" ON "public"."idempotency_keys" USING "btree" ("expires_at");


CREATE INDEX "locations_deliverable_idx" ON "public"."locations" USING "btree" ("id") WHERE ("is_deliverable" AND "is_active");


CREATE INDEX "locations_parent_idx" ON "public"."locations" USING "btree" ("parent_id");


CREATE UNIQUE INDEX "locations_sibling_name_unique" ON "public"."locations" USING "btree" (COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "lower"("name"));


CREATE INDEX "menu_items_scan_eligible_idx" ON "public"."menu_items" USING "btree" ("vendor_id") WHERE ("scan_eligible" AND "is_available");


CREATE INDEX "menu_items_vendor_idx" ON "public"."menu_items" USING "btree" ("vendor_id");


CREATE UNIQUE INDEX "menu_items_vendor_name_unique" ON "public"."menu_items" USING "btree" ("vendor_id", "lower"("name"));


CREATE UNIQUE INDEX "notification_events_correlation_unique" ON "public"."notification_events" USING "btree" ("correlation_id") WHERE ("correlation_id" IS NOT NULL);


CREATE UNIQUE INDEX "notification_events_dedupe_unique" ON "public"."notification_events" USING "btree" ("dedupe_key") WHERE (("dedupe_key" IS NOT NULL) AND "succeeded");


CREATE INDEX "notification_events_delivery_status_idx" ON "public"."notification_events" USING "btree" ("delivery_status", "delivery_updated_at" DESC) WHERE ("delivery_status" IS NOT NULL);


CREATE INDEX "notification_events_failed_idx" ON "public"."notification_events" USING "btree" ("created_at" DESC) WHERE (NOT "succeeded");


CREATE INDEX "notification_events_order_idx" ON "public"."notification_events" USING "btree" ("order_id", "created_at" DESC);


CREATE INDEX "notification_events_provider_message_idx" ON "public"."notification_events" USING "btree" ("provider_message_id") WHERE ("provider_message_id" IS NOT NULL);


CREATE INDEX "notification_events_recipient_idx" ON "public"."notification_events" USING "btree" ("recipient", "created_at" DESC);


CREATE INDEX "order_events_order_idx" ON "public"."order_events" USING "btree" ("order_id", "created_at" DESC);


CREATE INDEX "order_events_rejected_idx" ON "public"."order_events" USING "btree" ("created_at" DESC) WHERE (NOT "accepted");


CREATE INDEX "order_items_order_idx" ON "public"."order_items" USING "btree" ("order_id");


CREATE INDEX "orders_awaiting_payment_idx" ON "public"."orders" USING "btree" ("accept_deadline_at") WHERE (("order_status" = 'ACCEPTED'::"public"."order_status") AND ("payment_status" = 'UNPAID'::"public"."payment_status"));


CREATE INDEX "orders_awaiting_vendor_idx" ON "public"."orders" USING "btree" ("accept_deadline_at") WHERE ("order_status" = 'SUBMITTED'::"public"."order_status");


CREATE INDEX "orders_customer_idx" ON "public"."orders" USING "btree" ("customer_id", "created_at" DESC);


CREATE INDEX "orders_disputed_idx" ON "public"."orders" USING "btree" ("disputed_at") WHERE (("disputed_at" IS NOT NULL) AND ("dispute_resolved_at" IS NULL));


CREATE UNIQUE INDEX "orders_order_number_key" ON "public"."orders" USING "btree" ("order_number");


CREATE UNIQUE INDEX "orders_partner_active_slot_unique" ON "public"."orders" USING "btree" ("partner_id", "partner_slot") WHERE (("partner_id" IS NOT NULL) AND ("partner_slot" IS NOT NULL) AND ("delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status"])));


CREATE INDEX "orders_partner_idx" ON "public"."orders" USING "btree" ("partner_id") WHERE ("partner_id" IS NOT NULL);


CREATE INDEX "orders_scan_dispatch_idx" ON "public"."orders" USING "btree" ("order_type", "delivery_status") WHERE ("order_type" = 'SCAN'::"public"."order_type");


CREATE INDEX "orders_searching_idx" ON "public"."orders" USING "btree" ("search_started_at") WHERE ("delivery_status" = 'SEARCHING'::"public"."delivery_status");


CREATE INDEX "orders_vendor_active_idx" ON "public"."orders" USING "btree" ("vendor_id", "order_status", "created_at" DESC);


CREATE UNIQUE INDEX "orders_vendor_day_no_unique" ON "public"."orders" USING "btree" ("vendor_id", "order_day", "vendor_order_no") WHERE ("vendor_order_no" IS NOT NULL);


CREATE INDEX "orders_vendor_open_idx" ON "public"."orders" USING "btree" ("vendor_id", "created_at" DESC) WHERE ("vendor_completed_at" IS NULL);


CREATE INDEX "partner_profiles_dispatchable_idx" ON "public"."partner_profiles" USING "btree" ("user_id") WHERE (("status" = 'APPROVED'::"public"."partner_application_status") AND "is_available");


CREATE UNIQUE INDEX "partner_profiles_one_approved_per_user" ON "public"."partner_profiles" USING "btree" ("user_id") WHERE ("status" = 'APPROVED'::"public"."partner_application_status");


CREATE INDEX "partner_profiles_status_idx" ON "public"."partner_profiles" USING "btree" ("status");


CREATE INDEX "partner_ratings_low_idx" ON "public"."partner_ratings" USING "btree" ("created_at" DESC) WHERE ("stars" <= 2);


CREATE INDEX "partner_ratings_partner_idx" ON "public"."partner_ratings" USING "btree" ("partner_id", "created_at" DESC);


CREATE UNIQUE INDEX "partner_sessions_one_open_per_user" ON "public"."partner_sessions" USING "btree" ("user_id") WHERE ("ended_at" IS NULL);


CREATE INDEX "partner_sessions_user_started_idx" ON "public"."partner_sessions" USING "btree" ("user_id", "started_at" DESC);


CREATE UNIQUE INDEX "payments_idempotency_key_unique" ON "public"."payments" USING "btree" ("idempotency_key");


CREATE UNIQUE INDEX "payments_one_pending_per_order" ON "public"."payments" USING "btree" ("order_id") WHERE ("status" = 'PENDING'::"public"."payment_txn_status");


CREATE UNIQUE INDEX "payments_one_succeeded_per_order" ON "public"."payments" USING "btree" ("order_id") WHERE ("status" = 'SUCCEEDED'::"public"."payment_txn_status");


CREATE INDEX "payments_order_idx" ON "public"."payments" USING "btree" ("order_id", "created_at" DESC);


CREATE UNIQUE INDEX "payments_provider_txn_unique" ON "public"."payments" USING "btree" ("provider", "provider_transaction_id") WHERE ("provider_transaction_id" IS NOT NULL);


CREATE UNIQUE INDEX "payout_destinations_provider_code_unique" ON "public"."payout_destinations" USING "btree" ("provider", "provider_recipient_code") WHERE ("provider_recipient_code" IS NOT NULL);


CREATE UNIQUE INDEX "payout_destinations_subaccount_unique" ON "public"."payout_destinations" USING "btree" ("provider", "provider_subaccount_code") WHERE ("provider_subaccount_code" IS NOT NULL);


CREATE UNIQUE INDEX "payouts_idempotency_key_unique" ON "public"."payouts" USING "btree" ("idempotency_key");


CREATE INDEX "payouts_payee_idx" ON "public"."payouts" USING "btree" ("payee_type", "payee_id", "created_at" DESC);


CREATE UNIQUE INDEX "payouts_provider_transfer_unique" ON "public"."payouts" USING "btree" ("provider", "provider_transfer_id") WHERE ("provider_transfer_id" IS NOT NULL);


CREATE UNIQUE INDEX "payouts_run_payee_unique" ON "public"."payouts" USING "btree" ("settlement_run_id", "payee_type", "payee_id");


CREATE UNIQUE INDEX "settlement_runs_period_unique" ON "public"."settlement_runs" USING "btree" ("payee_type", "period_start", "period_end");


CREATE INDEX "terms_acceptances_user_idx" ON "public"."terms_acceptances" USING "btree" ("user_id", "audience");


CREATE UNIQUE INDEX "terms_acceptances_user_version_unique" ON "public"."terms_acceptances" USING "btree" ("user_id", "audience", "version");


CREATE UNIQUE INDEX "terms_documents_audience_version_unique" ON "public"."terms_documents" USING "btree" ("audience", "version");


CREATE UNIQUE INDEX "users_email_unique" ON "public"."users" USING "btree" ("lower"("email")) WHERE ("email" IS NOT NULL);


COMMENT ON INDEX "public"."users_email_unique" IS 'ONE EMAIL → ONE ACCOUNT IDENTITY. Not an identity key: auth.users.id is. Makes future OAuth account-linking unambiguous.';


CREATE INDEX "users_is_admin_idx" ON "public"."users" USING "btree" ("id") WHERE "is_admin";


CREATE UNIQUE INDEX "users_phone_key" ON "public"."users" USING "btree" ("phone");


CREATE UNIQUE INDEX "vendor_categories_slug_unique" ON "public"."vendor_categories" USING "btree" ("slug");


CREATE INDEX "vendor_images_vendor_idx" ON "public"."vendor_images" USING "btree" ("vendor_id", "sort_order", "created_at");


CREATE INDEX "vendors_open_idx" ON "public"."vendors" USING "btree" ("id") WHERE (("status" = 'ACTIVE'::"public"."vendor_status") AND "is_accepting_orders");


CREATE UNIQUE INDEX "vendors_owner_unique" ON "public"."vendors" USING "btree" ("owner_user_id") WHERE ("owner_user_id" IS NOT NULL);


CREATE UNIQUE INDEX "vendors_phone_key" ON "public"."vendors" USING "btree" ("phone");


CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "public"."webhook_events" USING "btree" ("provider", "event_id");


CREATE INDEX "webhook_events_status_idx" ON "public"."webhook_events" USING "btree" ("status", "received_at" DESC);


CREATE OR REPLACE TRIGGER "admin_actions_append_only" BEFORE DELETE OR UPDATE ON "public"."admin_actions" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_mutation"();


CREATE CONSTRAINT TRIGGER "allocations_must_balance" AFTER INSERT OR DELETE OR UPDATE ON "public"."allocations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."check_allocations_balance"();


CREATE OR REPLACE TRIGGER "allocations_set_updated_at" BEFORE UPDATE ON "public"."allocations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "customer_profiles_set_updated_at" BEFORE UPDATE ON "public"."customer_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "locations_no_cycles" BEFORE INSERT OR UPDATE OF "parent_id" ON "public"."locations" FOR EACH ROW EXECUTE FUNCTION "public"."locations_prevent_cycle"();


CREATE OR REPLACE TRIGGER "locations_set_updated_at" BEFORE UPDATE ON "public"."locations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "menu_items_set_updated_at" BEFORE UPDATE ON "public"."menu_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "notification_events_append_only" BEFORE DELETE OR UPDATE ON "public"."notification_events" FOR EACH ROW EXECUTE FUNCTION "public"."notification_events_append_only"();


CREATE OR REPLACE TRIGGER "order_events_append_only" BEFORE DELETE OR UPDATE ON "public"."order_events" FOR EACH ROW EXECUTE FUNCTION "public"."order_events_append_only"();


CREATE OR REPLACE TRIGGER "order_scans_set_updated_at" BEFORE UPDATE ON "public"."order_scans" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "order_secrets_set_updated_at" BEFORE UPDATE ON "public"."order_secrets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "orders_award_customer_reward" AFTER UPDATE OF "order_status" ON "public"."orders" FOR EACH ROW WHEN ((("new"."order_status" = 'COMPLETED'::"public"."order_status") AND ("old"."order_status" IS DISTINCT FROM 'COMPLETED'::"public"."order_status"))) EXECUTE FUNCTION "public"."orders_award_customer_reward"();


CREATE OR REPLACE TRIGGER "orders_release_scan_on_assignment" BEFORE UPDATE OF "partner_id", "delivery_status" ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."release_scan_on_assignment"();


CREATE OR REPLACE TRIGGER "orders_set_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "partner_availability_follows_status" BEFORE INSERT OR UPDATE OF "status", "is_available" ON "public"."partner_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."partner_availability_follows_status"();


CREATE OR REPLACE TRIGGER "partner_profiles_set_updated_at" BEFORE UPDATE ON "public"."partner_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payments_set_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payout_destinations_set_updated_at" BEFORE UPDATE ON "public"."payout_destinations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payouts_set_updated_at" BEFORE UPDATE ON "public"."payouts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "pricing_config_set_updated_at" BEFORE UPDATE ON "public"."pricing_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."customer_rewards" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "set_vendor_categories_updated_at" BEFORE UPDATE ON "public"."vendor_categories" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "settlement_runs_set_updated_at" BEFORE UPDATE ON "public"."settlement_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "users_sync_full_name" BEFORE INSERT OR UPDATE OF "first_name", "last_name", "full_name" ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."users_sync_full_name"();


CREATE OR REPLACE TRIGGER "vendors_set_updated_at" BEFORE UPDATE ON "public"."vendors" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."allocations"
    ADD CONSTRAINT "allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."allocations"
    ADD CONSTRAINT "allocations_settlement_run_fk" FOREIGN KEY ("settlement_run_id") REFERENCES "public"."settlement_runs"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."customer_profiles"
    ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."customer_rewards"
    ADD CONSTRAINT "customer_rewards_fulfilled_by_fkey" FOREIGN KEY ("fulfilled_by") REFERENCES "public"."users"("id");


ALTER TABLE ONLY "public"."customer_rewards"
    ADD CONSTRAINT "customer_rewards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."idempotency_keys"
    ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."notification_events"
    ADD CONSTRAINT "notification_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."order_events"
    ADD CONSTRAINT "order_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."order_events"
    ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."order_scans"
    ADD CONSTRAINT "order_scans_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."order_scans"
    ADD CONSTRAINT "order_scans_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."order_scans"
    ADD CONSTRAINT "order_scans_redeemed_by_fkey" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."order_scans"
    ADD CONSTRAINT "order_scans_released_to_fkey" FOREIGN KEY ("released_to") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."order_secrets"
    ADD CONSTRAINT "order_secrets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_destination_zone_id_fkey" FOREIGN KEY ("destination_zone_id") REFERENCES "public"."locations"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."partner_profiles"
    ADD CONSTRAINT "partner_profiles_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id");


ALTER TABLE ONLY "public"."partner_profiles"
    ADD CONSTRAINT "partner_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."partner_ratings"
    ADD CONSTRAINT "partner_ratings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id");


ALTER TABLE ONLY "public"."partner_ratings"
    ADD CONSTRAINT "partner_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."partner_ratings"
    ADD CONSTRAINT "partner_ratings_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "public"."users"("id");


ALTER TABLE ONLY "public"."partner_profiles"
    ADD CONSTRAINT "partner_requires_customer" FOREIGN KEY ("user_id") REFERENCES "public"."customer_profiles"("user_id") ON DELETE RESTRICT;


COMMENT ON CONSTRAINT "partner_requires_customer" ON "public"."partner_profiles" IS 'A Partner is always also a Customer. The Customer capability cannot be removed from under an existing Partner profile.';


ALTER TABLE ONLY "public"."partner_sessions"
    ADD CONSTRAINT "partner_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."payouts"
    ADD CONSTRAINT "payouts_settlement_run_id_fkey" FOREIGN KEY ("settlement_run_id") REFERENCES "public"."settlement_runs"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."settlement_runs"
    ADD CONSTRAINT "settlement_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_terms_id_fkey" FOREIGN KEY ("terms_id") REFERENCES "public"."terms_documents"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."terms_acceptances"
    ADD CONSTRAINT "terms_acceptances_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."vendor_images"
    ADD CONSTRAINT "vendor_images_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."vendor_images"
    ADD CONSTRAINT "vendor_images_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."vendor_order_counters"
    ADD CONSTRAINT "vendor_order_counters_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."vendor_categories"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


ALTER TABLE "public"."admin_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allocations_read_admin" ON "public"."allocations" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "allocations_read_partner" ON "public"."allocations" FOR SELECT TO "authenticated" USING ((("payee_type" = 'PARTNER'::"public"."payee_type") AND ("payee_id" = "auth"."uid"())));


CREATE POLICY "allocations_read_vendor" ON "public"."allocations" FOR SELECT TO "authenticated" USING ((("payee_type" = 'VENDOR'::"public"."payee_type") AND ("payee_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids"))));


ALTER TABLE "public"."customer_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_profiles_read_admin" ON "public"."customer_profiles" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "customer_profiles_read_self" ON "public"."customer_profiles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));


ALTER TABLE "public"."customer_rewards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "customer_rewards_read_admin" ON "public"."customer_rewards" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "customer_rewards_read_self" ON "public"."customer_rewards" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));


ALTER TABLE "public"."idempotency_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "locations_read_active" ON "public"."locations" FOR SELECT TO "authenticated", "anon" USING (("is_active" OR "public"."is_admin"()));


ALTER TABLE "public"."menu_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "menu_items_read_admin" ON "public"."menu_items" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "menu_items_read_own" ON "public"."menu_items" FOR SELECT TO "authenticated" USING ("public"."is_vendor_staff"("vendor_id"));


CREATE POLICY "menu_items_read_public" ON "public"."menu_items" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."vendors" "v"
  WHERE (("v"."id" = "menu_items"."vendor_id") AND ("v"."status" = 'ACTIVE'::"public"."vendor_status")))));


ALTER TABLE "public"."notification_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_events_read" ON "public"."order_events" FOR SELECT TO "authenticated" USING (("public"."is_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_events"."order_id") AND ("o"."customer_id" = "auth"."uid"()))))));


ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_items_read" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND (("o"."customer_id" = "auth"."uid"()) OR ("o"."partner_id" = "auth"."uid"()) OR "public"."is_admin"())))));


ALTER TABLE "public"."order_scans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_scans_read_authorised" ON "public"."order_scans" FOR SELECT TO "authenticated" USING ((("customer_id" = "auth"."uid"()) OR "public"."partner_may_read_scan"("order_id") OR "public"."is_admin"() OR "public"."vendor_may_read_scan"("order_id")));


ALTER TABLE "public"."order_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_read_admin" ON "public"."orders" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "orders_read_assigned_partner" ON "public"."orders" FOR SELECT TO "authenticated" USING (("partner_id" = "auth"."uid"()));


CREATE POLICY "orders_read_customer" ON "public"."orders" FOR SELECT TO "authenticated" USING (("customer_id" = "auth"."uid"()));


ALTER TABLE "public"."partner_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_profiles_read_admin" ON "public"."partner_profiles" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "partner_profiles_read_self" ON "public"."partner_profiles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));


ALTER TABLE "public"."partner_ratings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_ratings_read_admin" ON "public"."partner_ratings" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "partner_ratings_read_customer" ON "public"."partner_ratings" FOR SELECT TO "authenticated" USING (("customer_id" = "auth"."uid"()));


ALTER TABLE "public"."partner_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_sessions_own" ON "public"."partner_sessions" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payments_read_admin" ON "public"."payments" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "payments_read_customer" ON "public"."payments" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "payments"."order_id") AND ("o"."customer_id" = "auth"."uid"())))));


ALTER TABLE "public"."payout_destinations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payouts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payouts_read_admin" ON "public"."payouts" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "payouts_read_own" ON "public"."payouts" FOR SELECT TO "authenticated" USING (((("payee_type" = 'PARTNER'::"public"."payee_type") AND ("payee_id" = "auth"."uid"())) OR (("payee_type" = 'VENDOR'::"public"."payee_type") AND ("payee_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids")))));


ALTER TABLE "public"."pricing_config" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pricing_config_read_all" ON "public"."pricing_config" FOR SELECT TO "authenticated", "anon" USING (true);


ALTER TABLE "public"."settlement_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "settlement_runs_read_admin" ON "public"."settlement_runs" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


ALTER TABLE "public"."terms_acceptances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_acceptances_read_own" ON "public"."terms_acceptances" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));


ALTER TABLE "public"."terms_documents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "terms_documents_read_published" ON "public"."terms_documents" FOR SELECT TO "authenticated", "anon" USING ((("published_at" IS NOT NULL) OR "public"."is_admin"()));


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "users_read_admin" ON "public"."users" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "users_read_customer_during_active_delivery" ON "public"."users" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."customer_id" = "users"."id") AND ("o"."partner_id" = "auth"."uid"()) AND ("o"."delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status"]))))));


CREATE POLICY "users_read_partner_during_active_delivery" ON "public"."users" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."partner_id" = "users"."id") AND ("o"."customer_id" = "auth"."uid"()) AND ("o"."delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status"]))))));


CREATE POLICY "users_read_self" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));


ALTER TABLE "public"."vendor_categories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_categories_read_active" ON "public"."vendor_categories" FOR SELECT TO "authenticated", "anon" USING (("is_active" OR "public"."is_admin"()));


ALTER TABLE "public"."vendor_images" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_images_read_admin" ON "public"."vendor_images" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "vendor_images_read_own" ON "public"."vendor_images" FOR SELECT TO "authenticated" USING ("public"."is_vendor_staff"("vendor_id"));


CREATE POLICY "vendor_images_read_public" ON "public"."vendor_images" FOR SELECT TO "authenticated", "anon" USING ((EXISTS ( SELECT 1
   FROM "public"."vendors" "v"
  WHERE (("v"."id" = "vendor_images"."vendor_id") AND ("v"."status" = 'ACTIVE'::"public"."vendor_status")))));


ALTER TABLE "public"."vendor_order_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vendors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendors_read_active" ON "public"."vendors" FOR SELECT TO "authenticated", "anon" USING (("status" = 'ACTIVE'::"public"."vendor_status"));


CREATE POLICY "vendors_read_admin" ON "public"."vendors" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "vendors_read_own" ON "public"."vendors" FOR SELECT TO "authenticated" USING ("public"."is_vendor_staff"("id"));


ALTER TABLE "public"."webhook_events" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


GRANT ALL ON TABLE "public"."terms_acceptances" TO "service_role";
GRANT SELECT ON TABLE "public"."terms_acceptances" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."accept_terms"("p_terms_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_terms"("p_terms_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."accept_terms"("p_terms_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."active_vendor_categories"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."active_vendor_categories"() TO "service_role";
GRANT ALL ON FUNCTION "public"."active_vendor_categories"() TO "anon";
GRANT ALL ON FUNCTION "public"."active_vendor_categories"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."next_order_number"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."next_order_number"() TO "service_role";


GRANT ALL ON TABLE "public"."orders" TO "service_role";
GRANT SELECT ON TABLE "public"."orders" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_cancel_order"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_cancel_order"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_cancel_order"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."partner_profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."partner_profiles" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_clear_partner_documents"("p_user_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_clear_partner_documents"("p_user_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_clear_partner_documents"("p_user_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_complete_order"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_complete_order"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_complete_order"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."locations" TO "service_role";
GRANT SELECT ON TABLE "public"."locations" TO "authenticated";
GRANT SELECT ON TABLE "public"."locations" TO "anon";


REVOKE ALL ON FUNCTION "public"."admin_create_location"("p_kind" "public"."location_kind", "p_name" "text", "p_reason" "text", "p_parent_id" "uuid", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_location"("p_kind" "public"."location_kind", "p_name" "text", "p_reason" "text", "p_parent_id" "uuid", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_location"("p_kind" "public"."location_kind", "p_name" "text", "p_reason" "text", "p_parent_id" "uuid", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "authenticated";


GRANT ALL ON TABLE "public"."menu_items" TO "service_role";
GRANT SELECT ON TABLE "public"."menu_items" TO "authenticated";
GRANT SELECT ON TABLE "public"."menu_items" TO "anon";


REVOKE ALL ON FUNCTION "public"."admin_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_reason" "text", "p_description" "text", "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_reason" "text", "p_description" "text", "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_reason" "text", "p_description" "text", "p_sort_order" integer) TO "authenticated";


GRANT ALL ON TABLE "public"."vendors" TO "service_role";
GRANT SELECT ON TABLE "public"."vendors" TO "authenticated";
GRANT SELECT ON TABLE "public"."vendors" TO "anon";


REVOKE ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text", "p_category_id" "uuid", "p_description" "text", "p_owner_is_student" boolean, "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text", "p_category_id" "uuid", "p_description" "text", "p_owner_is_student" boolean, "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_vendor_account"("p_owner_user_id" "uuid", "p_store_name" "text", "p_reason" "text", "p_applicant_name" "text", "p_category_id" "uuid", "p_description" "text", "p_owner_is_student" boolean, "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "authenticated";


GRANT ALL ON TABLE "public"."vendor_categories" TO "service_role";
GRANT SELECT ON TABLE "public"."vendor_categories" TO "anon";
GRANT SELECT ON TABLE "public"."vendor_categories" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_create_vendor_category"("p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_vendor_category"("p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_vendor_category"("p_slug" "text", "p_name" "text", "p_sort_order" integer, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_customer_detail"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_customer_detail"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_customer_detail"("p_user_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_customer_rewards"("p_status" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_customer_rewards"("p_status" "text", "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_customer_rewards"("p_status" "text", "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_customer_summary"("p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_customer_summary"("p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_customer_summary"("p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_customers"("p_search" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone, "p_min_orders" integer, "p_active" boolean, "p_fulfilment" "public"."fulfilment_type", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_customers"("p_search" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone, "p_min_orders" integer, "p_active" boolean, "p_fulfilment" "public"."fulfilment_type", "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_customers"("p_search" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_joined_since" timestamp with time zone, "p_min_orders" integer, "p_active" boolean, "p_fulfilment" "public"."fulfilment_type", "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_dashboard"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_dashboard"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_dashboard"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_dashboard_totals"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_dashboard_totals"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_dashboard_totals"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_customer"("p_user_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_vendor"("p_vendor_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_exceptions"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_exceptions"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_exceptions"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_ledger"("p_order_type" "text", "p_payee_type" "text", "p_allocation_status" "text", "p_payout_status" "text", "p_vendor_id" "uuid", "p_payee_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_ledger"("p_order_type" "text", "p_payee_type" "text", "p_allocation_status" "text", "p_payout_status" "text", "p_vendor_id" "uuid", "p_payee_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_ledger"("p_order_type" "text", "p_payee_type" "text", "p_allocation_status" "text", "p_payout_status" "text", "p_vendor_id" "uuid", "p_payee_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_ledger_totals"("p_order_type" "text", "p_since" timestamp with time zone, "p_until" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_ledger_totals"("p_order_type" "text", "p_since" timestamp with time zone, "p_until" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_ledger_totals"("p_order_type" "text", "p_since" timestamp with time zone, "p_until" timestamp with time zone) TO "authenticated";


GRANT ALL ON TABLE "public"."admin_actions" TO "service_role";


REVOKE ALL ON FUNCTION "public"."admin_list_actions"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_actions"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_list_actions"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_mark_refunded"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_mark_refunded"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_mark_refunded"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."notification_events" TO "service_role";


REVOKE ALL ON FUNCTION "public"."admin_notification_log"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_notification_log"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_notification_log"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer, "p_order_type" "text", "p_order_status" "text", "p_payment_status" "text", "p_partner_state" "text", "p_vendor_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_search" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer, "p_order_type" "text", "p_order_status" "text", "p_payment_status" "text", "p_partner_state" "text", "p_vendor_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_search" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer, "p_order_type" "text", "p_order_status" "text", "p_payment_status" "text", "p_partner_state" "text", "p_vendor_id" "uuid", "p_since" timestamp with time zone, "p_until" timestamp with time zone, "p_search" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_order_board_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_board_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_board_summary"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_activity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_activity"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_activity"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_balances"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_balances"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_balances"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_detail"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_detail"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_detail"("p_user_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_ratings"("p_partner_id" "uuid", "p_max_stars" smallint, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_ratings"("p_partner_id" "uuid", "p_max_stars" smallint, "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_ratings"("p_partner_id" "uuid", "p_max_stars" smallint, "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partners"("p_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partners"("p_status" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partners"("p_status" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payout_destinations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payout_destinations"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payout_destinations"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payout_history"("p_payee_type" "public"."payee_type", "p_status" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payout_history"("p_payee_type" "public"."payee_type", "p_status" "text", "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payout_history"("p_payee_type" "public"."payee_type", "p_status" "text", "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payout_readiness"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payout_readiness"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payout_readiness"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payouts_awaiting_settlement"("p_payee_type" "public"."payee_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_purge_test_accounts"("p_user_ids" "uuid"[], "p_reason" "text") FROM PUBLIC;


REVOKE ALL ON FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[], "p_order_ids" "uuid"[], "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[], "p_order_ids" "uuid"[], "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_purge_test_history"("p_user_ids" "uuid"[], "p_order_ids" "uuid"[], "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_review_vendor"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_review_vendor"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_review_vendor"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_scan_order"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_scheduled_job_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_scheduled_job_status"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_scheduled_job_status"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_set_location_active"("p_location_id" "uuid", "p_active" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_location_active"("p_location_id" "uuid", "p_active" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_location_active"("p_location_id" "uuid", "p_active" boolean, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."payout_destinations" TO "service_role";


REVOKE ALL ON FUNCTION "public"."admin_set_payout_destination"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_payout_destination"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_payout_destination"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text", "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."users" TO "service_role";
GRANT SELECT ON TABLE "public"."users" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_set_user_suspended"("p_user_id" "uuid", "p_suspended" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_user_suspended"("p_user_id" "uuid", "p_suspended" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_user_suspended"("p_user_id" "uuid", "p_suspended" boolean, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_set_vendor_scans"("p_vendor_id" "uuid", "p_accepts" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_vendor_scans"("p_vendor_id" "uuid", "p_accepts" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_vendor_scans"("p_vendor_id" "uuid", "p_accepts" boolean, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."customer_rewards" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_rewards" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_settle_customer_reward"("p_reward_id" "uuid", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_settle_customer_reward"("p_reward_id" "uuid", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_settle_customer_reward"("p_reward_id" "uuid", "p_notes" "text") TO "authenticated";


GRANT ALL ON TABLE "public"."payouts" TO "service_role";
GRANT SELECT ON TABLE "public"."payouts" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_settle_payout_manually"("p_payout_id" "uuid", "p_reference" "text", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_settlement_overview"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_settlement_overview"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_settlement_overview"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_settlement_payouts"("p_run_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_settlement_payouts"("p_run_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_settlement_payouts"("p_run_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_settlement_runs"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_settlement_runs"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_settlement_runs"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_undelivered_notifications"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_undelivered_notifications"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_undelivered_notifications"("p_limit" integer) TO "authenticated";


GRANT ALL ON TABLE "public"."pricing_config" TO "service_role";
GRANT SELECT ON TABLE "public"."pricing_config" TO "authenticated";
GRANT SELECT ON TABLE "public"."pricing_config" TO "anon";


REVOKE ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer, "p_scan_service_fee_pesewas" bigint, "p_max_active_deliveries_per_partner" smallint, "p_partner_min_payout_pesewas" bigint, "p_partner_delivery_enabled" boolean, "p_scan_pack_fee_pesewas" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer, "p_scan_service_fee_pesewas" bigint, "p_max_active_deliveries_per_partner" smallint, "p_partner_min_payout_pesewas" bigint, "p_partner_delivery_enabled" boolean, "p_scan_pack_fee_pesewas" bigint) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer, "p_scan_service_fee_pesewas" bigint, "p_max_active_deliveries_per_partner" smallint, "p_partner_min_payout_pesewas" bigint, "p_partner_delivery_enabled" boolean, "p_scan_pack_fee_pesewas" bigint) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_category_id" "uuid", "p_description" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_category_id" "uuid", "p_description" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_category_id" "uuid", "p_description" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_vendor_category"("p_category_id" "uuid", "p_name" "text", "p_sort_order" integer, "p_is_active" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_vendor_category"("p_category_id" "uuid", "p_name" "text", "p_sort_order" integer, "p_is_active" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_vendor_category"("p_category_id" "uuid", "p_name" "text", "p_sort_order" integer, "p_is_active" boolean, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_vendor_categories"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_vendor_categories"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_vendor_categories"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_vendors"("p_search" "text", "p_status" "text", "p_category_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_vendors"("p_search" "text", "p_status" "text", "p_category_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_vendors"("p_search" "text", "p_status" "text", "p_category_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."assert_service_or_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_service_or_admin"() TO "service_role";


GRANT ALL ON TABLE "public"."payments" TO "service_role";
GRANT SELECT ON TABLE "public"."payments" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."attach_payment_split"("p_payment_id" "uuid", "p_subaccount_code" "text", "p_vendor_pesewas" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payment_split"("p_payment_id" "uuid", "p_subaccount_code" "text", "p_vendor_pesewas" bigint) TO "service_role";


REVOKE ALL ON FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."attach_payout_subaccount"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_subaccount_code" "text", "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payout_subaccount"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_subaccount_code" "text", "p_error" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."check_allocations_balance"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_allocations_balance"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."check_handoff_code"("p_order_id" "uuid", "p_kind" "text", "p_supplied" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_handoff_code"("p_order_id" "uuid", "p_kind" "text", "p_supplied" "text") TO "service_role";


GRANT ALL ON TABLE "public"."customer_profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."customer_profiles" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_terms_id" "uuid", "p_student_id_number" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_terms_id" "uuid", "p_student_id_number" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."complete_customer_onboarding"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender", "p_terms_id" "uuid", "p_student_id_number" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."confirm_payment"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_amount_pesewas" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_payment"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_amount_pesewas" bigint) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_payment_intent"("p_order_id" "uuid", "p_provider" "text", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_payment_intent"("p_order_id" "uuid", "p_provider" "text", "p_idempotency_key" "text") TO "service_role";


GRANT ALL ON TABLE "public"."settlement_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."settlement_runs" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."create_settlement_run"("p_payee_type" "public"."payee_type", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_settlement_run"("p_payee_type" "public"."payee_type", "p_period_start" timestamp with time zone, "p_period_end" timestamp with time zone) TO "service_role";


REVOKE ALL ON FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") TO "service_role";
GRANT ALL ON FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") TO "anon";
GRANT ALL ON FUNCTION "public"."current_terms"("p_audience" "public"."terms_audience") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."current_user_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "service_role";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_user_id"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_abandon_stuck_payment"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_abandon_stuck_payment"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_abandon_stuck_payment"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_abandon_unpaid_order"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_choose_fulfilment"("p_order_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_complete_pickup"("p_order_id" "uuid", "p_pickup_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_complete_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_complete_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_dispute_delivery"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_dispute_delivery"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_dispute_delivery"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_keep_waiting"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_keep_waiting"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_keep_waiting"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_order_list"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_order_list"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_order_list"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status", "p_fulfilment_type" "public"."fulfilment_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_rate_partner"("p_order_id" "uuid", "p_stars" smallint, "p_comment" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_rate_partner"("p_order_id" "uuid", "p_stars" smallint, "p_comment" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_rate_partner"("p_order_id" "uuid", "p_stars" smallint, "p_comment" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."customer_reward_milestones"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_reward_milestones"() TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_reward_milestones"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."deliverable_locations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deliverable_locations"() TO "service_role";
GRANT ALL ON FUNCTION "public"."deliverable_locations"() TO "anon";
GRANT ALL ON FUNCTION "public"."deliverable_locations"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."expire_partner_search"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_partner_search"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."expire_stale_orders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_stale_orders"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."expire_stale_payments"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."expire_stale_payments"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."fail_payment"("p_payment_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_payment"("p_payment_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."forbid_mutation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."forbid_mutation"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."fulfilment_options"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fulfilment_options"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."fulfilment_options"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."generate_numeric_code"("p_digits" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_numeric_code"("p_digits" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_delivery_offers"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_delivery_offers"() TO "service_role";
GRANT ALL ON FUNCTION "public"."get_delivery_offers"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."get_my_delivery_code"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_delivery_code"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."get_my_delivery_code"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."given_name"("p_first" "text", "p_full" "text") TO "anon";


REVOKE ALL ON FUNCTION "public"."handle_auth_user_phone_confirmed"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_auth_user_phone_confirmed"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."handle_new_auth_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."is_approved_partner"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_approved_partner"("p_user_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_customer"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_customer"("p_user_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_customer"("p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_customer"("p_user_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."is_service_or_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_service_or_admin"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."location_floor"("p_location_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."location_floor"("p_location_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."location_floor"("p_location_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."location_floor"("p_location_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."location_path"("p_location_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."location_path"("p_location_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."location_path"("p_location_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."location_path"("p_location_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."location_zone"("p_location_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."location_zone"("p_location_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."location_zone"("p_location_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."location_zone"("p_location_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."locations_prevent_cycle"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."locations_prevent_cycle"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."log_admin_action"("p_action" "text", "p_target_type" "text", "p_target_id" "uuid", "p_reason" "text", "p_before" "jsonb", "p_after" "jsonb", "p_details" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_admin_action"("p_action" "text", "p_target_type" "text", "p_target_id" "uuid", "p_reason" "text", "p_before" "jsonb", "p_after" "jsonb", "p_details" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."log_order_event"("p_order_id" "uuid", "p_event" "text", "p_accepted" boolean, "p_actor_role" "text", "p_dimension" "text", "p_from" "text", "p_to" "text", "p_reason" "text", "p_details" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_order_event"("p_order_id" "uuid", "p_event" "text", "p_accepted" boolean, "p_actor_role" "text", "p_dimension" "text", "p_from" "text", "p_to" "text", "p_reason" "text", "p_details" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_payment_failed_internal"("p_payment_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_payment_failed_internal"("p_payment_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_payout_paid"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text", "p_amount_pesewas" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_payout_paid"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text", "p_amount_pesewas" bigint) TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_payout_processing"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_payout_processing"("p_payout_id" "uuid", "p_provider" "text", "p_provider_transfer_id" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_webhook_processed"("p_webhook_id" "uuid", "p_status" "public"."webhook_event_status", "p_error" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_webhook_processed"("p_webhook_id" "uuid", "p_status" "public"."webhook_event_status", "p_error" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."my_capabilities"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_capabilities"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_capabilities"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_customer_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_customer_profile"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_customer_profile"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_order_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_order_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_order_summary"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_outstanding_terms"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_outstanding_terms"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_outstanding_terms"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_partner_activity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_partner_activity"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_partner_activity"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_partner_application"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_partner_application"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_partner_application"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_partner_payouts"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_partner_payouts"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."my_partner_payouts"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_partner_rating"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_partner_rating"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_partner_rating"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_payout_destination"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_payout_destination"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_payout_destination"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_reward_progress"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_reward_progress"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_reward_progress"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_scan_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_scan_order"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."my_scan_order"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_vendor_application"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_vendor_application"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_vendor_application"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_vendor_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."next_vendor_order_no"("p_vendor_id" "uuid", "p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."next_vendor_order_no"("p_vendor_id" "uuid", "p_day" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."notification_events_append_only"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_events_append_only"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."order_events_append_only"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."order_events_append_only"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."orders_award_customer_reward"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."orders_award_customer_reward"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_active_delivery"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_active_delivery"() TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_active_delivery"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_apply"("p_student_id_image_path" "text", "p_terms_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_apply"("p_student_id_image_path" "text", "p_terms_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_apply"("p_student_id_image_path" "text", "p_terms_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_availability_follows_status"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_availability_follows_status"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_capacity"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_capacity"() TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_capacity"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_earnings_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_earnings_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_earnings_summary"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_may_read_scan"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_scan_brief"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_scan_brief"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_scan_brief"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partners_to_notify_of_offer"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partners_to_notify_of_offer"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_recipient_contact"("p_payout_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_recipient_contact"("p_payout_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."payout_threshold_for"("p_payee_type" "public"."payee_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."phone_can_sign_in_as_vendor"("p_phone" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."platform_config"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_config"() TO "service_role";
GRANT ALL ON FUNCTION "public"."platform_config"() TO "anon";
GRANT ALL ON FUNCTION "public"."platform_config"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_items" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."price_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."price_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."quote_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."quote_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."quote_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_wants_pack" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text", "p_provider_message_id" "text", "p_error" "text", "p_order_id" "uuid", "p_user_id" "uuid", "p_dedupe_key" "text", "p_correlation_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text", "p_provider_message_id" "text", "p_error" "text", "p_order_id" "uuid", "p_user_id" "uuid", "p_dedupe_key" "text", "p_correlation_id" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."release_scan_on_assignment"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."release_scan_on_assignment"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."retry_payout"("p_payout_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retry_payout"("p_payout_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."scan_image_path"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."scan_image_path"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."scan_image_path"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."scan_menu"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."scan_restaurants"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."scan_restaurants"() TO "service_role";
GRANT ALL ON FUNCTION "public"."scan_restaurants"() TO "anon";
GRANT ALL ON FUNCTION "public"."scan_restaurants"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."set_my_email"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_my_email"("p_email" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."set_my_email"("p_email" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."storefront_vendor"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."storefront_vendors"("p_category_id" "uuid", "p_search" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."storefront_vendors"("p_category_id" "uuid", "p_search" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."storefront_vendors"("p_category_id" "uuid", "p_search" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."storefront_vendors"("p_category_id" "uuid", "p_search" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid", "p_details" "text", "p_destination_note" "text", "p_wants_pack" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid", "p_details" "text", "p_destination_note" "text", "p_wants_pack" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."submit_scan_order"("p_vendor_id" "uuid", "p_items" "jsonb", "p_fulfilment_type" "public"."fulfilment_type", "p_scan_image_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_destination_location_id" "uuid", "p_details" "text", "p_destination_note" "text", "p_wants_pack" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."sync_my_verified_phone"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_my_verified_phone"() TO "service_role";
GRANT ALL ON FUNCTION "public"."sync_my_verified_phone"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."update_my_profile"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_my_profile"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_my_profile"("p_first_name" "text", "p_last_name" "text", "p_phone" "text", "p_affiliation" "public"."campus_affiliation", "p_graduation_year" integer, "p_gender" "public"."customer_gender") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."users_sync_full_name"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."users_sync_full_name"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_active_count"("p_vendor_id" "uuid") TO "authenticated";


GRANT ALL ON TABLE "public"."vendor_images" TO "service_role";
GRANT SELECT ON TABLE "public"."vendor_images" TO "anon";
GRANT SELECT ON TABLE "public"."vendor_images" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_add_image"("p_vendor_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint, "p_caption" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_clear_menu_item_image"("p_menu_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_clear_menu_item_image"("p_menu_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_clear_menu_item_image"("p_menu_item_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid", "p_pickup_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid", "p_pickup_code" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_create_menu_item"("p_vendor_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_daily_sales"("p_vendor_id" "uuid", "p_days" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_delete_image"("p_image_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_delete_image"("p_image_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_delete_image"("p_image_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_delete_menu_item"("p_menu_item_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_handoff_code"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_may_read_scan"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_menu"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_menu"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_menu"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_bucket_for"("p_order_status" "public"."order_status", "p_vendor_completed_at" timestamp with time zone) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_orders_on_day"("p_vendor_id" "uuid", "p_day" "date") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_owner_contact"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_owner_contact"("p_vendor_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_pickup_code"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_pickup_code"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_redeem_scan"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_redeem_scan"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_redeem_scan"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_refuse_scan"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_refuse_scan"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_refuse_scan"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_scan_image_path"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean, "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_menu_item_image"("p_menu_item_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_image"("p_menu_item_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_image"("p_menu_item_id" "uuid", "p_storage_path" "text", "p_content_type" "text", "p_byte_size" bigint) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_payout_destination"("p_vendor_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_payout_destination"("p_vendor_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_payout_destination"("p_vendor_id" "uuid", "p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_primary_image"("p_image_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_signup"("p_applicant_name" "text", "p_store_name" "text", "p_is_student" boolean, "p_description" "text", "p_category_id" "uuid", "p_terms_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_signup"("p_applicant_name" "text", "p_store_name" "text", "p_is_student" boolean, "p_description" "text", "p_category_id" "uuid", "p_terms_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_signup"("p_applicant_name" "text", "p_store_name" "text", "p_is_student" boolean, "p_description" "text", "p_category_id" "uuid", "p_terms_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_update_menu_item"("p_menu_item_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_update_menu_item"("p_menu_item_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_update_menu_item"("p_menu_item_id" "uuid", "p_name" "text", "p_price_pesewas" bigint, "p_description" "text", "p_scan_eligible" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_update_profile"("p_vendor_id" "uuid", "p_name" "text", "p_description" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_update_profile"("p_vendor_id" "uuid", "p_name" "text", "p_description" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_update_profile"("p_vendor_id" "uuid", "p_name" "text", "p_description" "text", "p_category_id" "uuid", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes" integer) TO "authenticated";


GRANT ALL ON SEQUENCE "public"."admin_actions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."admin_actions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."admin_actions_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."allocations" TO "service_role";
GRANT SELECT ON TABLE "public"."allocations" TO "authenticated";


GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";


GRANT ALL ON SEQUENCE "public"."notification_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notification_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notification_events_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."order_events" TO "service_role";
GRANT SELECT ON TABLE "public"."order_events" TO "authenticated";


GRANT ALL ON SEQUENCE "public"."order_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."order_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."order_events_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."order_items" TO "service_role";
GRANT SELECT ON TABLE "public"."order_items" TO "authenticated";


GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."order_number_seq" TO "service_role";


GRANT ALL ON TABLE "public"."order_scans" TO "service_role";
GRANT SELECT ON TABLE "public"."order_scans" TO "authenticated";


GRANT ALL ON TABLE "public"."order_secrets" TO "service_role";


GRANT ALL ON TABLE "public"."partner_ratings" TO "service_role";
GRANT SELECT ON TABLE "public"."partner_ratings" TO "authenticated";


GRANT ALL ON TABLE "public"."partner_sessions" TO "service_role";
GRANT SELECT ON TABLE "public"."partner_sessions" TO "authenticated";


GRANT ALL ON SEQUENCE "public"."partner_sessions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."partner_sessions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."partner_sessions_id_seq" TO "service_role";


GRANT ALL ON TABLE "public"."terms_documents" TO "service_role";
GRANT SELECT ON TABLE "public"."terms_documents" TO "authenticated";
GRANT SELECT ON TABLE "public"."terms_documents" TO "anon";


GRANT ALL ON TABLE "public"."vendor_order_counters" TO "service_role";


GRANT ALL ON TABLE "public"."webhook_events" TO "service_role";



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
-- Terms documents (version 1 was placeholder text; version 2 is the real text)
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
