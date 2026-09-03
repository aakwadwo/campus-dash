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
    'ACTIVE',
    'SUSPENDED'
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


CREATE TABLE IF NOT EXISTS "public"."vendor_users" (
    "vendor_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vendor_users" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_add_vendor_user"("p_vendor_id" "uuid", "p_phone" "text", "p_reason" "text") RETURNS "public"."vendor_users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user_id uuid;
  v_link    public.vendor_users%rowtype;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  select id into v_user_id from public.users where phone = p_phone;
  if v_user_id is null then
    raise exception 'no Campus Dash account for %. Ask them to sign in once first.', p_phone
      using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from public.vendors where id = p_vendor_id) then
    raise exception 'vendor not found' using errcode = 'no_data_found';
  end if;

  insert into public.vendor_users (vendor_id, user_id)
  values (p_vendor_id, v_user_id)
  on conflict (vendor_id, user_id) do nothing
  returning * into v_link;

  if v_link.vendor_id is null then
    -- Already staff. Idempotent, and not worth an audit entry.
    select * into v_link from public.vendor_users
     where vendor_id = p_vendor_id and user_id = v_user_id;
    return v_link;
  end if;

  perform public.log_admin_action(
    'VENDOR_STAFF_ADD', 'vendor', p_vendor_id, p_reason, null,
    jsonb_build_object('user_id', v_user_id, 'phone', p_phone)
  );

  return v_link;
end;
$$;


ALTER FUNCTION "public"."admin_add_vendor_user"("p_vendor_id" "uuid", "p_phone" "text", "p_reason" "text") OWNER TO "postgres";


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
    "fulfilment_type" "public"."fulfilment_type" NOT NULL,
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
    CONSTRAINT "orders_delivery_fee_pesewas_check" CHECK (("delivery_fee_pesewas" >= 0)),
    CONSTRAINT "orders_delivery_needs_destination" CHECK ((("fulfilment_type" <> 'DELIVERY'::"public"."fulfilment_type") OR ("destination_location_id" IS NOT NULL))),
    CONSTRAINT "orders_partner_earnings_pesewas_check" CHECK (("partner_earnings_pesewas" >= 0)),
    CONSTRAINT "orders_partner_earnings_within_fee" CHECK (("partner_earnings_pesewas" <= "delivery_fee_pesewas")),
    CONSTRAINT "orders_partner_matches_delivery_state" CHECK ((("partner_id" IS NOT NULL) = ("delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status", 'DELIVERED'::"public"."delivery_status", 'FAILED_CUSTOMER_ABSENT'::"public"."delivery_status"])))),
    CONSTRAINT "orders_pickup_has_no_delivery" CHECK ((("fulfilment_type" <> 'PICKUP'::"public"."fulfilment_type") OR (("delivery_fee_pesewas" = 0) AND ("partner_earnings_pesewas" = 0) AND ("delivery_status" = 'NONE'::"public"."delivery_status") AND ("partner_id" IS NULL)))),
    CONSTRAINT "orders_service_fee_pesewas_check" CHECK (("service_fee_pesewas" >= 0)),
    CONSTRAINT "orders_subtotal_pesewas_check" CHECK (("subtotal_pesewas" >= 0)),
    CONSTRAINT "orders_total_is_sum" CHECK (("total_pesewas" = (("subtotal_pesewas" + "service_fee_pesewas") + "delivery_fee_pesewas"))),
    CONSTRAINT "orders_total_pesewas_check" CHECK (("total_pesewas" >= 0))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


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
    "student_id_image_path" "text",
    "face_image_path" "text",
    "is_available" boolean DEFAULT false NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "reviewed_at" timestamp with time zone,
    "reviewed_by" "uuid",
    "review_notes" "text",
    "documents_purge_after" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "partner_reviewed_consistently" CHECK ((("status" = ANY (ARRAY['APPROVED'::"public"."partner_application_status", 'REJECTED'::"public"."partner_application_status", 'SUSPENDED'::"public"."partner_application_status"])) = (("reviewed_at" IS NOT NULL) AND ("reviewed_by" IS NOT NULL))))
);


ALTER TABLE "public"."partner_profiles" OWNER TO "postgres";


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
         face_image_path = null,
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
    CONSTRAINT "menu_items_price_pesewas_check" CHECK (("price_pesewas" > 0))
);


ALTER TABLE "public"."menu_items" OWNER TO "postgres";


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
    CONSTRAINT "vendors_phone_e164" CHECK (("phone" ~ '^\+[1-9]\d{7,14}$'::"text")),
    CONSTRAINT "vendors_walk_minutes_to_campus_check" CHECK (("walk_minutes_to_campus" >= 0))
);


ALTER TABLE "public"."vendors" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes_to_campus" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
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

  -- A vendor is created DRAFT and not accepting orders. Going live is a
  -- separate, separately-audited decision.
  insert into public.vendors (
    name, phone, status, is_accepting_orders,
    location_id, location_note, walk_minutes_to_campus
  )
  values (
    btrim(p_name), p_phone, 'DRAFT', false,
    p_location_id, p_location_note, p_walk_minutes_to_campus
  )
  returning * into v_vendor;

  perform public.log_admin_action(
    'VENDOR_CREATE', 'vendor', v_vendor.id, p_reason, null, to_jsonb(v_vendor)
  );

  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."admin_list_partner_applications"("p_status" "public"."partner_application_status" DEFAULT NULL::"public"."partner_application_status") RETURNS TABLE("user_id" "uuid", "full_name" "text", "phone" "text", "student_id_number" "text", "class_year" "text", "email" "text", "status" "public"."partner_application_status", "student_id_image_path" "text", "face_image_path" "text", "is_available" boolean, "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "reviewed_by_name" "text", "review_notes" "text", "documents_purge_after" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.user_id, u.full_name, u.phone, u.student_id_number, u.class_year, u.email, p.status,
         p.student_id_image_path, p.face_image_path, p.is_available,
         p.applied_at, p.reviewed_at, r.full_name, p.review_notes,
         p.documents_purge_after
    from public.partner_profiles p
    join public.users u on u.id = p.user_id
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


CREATE OR REPLACE FUNCTION "public"."admin_order_board"("p_filter" "text" DEFAULT NULL::"text", "p_limit" integer DEFAULT 100) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_name" "text", "customer_name" "text", "partner_name" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "total_pesewas" bigint, "attention" "text", "age_seconds" integer, "disputed" boolean, "created_at" timestamp with time zone)
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
  select s.id, s.order_number, s.vendor_name, s.customer_name, s.partner_name,
         s.order_status, s.payment_status, s.delivery_status, s.fulfilment_type,
         s.total_pesewas, s.attention,
         extract(epoch from (now() - s.created_at))::integer,
         s.disputed_at is not null and s.dispute_resolved_at is null,
         s.created_at
    from scored s
   where p_filter is null or s.attention = p_filter
   order by
     -- Problems first, then work in flight, then the settled past.
     case s.attention
       when 'DISPUTED'          then 0
       when 'CUSTOMER_ABSENT'   then 1
       when 'NO_PARTNER'        then 2
       when 'REFUND_PENDING'    then 3
       when 'PAYMENT_FAILED'    then 4
       when 'AWAITING_VENDOR'   then 5
       when 'AWAITING_PAYMENT'  then 6
       when 'SEARCHING_PARTNER' then 7
       when 'IN_PROGRESS'       then 8
       else 9
     end,
     -- Oldest first within a problem: it has been broken longest.
     s.created_at asc
   limit least(coalesce(p_limit, 100), 500);
$$;


ALTER FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer) OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."admin_order_money"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "total_pesewas" bigint, "payment_status" "public"."payment_status", "payment_id" "uuid", "payment_provider" "text", "payment_txn_status" "public"."payment_txn_status", "provider_transaction_id" "text", "paid_pesewas" bigint, "vendor_name" "text", "vendor_allocation" bigint, "platform_allocation" bigint, "partner_name" "text", "partner_allocation" bigint, "allocated_pesewas" bigint, "balances" boolean, "allocations" "jsonb")
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
         v.name,
         coalesce((select a.amount_pesewas from public.allocations a
                    where a.order_id = o.id and a.payee_type = 'VENDOR'
                      and a.status <> 'CANCELLED'), 0),
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


CREATE OR REPLACE FUNCTION "public"."admin_payout_destinations"() RETURNS TABLE("payee_type" "public"."payee_type", "payee_id" "uuid", "payee_name" "text", "momo_network" "text", "account_number" "text", "account_name" "text", "provider" "text", "provider_recipient_code" "text", "provider_synced_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select d.payee_type, d.payee_id,
         coalesce(v.name, u.full_name, u.phone),
         d.momo_network, d.account_number, d.account_name,
         d.provider, d.provider_recipient_code, d.provider_synced_at, d.updated_at
    from public.payout_destinations d
    left join public.vendors v on d.payee_type = 'VENDOR'  and v.id = d.payee_id
    left join public.users   u on d.payee_type = 'PARTNER' and u.id = d.payee_id
   where public.is_admin()
   order by d.payee_type, coalesce(v.name, u.full_name, u.phone);
$$;


ALTER FUNCTION "public"."admin_payout_destinations"() OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") RETURNS "public"."orders"
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

  update public.orders
     set partner_id = null, delivery_status = 'SEARCHING', assigned_at = null, picked_up_at = null
   where id = p_order_id
     and fulfilment_type = 'DELIVERY'
     -- FAILED_CUSTOMER_ABSENT deliberately excluded: that Partner is owed money.
     and delivery_status in ('ASSIGNED', 'PICKED_UP', 'FAILED_NO_PARTNER')
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
    jsonb_build_object('previous_partner_id', v_before.partner_id, 'pickup_code_rotated', true));
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


CREATE OR REPLACE FUNCTION "public"."admin_remove_vendor_user"("p_vendor_id" "uuid", "p_user_id" "uuid", "p_reason" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_removed integer;
begin
  if not public.is_admin() then
    raise exception 'admin privileges required' using errcode = 'insufficient_privilege';
  end if;

  delete from public.vendor_users
   where vendor_id = p_vendor_id and user_id = p_user_id;
  get diagnostics v_removed = row_count;

  if v_removed = 0 then
    return false;
  end if;

  perform public.log_admin_action(
    'VENDOR_STAFF_REMOVE', 'vendor', p_vendor_id, p_reason,
    jsonb_build_object('user_id', p_user_id), null
  );

  return true;
end;
$$;


ALTER FUNCTION "public"."admin_remove_vendor_user"("p_vendor_id" "uuid", "p_user_id" "uuid", "p_reason" "text") OWNER TO "postgres";


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
    CONSTRAINT "payout_destinations_account_name_check" CHECK (("btrim"("account_name") <> ''::"text")),
    CONSTRAINT "payout_destinations_account_number_check" CHECK (("account_number" ~ '^0[0-9]{9}$'::"text")),
    CONSTRAINT "payout_destinations_code_needs_provider" CHECK ((("provider_recipient_code" IS NULL) OR ("provider" IS NOT NULL))),
    CONSTRAINT "payout_destinations_momo_network_check" CHECK (("momo_network" = ANY (ARRAY['MTN'::"text", 'VODAFONE'::"text", 'AIRTELTIGO'::"text"]))),
    CONSTRAINT "payout_destinations_not_platform" CHECK (("payee_type" <> 'PLATFORM'::"public"."payee_type"))
);


ALTER TABLE "public"."payout_destinations" OWNER TO "postgres";


COMMENT ON TABLE "public"."payout_destinations" IS 'Where settlement money goes. Server-only: no client role holds any grant.';


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
    "service_fee_bps" integer DEFAULT 500 NOT NULL,
    CONSTRAINT "pricing_config_approved_document_retention_days_check" CHECK (("approved_document_retention_days" > 0)),
    CONSTRAINT "pricing_config_customer_absent_wait_seconds_check" CHECK (("customer_absent_wait_seconds" > 0)),
    CONSTRAINT "pricing_config_customer_poll_seconds_check" CHECK ((("customer_poll_seconds" >= 2) AND ("customer_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_delivery_fee_pesewas_check" CHECK (("delivery_fee_pesewas" >= 0)),
    CONSTRAINT "pricing_config_document_signed_url_seconds_check" CHECK ((("document_signed_url_seconds" >= 30) AND ("document_signed_url_seconds" <= 900))),
    CONSTRAINT "pricing_config_min_payout_pesewas_check" CHECK (("min_payout_pesewas" >= 0)),
    CONSTRAINT "pricing_config_notification_retry_limit_check" CHECK ((("notification_retry_limit" >= 0) AND ("notification_retry_limit" <= 10))),
    CONSTRAINT "pricing_config_partner_poll_seconds_check" CHECK ((("partner_poll_seconds" >= 2) AND ("partner_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_partner_search_seconds_check" CHECK (("partner_search_seconds" > 0)),
    CONSTRAINT "pricing_config_partner_share_of_delivery_bps_check" CHECK ((("partner_share_of_delivery_bps" >= 0) AND ("partner_share_of_delivery_bps" <= 10000))),
    CONSTRAINT "pricing_config_payment_pending_timeout_seconds_check" CHECK (("payment_pending_timeout_seconds" > 0)),
    CONSTRAINT "pricing_config_rejected_document_retention_days_check" CHECK (("rejected_document_retention_days" > 0)),
    CONSTRAINT "pricing_config_service_fee_bps_check" CHECK ((("service_fee_bps" >= 0) AND ("service_fee_bps" <= 10000))),
    CONSTRAINT "pricing_config_singleton" CHECK ("id"),
    CONSTRAINT "pricing_config_vendor_poll_seconds_check" CHECK ((("vendor_poll_seconds" >= 2) AND ("vendor_poll_seconds" <= 120))),
    CONSTRAINT "pricing_config_vendor_response_seconds_check" CHECK (("vendor_response_seconds" > 0))
);


ALTER TABLE "public"."pricing_config" OWNER TO "postgres";


COMMENT ON TABLE "public"."pricing_config" IS 'Platform configuration. Legacy name — holds timeouts and operational limits as well as fees. One row, id = true.';


COMMENT ON COLUMN "public"."pricing_config"."service_fee_bps" IS 'Campus Dash service fee, in basis points of the food subtotal. 500 = 5%.';


CREATE OR REPLACE FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer DEFAULT NULL::integer, "p_delivery_fee_pesewas" bigint DEFAULT NULL::bigint, "p_partner_share_of_delivery_bps" integer DEFAULT NULL::integer, "p_vendor_response_seconds" integer DEFAULT NULL::integer, "p_partner_search_seconds" integer DEFAULT NULL::integer, "p_customer_absent_wait_seconds" integer DEFAULT NULL::integer, "p_payment_pending_timeout_seconds" integer DEFAULT NULL::integer, "p_min_payout_pesewas" bigint DEFAULT NULL::bigint, "p_notification_retry_limit" integer DEFAULT NULL::integer, "p_vendor_poll_seconds" integer DEFAULT NULL::integer, "p_partner_poll_seconds" integer DEFAULT NULL::integer, "p_customer_poll_seconds" integer DEFAULT NULL::integer) RETURNS "public"."pricing_config"
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

  select * into v_before from public.pricing_config where id;

  update public.pricing_config
     set service_fee_bps                 = coalesce(p_service_fee_bps, service_fee_bps),
         delivery_fee_pesewas            = coalesce(p_delivery_fee_pesewas, delivery_fee_pesewas),
         partner_share_of_delivery_bps   = coalesce(p_partner_share_of_delivery_bps, partner_share_of_delivery_bps),
         vendor_response_seconds         = coalesce(p_vendor_response_seconds, vendor_response_seconds),
         partner_search_seconds          = coalesce(p_partner_search_seconds, partner_search_seconds),
         customer_absent_wait_seconds    = coalesce(p_customer_absent_wait_seconds, customer_absent_wait_seconds),
         payment_pending_timeout_seconds = coalesce(p_payment_pending_timeout_seconds, payment_pending_timeout_seconds),
         min_payout_pesewas              = coalesce(p_min_payout_pesewas, min_payout_pesewas),
         notification_retry_limit        = coalesce(p_notification_retry_limit, notification_retry_limit),
         vendor_poll_seconds             = coalesce(p_vendor_poll_seconds, vendor_poll_seconds),
         partner_poll_seconds            = coalesce(p_partner_poll_seconds, partner_poll_seconds),
         customer_poll_seconds           = coalesce(p_customer_poll_seconds, customer_poll_seconds)
   where id
  returning * into v_after;

  perform public.log_admin_action(
    'CONFIG_UPDATE', 'pricing_config', null, p_reason,
    to_jsonb(v_before), to_jsonb(v_after)
  );

  return v_after;
end;
$$;


ALTER FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer) OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_location_id" "uuid" DEFAULT NULL::"uuid", "p_location_note" "text" DEFAULT NULL::"text", "p_walk_minutes_to_campus" integer DEFAULT NULL::integer) RETURNS "public"."vendors"
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


ALTER FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) OWNER TO "postgres";


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
    CONSTRAINT "payments_amount_pesewas_check" CHECK (("amount_pesewas" > 0)),
    CONSTRAINT "payments_currency_check" CHECK (("currency" = 'GHS'::"text"))
);


ALTER TABLE "public"."payments" OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."confirm_payment"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_amount_pesewas" bigint) RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_payment public.payments%rowtype;
  v_order   public.orders%rowtype;
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
  v_platform bigint;
  v_count    integer := 0;
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

  -- At payment time NO PARTNER EXISTS YET — dispatch has not even opened. So we
  -- allocate in two rows now, and the Partner's share is carved out of the
  -- platform row later, at the moment a Partner actually earns it
  -- (see settle_partner_earnings). The two rows always sum to the total, so the
  -- balance constraint holds at every step.
  v_platform := v_order.total_pesewas - v_order.subtotal_pesewas;

  -- The vendor cooked the food; their money is eligible on payment, regardless
  -- of how the delivery later turns out.
  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'VENDOR', v_order.vendor_id, v_order.subtotal_pesewas, 'ELIGIBLE');
  v_count := v_count + 1;

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'PLATFORM', null, v_platform, 'ELIGIBLE');
  v_count := v_count + 1;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."create_order_allocations"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_payment_intent"("p_order_id" "uuid", "p_provider" "text", "p_idempotency_key" "text") RETURNS "public"."payments"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order   public.orders%rowtype;
  v_payment public.payments%rowtype;
begin
  perform public.assert_service_or_admin();

  -- Idempotent replay.
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

  -- Payment is only collected AFTER the vendor accepts. An expired or rejected
  -- order is never charged.
  if v_order.order_status <> 'ACCEPTED' then
    raise exception 'order must be ACCEPTED before payment (is %)', v_order.order_status
      using errcode = 'check_violation';
  end if;
  if v_order.payment_status not in ('UNPAID', 'FAILED') then
    raise exception 'order payment is already % ', v_order.payment_status
      using errcode = 'check_violation';
  end if;

  -- The amount comes from the ORDER, which the server calculated and snapshotted.
  -- No caller supplies it.
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

  select coalesce(min_payout_pesewas, 0) into v_minimum
    from public.pricing_config where id;

  -- A payout is only ever created for a positive amount, so the effective floor
  -- is at least one pesewa. Without this a payee summing to exactly zero would
  -- be claimed and then left behind by the `having sum > 0` filter below —
  -- the same stranding, at a different amount.
  v_minimum := greatest(coalesce(v_minimum, 0), 1);

  insert into public.settlement_runs (payee_type, period_start, period_end, status, created_by)
  values (p_payee_type, p_period_start, p_period_end, 'PROCESSING', auth.uid())
  returning * into v_run;

  -- Claim everything eligible up to the end of the period. No lower bound: see
  -- the header. Anything older than this period is either already claimed by
  -- the run that took it, or was deliberately released back — deferred, failed
  -- or reversed — and is exactly what should be swept up now.
  update public.allocations a
     set settlement_run_id = v_run.id, status = 'SETTLING'
    from public.orders o
   where a.order_id = o.id
     and a.payee_type = p_payee_type
     and a.status = 'ELIGIBLE'
     and a.settlement_run_id is null
     and o.created_at < p_period_end;

  -- Below the threshold a transfer costs more in fees than it moves. The claim
  -- is released in the same transaction that took it, so the money is never
  -- attached to a payout that will not be sent, and shows up as owed again the
  -- moment this function returns.
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

  perform public.log_order_event(p_order_id, 'CUSTOMER_WILL_COLLECT', true, 'CUSTOMER',
    'delivery_status', 'SEARCHING', 'NONE',
    'customer chose to collect; delivery fee refund is an admin decision');

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_name" "text", "stage" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "total_pesewas" bigint, "destination" "text", "destination_note" "text", "submitted_at" timestamp with time zone, "seconds_to_deadline" integer, "accepted_at" timestamp with time zone, "ready_at" timestamp with time zone, "completed_at" timestamp with time zone, "cancellation_reason" "text", "payment_id" "uuid", "payment_txn_status" "public"."payment_txn_status", "partner_name" "text", "partner_phone" "text", "delivery_code" "text", "disputed" boolean, "dispute_reason" "text", "items" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, v.name,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         o.subtotal_pesewas, o.service_fee_pesewas, o.delivery_fee_pesewas, o.total_pesewas,
         case when o.fulfilment_type = 'DELIVERY'
              then public.location_path(o.destination_location_id) end,
         o.destination_note,
         o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.accepted_at, o.ready_at, o.completed_at, o.cancellation_reason,
         (select p.id from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         (select p.status from public.payments p
           where p.order_id = o.id and p.status in ('PENDING', 'SUCCEEDED')
           order by p.created_at desc limit 1),
         -- Only while a Partner is actually carrying this order.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.full_name end,
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then pu.phone end,
         -- The code the customer reads out on arrival. Shown from assignment,
         -- and withheld once the delivery is over — it has no further use.
         case when o.delivery_status in ('ASSIGNED', 'PICKED_UP') then s.delivery_code end,
         o.disputed_at is not null and o.dispute_resolved_at is null,
         o.dispute_reason,
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
   where o.id = p_order_id
     and o.customer_id = auth.uid()
     and o.order_status <> 'DRAFT';
$$;


ALTER FUNCTION "public"."customer_order_detail"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_order_list"("p_limit" integer DEFAULT 30) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_name" "text", "stage" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "item_count" bigint, "total_pesewas" bigint, "submitted_at" timestamp with time zone, "seconds_to_deadline" integer, "cancellation_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, v.name,
         public.customer_order_stage(o.order_status, o.payment_status, o.delivery_status),
         o.order_status, o.payment_status, o.delivery_status, o.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = o.id),
         o.total_pesewas, o.submitted_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         o.cancellation_reason
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
   where o.customer_id = auth.uid() and o.order_status <> 'DRAFT'
   order by o.created_at desc
   limit least(coalesce(p_limit, 30), 100);
$$;


ALTER FUNCTION "public"."customer_order_list"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status" DEFAULT 'NONE'::"public"."delivery_status") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when p_order_status = 'SUBMITTED'                                 then 'AWAITING_VENDOR'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'UNPAID'   then 'PAYMENT_REQUIRED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'FAILED'   then 'PAYMENT_FAILED'
    when p_order_status = 'ACCEPTED' and p_payment_status = 'PENDING'  then 'PAYMENT_PROCESSING'
    when p_order_status = 'ACCEPTED'                                  then 'PAID_AWAITING_KITCHEN'
    when p_order_status = 'PREPARING'                                 then 'PREPARING'

    -- Once the food is READY, what matters to the customer is the delivery.
    when p_order_status = 'READY' and p_delivery_status = 'SEARCHING'         then 'SEARCHING_PARTNER'
    when p_order_status = 'READY' and p_delivery_status = 'ASSIGNED'          then 'PARTNER_ASSIGNED'
    when p_order_status = 'READY' and p_delivery_status = 'PICKED_UP'         then 'ON_THE_WAY'
    when p_order_status = 'READY' and p_delivery_status = 'FAILED_NO_PARTNER' then 'NO_PARTNER'
    when p_order_status = 'READY'                                            then 'READY'

    when p_delivery_status = 'FAILED_CUSTOMER_ABSENT'                 then 'CUSTOMER_ABSENT'
    when p_order_status = 'COMPLETED'                                 then 'COMPLETED'
    when p_order_status = 'REJECTED'                                  then 'REJECTED'
    when p_order_status = 'EXPIRED'                                   then 'EXPIRED'
    else 'CANCELLED'
  end;
$$;


ALTER FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."get_delivery_offers"() RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_name" "text", "vendor_location" "text", "destination_zone" "text", "walk_minutes" integer, "earnings_pesewas" bigint, "item_count" bigint, "ready_at" timestamp with time zone, "food_is_ready" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select
    o.id,
    o.order_number,
    v.name,
    public.location_path(v.location_id),
    coalesce(z.name, 'Campus'),
    -- NULL when either leg is unknown: an estimate is omitted, never invented.
    case when v.walk_minutes_to_campus is not null and z.walk_minutes is not null
         then v.walk_minutes_to_campus + z.walk_minutes end,
    o.partner_earnings_pesewas,
    (select count(*) from public.order_items oi where oi.order_id = o.id),
    o.ready_at,
    true
  from public.orders o
  join public.vendors v on v.id = o.vendor_id
  left join public.locations z on z.id = o.destination_zone_id
  where o.delivery_status = 'SEARCHING'
    and o.order_status = 'READY'
    and o.payment_status = 'PAID'
    -- The caller must be a dispatchable Partner...
    and public.is_approved_partner()
    and exists (
      select 1 from public.partner_profiles p
       where p.user_id = auth.uid() and p.is_available
    )
    -- ...with no active delivery. One at a time in V1.
    and not exists (
      select 1 from public.orders a
       where a.partner_id = auth.uid()
         and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
    )
    -- CONFLICT OF INTEREST 1: never your own order.
    and o.customer_id <> auth.uid()
    -- CONFLICT OF INTEREST 2: never a vendor you work for.
    --
    -- Read straight from vendor_users rather than through my_vendor_ids(),
    -- which also filters out suspended users. That extra condition is harmless
    -- here but it would fold a second rule into this one, and this predicate
    -- should say exactly what the policy says and nothing else.
    and not exists (
      select 1 from public.vendor_users vu
       where vu.vendor_id = o.vendor_id and vu.user_id = auth.uid()
    )
  order by o.ready_at asc;
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
     and o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');

  if v_code is null then
    raise exception 'no pickup code available for you on this order'
      using errcode = 'insufficient_privilege';
  end if;
  return v_code;
end;
$$;


ALTER FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_auth_user_phone_confirmed"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if new.phone_confirmed_at is not null and old.phone_confirmed_at is null then
    perform public.handle_new_auth_user_for(new.id);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_auth_user_phone_confirmed"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_phone text;
begin
  -- Only CONFIRMED phones get a profile. GoTrue inserts the auth.users row when
  -- an OTP is first requested, before the number is proven — creating a profile
  -- then would let anyone claim a phone number they do not own simply by asking
  -- for a code. The real flow provisions via the phone-confirmed trigger below.
  if new.phone_confirmed_at is null then
    return new;
  end if;

  -- GoTrue stores phone numbers without the leading '+'. Our E.164 check
  -- requires it.
  v_phone := new.phone;
  if v_phone is null or v_phone = '' then
    return new;  -- email-only account (admin tooling); no customer profile yet
  end if;
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, full_name)
  values (
    new.id,
    v_phone,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user auth.users%rowtype;
  v_phone text;
begin
  select * into v_user from auth.users where id = p_user_id;
  if not found or v_user.phone is null or v_user.phone = '' then
    return;
  end if;

  v_phone := v_user.phone;
  if left(v_phone, 1) <> '+' then
    v_phone := '+' || v_phone;
  end if;

  insert into public.users (id, phone, full_name)
  values (p_user_id, v_phone,
          nullif(btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), ''))
  on conflict (id) do nothing;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user_for"("p_user_id" "uuid") OWNER TO "postgres";


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
        'email',            u.email,
        'is_suspended',     u.is_suspended,
        'is_admin',         u.is_admin,
        'can_order',        not u.is_suspended,
        'partner_status',   coalesce(p.status::text, 'NOT_APPLIED'),
        'is_partner',       coalesce(p.status = 'APPROVED', false) and not u.is_suspended,
        'partner_available', coalesce(p.is_available, false),
        'vendor_ids',       coalesce(
                              (select jsonb_agg(vu.vendor_id)
                                 from public.vendor_users vu where vu.user_id = u.id),
                              '[]'::jsonb)
      )
      from public.users u
      left join public.partner_profiles p on p.user_id = u.id
      where u.id = auth.uid()
    )
  end;
$$;


ALTER FUNCTION "public"."my_capabilities"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_outstanding_terms"() RETURNS TABLE("audience" "public"."terms_audience", "version" integer, "title" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with required as (
    select 'CUSTOMER'::public.terms_audience as audience
     where auth.uid() is not null
    union all
    select 'VENDOR'::public.terms_audience
     where exists (select 1 from public.vendor_users vu where vu.user_id = auth.uid())
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


CREATE OR REPLACE FUNCTION "public"."my_partner_application"() RETURNS TABLE("status" "public"."partner_application_status", "applied_at" timestamp with time zone, "reviewed_at" timestamp with time zone, "review_notes" "text", "is_available" boolean, "has_documents" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.status, p.applied_at, p.reviewed_at, p.review_notes, p.is_available,
         (p.student_id_image_path is not null and p.face_image_path is not null)
    from public.partner_profiles p
   where p.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_partner_application"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_payout_destination"() RETURNS TABLE("momo_network" "text", "account_number" "text", "account_name" "text", "is_ready" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select d.momo_network, d.account_number, d.account_name,
         d.provider_recipient_code is not null
    from public.payout_destinations d
   where d.payee_type = 'PARTNER' and d.payee_id = auth.uid();
$$;


ALTER FUNCTION "public"."my_payout_destination"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."my_vendor_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select vu.vendor_id
    from public.vendor_users vu
    join public.users u on u.id = vu.user_id
   where vu.user_id = auth.uid() and not u.is_suspended;
$$;


ALTER FUNCTION "public"."my_vendor_ids"() OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") RETURNS TABLE("success" boolean, "reason" "text", "order_number" "text", "pickup_code" "text", "vendor_name" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_code    text;
begin
  if v_partner is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Authorisation failure: raise. Not a routine outcome.
  --
  -- FIRST, and it must stay first: somebody who is not a Partner at all is told
  -- that, rather than being told about a conflict they could not have had.
  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  -- CONFLICT OF INTEREST. Also authorisation failures, so also raised: this is
  -- a Partner attempting something policy forbids, not one losing a race.
  --
  -- Neither message tells the caller anything they did not already know — that
  -- an order is theirs, or that they work for a vendor.
  if exists (
    select 1 from public.orders o
     where o.id = p_order_id and o.customer_id = v_partner
  ) then
    raise exception 'you cannot deliver an order you placed yourself'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
      from public.orders o
      join public.vendor_users vu on vu.vendor_id = o.vendor_id
     where o.id = p_order_id and vu.user_id = v_partner
  ) then
    raise exception 'you cannot deliver an order from a vendor you work for'
      using errcode = 'insufficient_privilege';
  end if;

  v_code := public.generate_numeric_code(4);

  -- THE ATOMIC CLAIM.
  --
  -- A single statement checks every eligibility rule in its WHERE clause and
  -- claims the row in the same breath. Postgres serialises the two racing
  -- UPDATEs on the row lock; the loser re-evaluates the WHERE against the
  -- winner's committed state, sees delivery_status is no longer SEARCHING, and
  -- matches zero rows.
  --
  -- The one-active-delivery rule is belt AND braces: this NOT EXISTS plus the
  -- partial unique index orders_one_active_delivery_per_partner, which would
  -- reject a second claim even if this predicate were somehow bypassed.
  --
  -- The two conflict rules are repeated here for the same reason. The checks
  -- above ran in an earlier statement; a staff row inserted in between would
  -- otherwise slip through the gap.
  update public.orders o
     set partner_id = v_partner,
         delivery_status = 'ASSIGNED',
         assigned_at = now()
   where o.id = p_order_id
     and o.delivery_status = 'SEARCHING'
     and o.order_status = 'READY'
     and o.payment_status = 'PAID'
     and o.partner_id is null
     and exists (
       select 1 from public.partner_profiles p
        where p.user_id = v_partner and p.status = 'APPROVED' and p.is_available
     )
     and not exists (
       select 1 from public.orders a
        where a.partner_id = v_partner
          and a.delivery_status in ('ASSIGNED', 'PICKED_UP')
     )
     and o.customer_id <> v_partner
     and not exists (
       select 1 from public.vendor_users vu
        where vu.vendor_id = o.vendor_id and vu.user_id = v_partner
     )
  returning * into v_order;

  -- Losing the race is ROUTINE, so it returns rather than raising. That keeps
  -- the rejection log committed instead of rolling it back.
  if not found then
    perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', false, 'PARTNER',
      'delivery_status', null, 'ASSIGNED', 'offer already taken or partner ineligible');
    return query select false, 'This delivery has already been taken.'::text,
                        null::text, null::text, null::text;
    return;
  end if;

  -- Fresh code for this assignment. The version bump is what makes any earlier
  -- code dead rather than merely unused.
  update public.order_secrets
     set pickup_code = v_code,
         pickup_code_version = pickup_code_version + 1,
         pickup_code_set_at = now(),
         delivery_code = coalesce(delivery_code, public.generate_numeric_code(4)),
         delivery_code_set_at = coalesce(delivery_code_set_at, now())
   where order_secrets.order_id = p_order_id;

  perform public.log_order_event(p_order_id, 'PARTNER_ACCEPT', true, 'PARTNER',
    'delivery_status', 'SEARCHING', 'ASSIGNED');

  return query
    select true, null::text, v_order.order_number, v_code, v.name
      from public.vendors v where v.id = v_order.vendor_id;
end;
$$;


ALTER FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_active_delivery"() RETURNS TABLE("order_id" "uuid", "order_number" "text", "delivery_status" "public"."delivery_status", "vendor_name" "text", "vendor_location" "text", "vendor_phone" "text", "destination_zone" "text", "destination" "text", "destination_note" "text", "customer_name" "text", "customer_phone" "text", "earnings_pesewas" bigint, "item_count" bigint, "assigned_at" timestamp with time zone, "picked_up_at" timestamp with time zone, "customer_absent_reported_at" timestamp with time zone, "seconds_until_absent_allowed" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.delivery_status,
         v.name,
         public.location_path(v.location_id),
         -- The vendor's phone is operational, not private: the Partner may need
         -- to say they are running late.
         v.phone,
         coalesce(z.name, 'Campus'),
         -- Released only after the vendor confirms handoff.
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then public.location_path(o.destination_location_id) end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED')
              then o.destination_note end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.full_name end,
         case when o.delivery_status in ('PICKED_UP', 'DELIVERED') then c.phone end,
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
              ) end
    from public.orders o
    join public.vendors v on v.id = o.vendor_id
    join public.users c on c.id = o.customer_id
    left join public.locations z on z.id = o.destination_zone_id
   where o.partner_id = auth.uid()
     and o.delivery_status in ('ASSIGNED', 'PICKED_UP');
$$;


ALTER FUNCTION "public"."partner_active_delivery"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_apply"("p_student_id_number" "text", "p_class_year" "text", "p_email" "text", "p_student_id_image_path" "text", "p_face_image_path" "text") RETURNS "public"."partner_profiles"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
  v_user    uuid := auth.uid();
  v_profile public.partner_profiles%rowtype;
  v_status  public.partner_application_status;
begin
  if v_user is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.users where id = v_user and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

  if nullif(btrim(coalesce(p_student_id_number, '')), '') is null then
    raise exception 'a student ID number is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_class_year, '')), '') is null then
    raise exception 'a class year is required' using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null then
    raise exception 'an email address is required' using errcode = 'check_violation';
  end if;
  if btrim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'that email address does not look like an address'
      using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(p_student_id_image_path, '')), '') is null
     or nullif(btrim(coalesce(p_face_image_path, '')), '') is null then
    raise exception 'both a student ID photograph and a live face photograph are required'
      using errcode = 'check_violation';
  end if;

  select status into v_status from public.partner_profiles where user_id = v_user;

  -- An approved or suspended Partner does not re-apply; that is an admin
  -- decision, not a form.
  if v_status = 'APPROVED' then
    raise exception 'you are already an approved Partner' using errcode = 'check_violation';
  end if;
  if v_status = 'SUSPENDED' then
    raise exception 'your Partner access is suspended; contact Campus Dash support'
      using errcode = 'insufficient_privilege';
  end if;

  -- The declared fields go on the user, where the approved-uniqueness index
  -- for the student ID lives.
  update public.users
     set student_id_number = btrim(p_student_id_number),
         class_year        = btrim(p_class_year),
         email             = btrim(p_email)
   where id = v_user;

  insert into public.partner_profiles (
    user_id, status, student_id_image_path, face_image_path, is_available, applied_at
  )
  values (
    v_user, 'PENDING_REVIEW', p_student_id_image_path, p_face_image_path, false, now()
  )
  on conflict (user_id) do update
     set status                = 'PENDING_REVIEW',
         student_id_image_path = excluded.student_id_image_path,
         face_image_path       = excluded.face_image_path,
         is_available          = false,
         applied_at            = now(),
         -- A re-application clears the previous decision so the queue shows a
         -- fresh case rather than a stale rejection.
         reviewed_at           = null,
         reviewed_by           = null,
         review_notes          = null,
         documents_purge_after = null
  returning * into v_profile;

  return v_profile;
end;
$_$;


ALTER FUNCTION "public"."partner_apply"("p_student_id_number" "text", "p_class_year" "text", "p_email" "text", "p_student_id_image_path" "text", "p_face_image_path" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
begin
  update public.orders o
     set partner_id = null,
         delivery_status = 'SEARCHING',
         assigned_at = null
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
    jsonb_build_object('pickup_code_rotated', true));

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_partner uuid := auth.uid();
  v_order   public.orders%rowtype;
  v_stored  text;
begin
  -- Authorisation failure: raise.
  if not exists (
    select 1 from public.orders
     where id = p_order_id and partner_id = v_partner and delivery_status = 'PICKED_UP'
  ) then
    raise exception 'you are not carrying this delivery' using errcode = 'insufficient_privilege';
  end if;

  select delivery_code into v_stored from public.order_secrets where order_id = p_order_id;

  -- A Partner cannot simply declare "delivered": the customer holds the code.
  if v_stored is null or p_delivery_code is null or v_stored <> p_delivery_code then
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


CREATE OR REPLACE FUNCTION "public"."partner_delivery_history"("p_limit" integer DEFAULT 30) RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_name" "text", "destination_zone" "text", "delivery_status" "public"."delivery_status", "earnings_pesewas" bigint, "delivered_at" timestamp with time zone, "paid_out" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id, o.order_number, v.name, coalesce(z.name, 'Campus'), o.delivery_status,
         o.partner_earnings_pesewas, o.delivered_at,
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


CREATE OR REPLACE FUNCTION "public"."partner_earnings_summary"() RETURNS TABLE("delivered_count" bigint, "earned_pesewas" bigint, "awaiting_pesewas" bigint, "settled_pesewas" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*) filter (where a.status is not null),
         coalesce(sum(a.amount_pesewas), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status <> 'SETTLED'), 0)::bigint,
         coalesce(sum(a.amount_pesewas) filter (where a.status = 'SETTLED'), 0)::bigint
    from public.allocations a
   where a.payee_type = 'PARTNER' and a.payee_id = auth.uid()
     and a.status <> 'CANCELLED';
$$;


ALTER FUNCTION "public"."partner_earnings_summary"() OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."partner_set_availability"("p_available" boolean) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if not public.is_approved_partner() then
    raise exception 'partner is not approved' using errcode = 'insufficient_privilege';
  end if;

  update public.partner_profiles
     set is_available = p_available
   where user_id = auth.uid();

  return p_available;
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
  returning * into v_row;

  return v_row;
end;
$_$;


ALTER FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."platform_config"() RETURNS "public"."pricing_config"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select * from public.pricing_config where id;
$$;


ALTER FUNCTION "public"."platform_config"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "partner_earnings_pesewas" bigint, "total_pesewas" bigint, "destination_zone_id" "uuid", "lines" "jsonb")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_subtotal bigint := 0;
  v_service  bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_zone     uuid;
  v_lines    jsonb := '[]'::jsonb;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
  v_seen     uuid[] := '{}';
begin
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

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location' using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    -- Integer division floors, so the Partner's share can never exceed the fee.
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

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

  -- 10% of the food, rounded half-up, in whole pesewas.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;

  return query select
    v_subtotal, v_service, v_delivery, v_earnings,
    v_subtotal + v_service + v_delivery,
    v_zone, v_lines;
end;
$$;


ALTER FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "total_pesewas" bigint, "lines" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.subtotal_pesewas, p.service_fee_pesewas, p.delivery_fee_pesewas,
         p.total_pesewas, p.lines
    from public.price_order(p_vendor_id, p_fulfilment_type, p_items, p_destination_location_id) p;
$$;


ALTER FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") OWNER TO "postgres";


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


CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "phone" "text" NOT NULL,
    "full_name" "text",
    "is_admin" boolean DEFAULT false NOT NULL,
    "is_suspended" boolean DEFAULT false NOT NULL,
    "student_id_number" "text",
    "student_verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_year" "text",
    "email" "text",
    CONSTRAINT "users_class_year_shape" CHECK ((("class_year" IS NULL) OR ("btrim"("class_year") <> ''::"text"))),
    CONSTRAINT "users_email_shape" CHECK ((("email" IS NULL) OR ("email" ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::"text"))),
    CONSTRAINT "users_phone_e164" CHECK (("phone" ~ '^\+[1-9]\d{7,14}$'::"text"))
);


ALTER TABLE "public"."users" OWNER TO "postgres";


COMMENT ON COLUMN "public"."users"."class_year" IS 'Applicant-declared cohort, e.g. "Class of 2029". Declared, never verified.';


COMMENT ON COLUMN "public"."users"."email" IS 'Applicant-declared contact address. No institutional domain is required.';


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

  insert into public.allocations (order_id, payee_type, payee_id, amount_pesewas, status)
  values (p_order_id, 'PARTNER', v_order.partner_id, v_earnings, 'ELIGIBLE');

  return 1;
end;
$$;


ALTER FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  return query
    select * from public.submit_order_for(
      auth.uid(), p_vendor_id, p_fulfilment_type, p_items,
      p_destination_location_id, p_destination_note
    );
end;
$$;


ALTER FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid" DEFAULT NULL::"uuid", "p_destination_note" "text" DEFAULT NULL::"text") RETURNS TABLE("order_id" "uuid", "order_number" "text", "total_pesewas" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_cfg      public.pricing_config%rowtype;
  v_order_id uuid;
  v_number   text;
  v_subtotal bigint := 0;
  v_delivery bigint := 0;
  v_earnings bigint := 0;
  v_total    bigint;
  v_service  bigint := 0;
  v_zone     uuid;
  v_item     jsonb;
  v_menu     public.menu_items%rowtype;
  v_qty      integer;
begin
  if p_customer_id is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  -- Placing an order AS someone else is a server-only capability.
  if p_customer_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
    perform public.assert_service_or_admin();
  end if;

  if exists (select 1 from public.users where id = p_customer_id and is_suspended) then
    raise exception 'account suspended' using errcode = 'insufficient_privilege';
  end if;

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

  if p_fulfilment_type = 'DELIVERY' then
    if p_destination_location_id is null then
      raise exception 'delivery orders require a destination' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from public.locations
       where id = p_destination_location_id and is_deliverable and is_active
    ) then
      raise exception 'destination is not a valid delivery location' using errcode = 'check_violation';
    end if;

    v_delivery := v_cfg.delivery_fee_pesewas;
    v_earnings := (v_delivery * v_cfg.partner_share_of_delivery_bps) / 10000;
    v_zone     := public.location_zone(p_destination_location_id);
  end if;

  insert into public.orders (
    customer_id, vendor_id, fulfilment_type, order_status,
    destination_location_id, destination_note, destination_zone_id,
    subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas,
    partner_earnings_pesewas, total_pesewas,
    delivery_status, submitted_at, accept_deadline_at
  )
  values (
    p_customer_id, p_vendor_id, p_fulfilment_type, 'SUBMITTED',
    case when p_fulfilment_type = 'DELIVERY' then p_destination_location_id end,
    p_destination_note,
    v_zone,
    0, 0, v_delivery,
    v_earnings, v_delivery,
    'NONE', now(), now() + make_interval(secs => v_cfg.vendor_response_seconds)
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

    insert into public.order_items (
      order_id, menu_item_id, name_snapshot, unit_price_pesewas, quantity, line_total_pesewas
    )
    values (
      v_order_id, v_menu.id, v_menu.name, v_menu.price_pesewas, v_qty,
      v_menu.price_pesewas * v_qty
    );

    v_subtotal := v_subtotal + (v_menu.price_pesewas * v_qty);
  end loop;

  -- The service fee is a percentage of the food, so it cannot be known until
  -- the item loop above has a subtotal. Half-up, integer arithmetic only.
  v_service := ((v_subtotal * v_cfg.service_fee_bps) + 5000) / 10000;
  v_total   := v_subtotal + v_service + v_delivery;

  update public.orders
     set subtotal_pesewas    = v_subtotal,
         service_fee_pesewas = v_service,
         total_pesewas       = v_total
   where id = v_order_id;

  insert into public.order_secrets (order_id) values (v_order_id);

  perform public.log_order_event(
    v_order_id, 'ORDER_SUBMITTED', true, 'CUSTOMER', 'order_status', 'DRAFT', 'SUBMITTED',
    null, jsonb_build_object('total_pesewas', v_total, 'item_count', jsonb_array_length(p_items))
  );

  return query select v_order_id, v_number, v_total;
end;
$$;


ALTER FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_my_profile"("p_full_name" "text") RETURNS "public"."users"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_user public.users%rowtype;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  update public.users
     set full_name = nullif(btrim(coalesce(p_full_name, '')), '')
   where id = auth.uid()
  returning * into v_user;

  return v_user;
end;
$$;


ALTER FUNCTION "public"."update_my_profile"("p_full_name" "text") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order public.orders%rowtype;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
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


ALTER FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") RETURNS "public"."transition_result"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_order  public.orders%rowtype;
  v_stored text;
begin
  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  select pickup_code into v_stored
    from public.order_secrets where order_id = p_order_id;

  -- A rotated (NULL) code never matches, so a code from a cancelled assignment
  -- is worthless the moment the Partner walks away.
  -- A rotated (NULL) code never matches. A wrong code is logged as evidence.
  if v_stored is null or p_pickup_code is null or v_stored <> p_pickup_code then
    perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', false, 'VENDOR',
      'delivery_status', 'ASSIGNED', 'PICKED_UP', 'pickup code did not match');
    return row(false, 'pickup code does not match')::public.transition_result;
  end if;

  update public.orders o
     set delivery_status = 'PICKED_UP', picked_up_at = now()
   where o.id = p_order_id and o.delivery_status = 'ASSIGNED' and o.partner_id is not null
  returning * into v_order;

  if not found then
    perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', false, 'VENDOR',
      'delivery_status', null, 'PICKED_UP', 'delivery was not ASSIGNED');
    return row(false, 'order is not awaiting pickup')::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_CONFIRM_PICKUP', true, 'VENDOR',
    'delivery_status', 'ASSIGNED', 'PICKED_UP');
  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") OWNER TO "postgres";


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
  v_cfg   public.pricing_config%rowtype;
begin
  select order_status into v_prev from public.orders where id = p_order_id;
  select * into v_cfg from public.pricing_config where id;

  if not public.is_vendor_staff((select vendor_id from public.orders where id = p_order_id))
     and not public.is_admin() then
    raise exception 'not authorised for this order' using errcode = 'insufficient_privilege';
  end if;

  update public.orders o
     set order_status = 'READY',
         ready_at = now(),
         -- Dispatch opens only for delivery orders. Pickup stays NONE forever.
         delivery_status = case
           when o.fulfilment_type = 'DELIVERY' then 'SEARCHING'::public.delivery_status
           else o.delivery_status end,
         search_started_at = case when o.fulfilment_type = 'DELIVERY' then now() end,
         search_deadline_at = case
           when o.fulfilment_type = 'DELIVERY'
           then now() + make_interval(secs => v_cfg.partner_search_seconds) end
   where o.id = p_order_id and o.order_status = 'PREPARING'
  returning * into v_order;

  if not found then
    select order_status into v_prev from public.orders where id = p_order_id;
    if v_prev is null then
      return row(false, 'that order no longer exists')::public.transition_result;
    end if;
    perform public.log_order_event(p_order_id, 'VENDOR_READY', false, 'VENDOR',
      'order_status', v_prev::text, 'READY', 'order was not PREPARING');
    return row(false, format('order cannot be marked ready from state %s', v_prev))::public.transition_result;
  end if;

  perform public.log_order_event(p_order_id, 'VENDOR_READY', true, 'VENDOR',
    'order_status', 'PREPARING', 'READY');

  if v_order.fulfilment_type = 'DELIVERY' then
    perform public.log_order_event(p_order_id, 'DISPATCH_OPENED', true, 'SYSTEM',
      'delivery_status', 'NONE', 'SEARCHING');
  end if;

  return row(true, null)::public.transition_result;
end;
$$;


ALTER FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer DEFAULT 20) RETURNS TABLE("order_id" "uuid", "order_number" "text", "bucket" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "item_count" bigint, "total_pesewas" bigint, "submitted_at" timestamp with time zone, "accept_deadline_at" timestamp with time zone, "seconds_to_deadline" integer, "age_seconds" integer, "destination_zone" "text", "partner_assigned" boolean, "cancellation_reason" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  with visible as (
    select o.*
      from public.orders o
     where o.vendor_id = p_vendor_id
       and (public.is_vendor_staff(p_vendor_id) or public.is_admin())
       -- A DRAFT order has not been sent to anyone yet.
       and o.order_status <> 'DRAFT'
  ),
  ranked as (
    select v.*,
           public.vendor_order_bucket(v.order_status) as bucket,
           row_number() over (
             partition by public.vendor_order_bucket(v.order_status)
             order by v.created_at desc
           ) as rn
      from visible v
  )
  select r.id,
         r.order_number,
         r.bucket,
         r.order_status,
         r.payment_status,
         r.delivery_status,
         r.fulfilment_type,
         (select count(*) from public.order_items oi where oi.order_id = r.id),
         r.total_pesewas,
         r.submitted_at,
         r.accept_deadline_at,
         case when r.accept_deadline_at is not null
              then extract(epoch from (r.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(r.submitted_at, r.created_at)))::integer,
         -- ZONE ONLY. The room number is deliberately not selected here.
         case when r.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = r.destination_zone_id) end,
         r.partner_id is not null,
         r.cancellation_reason
    from ranked r
   -- Live work is always shown; closed orders are capped so a busy stall does
   -- not scroll through last week to find today.
   where r.bucket <> 'CLOSED' or r.rn <= greatest(coalesce(p_closed_limit, 20), 0)
   order by
     case r.bucket when 'NEW' then 0 when 'PREPARING' then 1 when 'READY' then 2 else 3 end,
     -- Oldest first within live work: the order closest to its deadline is the
     -- one that needs attention.
     case when public.vendor_order_bucket(r.order_status) = 'CLOSED' then null else r.created_at end asc,
     r.created_at desc;
$$;


ALTER FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when p_order_status = 'SUBMITTED'                then 'NEW'
    when p_order_status in ('ACCEPTED', 'PREPARING') then 'PREPARING'
    when p_order_status = 'READY'                    then 'READY'
    else 'CLOSED'
  end;
$$;


ALTER FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") RETURNS TABLE("order_id" "uuid", "order_number" "text", "vendor_id" "uuid", "bucket" "text", "order_status" "public"."order_status", "payment_status" "public"."payment_status", "delivery_status" "public"."delivery_status", "fulfilment_type" "public"."fulfilment_type", "subtotal_pesewas" bigint, "service_fee_pesewas" bigint, "delivery_fee_pesewas" bigint, "total_pesewas" bigint, "submitted_at" timestamp with time zone, "accept_deadline_at" timestamp with time zone, "seconds_to_deadline" integer, "age_seconds" integer, "accepted_at" timestamp with time zone, "preparing_at" timestamp with time zone, "ready_at" timestamp with time zone, "completed_at" timestamp with time zone, "destination_zone" "text", "partner_assigned" boolean, "cancellation_reason" "text", "items" "jsonb")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select o.id,
         o.order_number,
         o.vendor_id,
         public.vendor_order_bucket(o.order_status),
         o.order_status,
         o.payment_status,
         o.delivery_status,
         o.fulfilment_type,
         o.subtotal_pesewas,
         o.service_fee_pesewas,
         o.delivery_fee_pesewas,
         o.total_pesewas,
         o.submitted_at,
         o.accept_deadline_at,
         case when o.accept_deadline_at is not null
              then extract(epoch from (o.accept_deadline_at - now()))::integer end,
         extract(epoch from (now() - coalesce(o.submitted_at, o.created_at)))::integer,
         o.accepted_at,
         o.preparing_at,
         o.ready_at,
         o.completed_at,
         case when o.fulfilment_type = 'DELIVERY'
              then (select z.name from public.locations z where z.id = o.destination_zone_id) end,
         o.partner_id is not null,
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
   where o.id = p_order_id
     and o.order_status <> 'DRAFT'
     and (public.is_vendor_staff(o.vendor_id) or public.is_admin());
$$;


ALTER FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select count(*)::integer
    from public.orders o
   where o.vendor_id = p_vendor_id
     and o.order_status = 'SUBMITTED'
     and (public.is_vendor_staff(p_vendor_id) or public.is_admin());
$$;


ALTER FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") OWNER TO "postgres";


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


CREATE OR REPLACE FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) RETURNS "public"."vendors"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_vendor public.vendors%rowtype;
begin
  if not public.is_vendor_staff(p_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this vendor' using errcode = 'insufficient_privilege';
  end if;

  update public.vendors set is_accepting_orders = p_accepting
   where id = p_vendor_id and status = 'ACTIVE'
  returning * into v_vendor;

  if not found then
    raise exception 'vendor is not active' using errcode = 'check_violation';
  end if;
  return v_vendor;
end;
$$;


ALTER FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean) RETURNS "public"."menu_items"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_vendor_id uuid;
  v_item      public.menu_items%rowtype;
begin
  select vendor_id into v_vendor_id from public.menu_items where id = p_menu_item_id;
  if v_vendor_id is null then
    raise exception 'menu item not found' using errcode = 'no_data_found';
  end if;

  if not public.is_vendor_staff(v_vendor_id) and not public.is_admin() then
    raise exception 'not authorised for this menu item' using errcode = 'insufficient_privilege';
  end if;

  update public.menu_items set is_available = p_available
   where id = p_menu_item_id
  returning * into v_item;

  return v_item;
end;
$$;


ALTER FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean) OWNER TO "postgres";


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
    CONSTRAINT "allocations_amount_pesewas_check" CHECK (("amount_pesewas" >= 0)),
    CONSTRAINT "allocations_payee_id_presence" CHECK (((("payee_type" = 'PLATFORM'::"public"."payee_type") AND ("payee_id" IS NULL)) OR (("payee_type" <> 'PLATFORM'::"public"."payee_type") AND ("payee_id" IS NOT NULL))))
);


ALTER TABLE "public"."allocations" OWNER TO "postgres";


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


CREATE TABLE IF NOT EXISTS "public"."order_secrets" (
    "order_id" "uuid" NOT NULL,
    "pickup_code" "text",
    "pickup_code_version" integer DEFAULT 0 NOT NULL,
    "pickup_code_set_at" timestamp with time zone,
    "delivery_code" "text",
    "delivery_code_set_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "order_secrets_delivery_code_format" CHECK ((("delivery_code" IS NULL) OR ("delivery_code" ~ '^\d{4}$'::"text"))),
    CONSTRAINT "order_secrets_pickup_code_format" CHECK ((("pickup_code" IS NULL) OR ("pickup_code" ~ '^\d{4}$'::"text")))
);


ALTER TABLE "public"."order_secrets" OWNER TO "postgres";


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


ALTER TABLE ONLY "public"."order_secrets"
    ADD CONSTRAINT "order_secrets_pkey" PRIMARY KEY ("order_id");


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."partner_profiles"
    ADD CONSTRAINT "partner_profiles_pkey" PRIMARY KEY ("user_id");


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


ALTER TABLE ONLY "public"."vendor_users"
    ADD CONSTRAINT "vendor_users_pkey" PRIMARY KEY ("vendor_id", "user_id");


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."webhook_events"
    ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");


CREATE INDEX "admin_actions_admin_idx" ON "public"."admin_actions" USING "btree" ("admin_user_id", "created_at" DESC);


CREATE INDEX "admin_actions_created_idx" ON "public"."admin_actions" USING "btree" ("created_at" DESC);


CREATE INDEX "admin_actions_target_idx" ON "public"."admin_actions" USING "btree" ("target_type", "target_id", "created_at" DESC);


CREATE UNIQUE INDEX "allocations_order_payee_unique" ON "public"."allocations" USING "btree" ("order_id", "payee_type", COALESCE("payee_id", '00000000-0000-0000-0000-000000000000'::"uuid"));


CREATE INDEX "allocations_payee_idx" ON "public"."allocations" USING "btree" ("payee_type", "payee_id", "status");


CREATE INDEX "allocations_settlement_idx" ON "public"."allocations" USING "btree" ("settlement_run_id") WHERE ("settlement_run_id" IS NOT NULL);


CREATE INDEX "idempotency_keys_expiry_idx" ON "public"."idempotency_keys" USING "btree" ("expires_at");


CREATE INDEX "locations_deliverable_idx" ON "public"."locations" USING "btree" ("id") WHERE ("is_deliverable" AND "is_active");


CREATE INDEX "locations_parent_idx" ON "public"."locations" USING "btree" ("parent_id");


CREATE UNIQUE INDEX "locations_sibling_name_unique" ON "public"."locations" USING "btree" (COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "lower"("name"));


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


CREATE INDEX "orders_awaiting_vendor_idx" ON "public"."orders" USING "btree" ("accept_deadline_at") WHERE ("order_status" = 'SUBMITTED'::"public"."order_status");


CREATE INDEX "orders_customer_idx" ON "public"."orders" USING "btree" ("customer_id", "created_at" DESC);


CREATE INDEX "orders_disputed_idx" ON "public"."orders" USING "btree" ("disputed_at") WHERE (("disputed_at" IS NOT NULL) AND ("dispute_resolved_at" IS NULL));


CREATE UNIQUE INDEX "orders_one_active_delivery_per_partner" ON "public"."orders" USING "btree" ("partner_id") WHERE (("partner_id" IS NOT NULL) AND ("delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status"])));


CREATE UNIQUE INDEX "orders_order_number_key" ON "public"."orders" USING "btree" ("order_number");


CREATE INDEX "orders_partner_idx" ON "public"."orders" USING "btree" ("partner_id") WHERE ("partner_id" IS NOT NULL);


CREATE INDEX "orders_searching_idx" ON "public"."orders" USING "btree" ("search_started_at") WHERE ("delivery_status" = 'SEARCHING'::"public"."delivery_status");


CREATE INDEX "orders_vendor_active_idx" ON "public"."orders" USING "btree" ("vendor_id", "order_status", "created_at" DESC);


CREATE INDEX "partner_profiles_dispatchable_idx" ON "public"."partner_profiles" USING "btree" ("user_id") WHERE (("status" = 'APPROVED'::"public"."partner_application_status") AND "is_available");


CREATE UNIQUE INDEX "partner_profiles_one_approved_per_user" ON "public"."partner_profiles" USING "btree" ("user_id") WHERE ("status" = 'APPROVED'::"public"."partner_application_status");


CREATE INDEX "partner_profiles_status_idx" ON "public"."partner_profiles" USING "btree" ("status");


CREATE UNIQUE INDEX "partner_profiles_student_id_unique" ON "public"."users" USING "btree" ("student_id_number") WHERE ("student_id_number" IS NOT NULL);


CREATE UNIQUE INDEX "payments_idempotency_key_unique" ON "public"."payments" USING "btree" ("idempotency_key");


CREATE UNIQUE INDEX "payments_one_pending_per_order" ON "public"."payments" USING "btree" ("order_id") WHERE ("status" = 'PENDING'::"public"."payment_txn_status");


CREATE UNIQUE INDEX "payments_one_succeeded_per_order" ON "public"."payments" USING "btree" ("order_id") WHERE ("status" = 'SUCCEEDED'::"public"."payment_txn_status");


CREATE INDEX "payments_order_idx" ON "public"."payments" USING "btree" ("order_id", "created_at" DESC);


CREATE UNIQUE INDEX "payments_provider_txn_unique" ON "public"."payments" USING "btree" ("provider", "provider_transaction_id") WHERE ("provider_transaction_id" IS NOT NULL);


CREATE UNIQUE INDEX "payout_destinations_provider_code_unique" ON "public"."payout_destinations" USING "btree" ("provider", "provider_recipient_code") WHERE ("provider_recipient_code" IS NOT NULL);


CREATE UNIQUE INDEX "payouts_idempotency_key_unique" ON "public"."payouts" USING "btree" ("idempotency_key");


CREATE INDEX "payouts_payee_idx" ON "public"."payouts" USING "btree" ("payee_type", "payee_id", "created_at" DESC);


CREATE UNIQUE INDEX "payouts_provider_transfer_unique" ON "public"."payouts" USING "btree" ("provider", "provider_transfer_id") WHERE ("provider_transfer_id" IS NOT NULL);


CREATE UNIQUE INDEX "payouts_run_payee_unique" ON "public"."payouts" USING "btree" ("settlement_run_id", "payee_type", "payee_id");


CREATE UNIQUE INDEX "settlement_runs_period_unique" ON "public"."settlement_runs" USING "btree" ("payee_type", "period_start", "period_end");


CREATE INDEX "terms_acceptances_user_idx" ON "public"."terms_acceptances" USING "btree" ("user_id", "audience");


CREATE UNIQUE INDEX "terms_acceptances_user_version_unique" ON "public"."terms_acceptances" USING "btree" ("user_id", "audience", "version");


CREATE UNIQUE INDEX "terms_documents_audience_version_unique" ON "public"."terms_documents" USING "btree" ("audience", "version");


CREATE INDEX "users_is_admin_idx" ON "public"."users" USING "btree" ("id") WHERE "is_admin";


CREATE UNIQUE INDEX "users_phone_key" ON "public"."users" USING "btree" ("phone");


CREATE INDEX "vendor_users_user_idx" ON "public"."vendor_users" USING "btree" ("user_id");


CREATE INDEX "vendors_open_idx" ON "public"."vendors" USING "btree" ("id") WHERE (("status" = 'ACTIVE'::"public"."vendor_status") AND "is_accepting_orders");


CREATE UNIQUE INDEX "vendors_phone_key" ON "public"."vendors" USING "btree" ("phone");


CREATE UNIQUE INDEX "webhook_events_provider_event_unique" ON "public"."webhook_events" USING "btree" ("provider", "event_id");


CREATE INDEX "webhook_events_status_idx" ON "public"."webhook_events" USING "btree" ("status", "received_at" DESC);


CREATE OR REPLACE TRIGGER "admin_actions_append_only" BEFORE DELETE OR UPDATE ON "public"."admin_actions" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_mutation"();


CREATE CONSTRAINT TRIGGER "allocations_must_balance" AFTER INSERT OR DELETE OR UPDATE ON "public"."allocations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "public"."check_allocations_balance"();


CREATE OR REPLACE TRIGGER "allocations_set_updated_at" BEFORE UPDATE ON "public"."allocations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "locations_no_cycles" BEFORE INSERT OR UPDATE OF "parent_id" ON "public"."locations" FOR EACH ROW EXECUTE FUNCTION "public"."locations_prevent_cycle"();


CREATE OR REPLACE TRIGGER "locations_set_updated_at" BEFORE UPDATE ON "public"."locations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "menu_items_set_updated_at" BEFORE UPDATE ON "public"."menu_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "notification_events_append_only" BEFORE DELETE OR UPDATE ON "public"."notification_events" FOR EACH ROW EXECUTE FUNCTION "public"."notification_events_append_only"();


CREATE OR REPLACE TRIGGER "order_events_append_only" BEFORE DELETE OR UPDATE ON "public"."order_events" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_mutation"();


CREATE OR REPLACE TRIGGER "order_secrets_set_updated_at" BEFORE UPDATE ON "public"."order_secrets" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "orders_set_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "partner_profiles_set_updated_at" BEFORE UPDATE ON "public"."partner_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payments_set_updated_at" BEFORE UPDATE ON "public"."payments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payout_destinations_set_updated_at" BEFORE UPDATE ON "public"."payout_destinations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "payouts_set_updated_at" BEFORE UPDATE ON "public"."payouts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "pricing_config_set_updated_at" BEFORE UPDATE ON "public"."pricing_config" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "settlement_runs_set_updated_at" BEFORE UPDATE ON "public"."settlement_runs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "public"."users" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "vendors_set_updated_at" BEFORE UPDATE ON "public"."vendors" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


ALTER TABLE ONLY "public"."admin_actions"
    ADD CONSTRAINT "admin_actions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."allocations"
    ADD CONSTRAINT "allocations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."allocations"
    ADD CONSTRAINT "allocations_settlement_run_fk" FOREIGN KEY ("settlement_run_id") REFERENCES "public"."settlement_runs"("id") ON DELETE SET NULL;


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


ALTER TABLE ONLY "public"."vendor_users"
    ADD CONSTRAINT "vendor_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."vendor_users"
    ADD CONSTRAINT "vendor_users_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."vendors"
    ADD CONSTRAINT "vendors_location_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;


ALTER TABLE "public"."admin_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allocations_read_admin" ON "public"."allocations" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "allocations_read_partner" ON "public"."allocations" FOR SELECT TO "authenticated" USING ((("payee_type" = 'PARTNER'::"public"."payee_type") AND ("payee_id" = "auth"."uid"())));


CREATE POLICY "allocations_read_vendor" ON "public"."allocations" FOR SELECT TO "authenticated" USING ((("payee_type" = 'VENDOR'::"public"."payee_type") AND ("payee_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids"))));


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
  WHERE (("o"."id" = "order_events"."order_id") AND (("o"."customer_id" = "auth"."uid"()) OR ("o"."vendor_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids"))))))));


ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "order_items_read" ON "public"."order_items" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."id" = "order_items"."order_id") AND (("o"."customer_id" = "auth"."uid"()) OR ("o"."partner_id" = "auth"."uid"()) OR ("o"."vendor_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids")) OR "public"."is_admin"())))));


ALTER TABLE "public"."order_secrets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_read_admin" ON "public"."orders" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "orders_read_assigned_partner" ON "public"."orders" FOR SELECT TO "authenticated" USING (("partner_id" = "auth"."uid"()));


CREATE POLICY "orders_read_customer" ON "public"."orders" FOR SELECT TO "authenticated" USING (("customer_id" = "auth"."uid"()));


CREATE POLICY "orders_read_vendor" ON "public"."orders" FOR SELECT TO "authenticated" USING (("vendor_id" IN ( SELECT "public"."my_vendor_ids"() AS "my_vendor_ids")));


ALTER TABLE "public"."partner_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partner_profiles_read_admin" ON "public"."partner_profiles" FOR SELECT TO "authenticated" USING ("public"."is_admin"());


CREATE POLICY "partner_profiles_read_self" ON "public"."partner_profiles" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));


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
  WHERE (("o"."customer_id" = "users"."id") AND ("o"."partner_id" = "auth"."uid"()) AND ("o"."delivery_status" = 'PICKED_UP'::"public"."delivery_status")))));


CREATE POLICY "users_read_partner_during_active_delivery" ON "public"."users" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."orders" "o"
  WHERE (("o"."partner_id" = "users"."id") AND ("o"."customer_id" = "auth"."uid"()) AND ("o"."delivery_status" = ANY (ARRAY['ASSIGNED'::"public"."delivery_status", 'PICKED_UP'::"public"."delivery_status"]))))));


CREATE POLICY "users_read_self" ON "public"."users" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));


ALTER TABLE "public"."vendor_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "vendor_users_read_self" ON "public"."vendor_users" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));


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


GRANT ALL ON TABLE "public"."vendor_users" TO "service_role";
GRANT SELECT ON TABLE "public"."vendor_users" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_add_vendor_user"("p_vendor_id" "uuid", "p_phone" "text", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_add_vendor_user"("p_vendor_id" "uuid", "p_phone" "text", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_add_vendor_user"("p_vendor_id" "uuid", "p_phone" "text", "p_reason" "text") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_create_vendor"("p_name" "text", "p_phone" "text", "p_reason" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_location"("p_location_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_delete_menu_item"("p_menu_item_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_failed_notifications"("p_limit" integer) TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_board"("p_filter" "text", "p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_order_board_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_board_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_board_summary"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_order_money"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_partner_documents_due_for_purge"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payments"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_payout_destinations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_payout_destinations"() TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_payout_destinations"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_pending_settlement"("p_payee_type" "public"."payee_type") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_pilot_metrics"("p_since" timestamp with time zone) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_provider_transaction_ids"("p_provider" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reassign_delivery"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reconcile_against_provider"("p_provider" "text", "p_provider_rows" "jsonb") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_reconciliation"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_remove_vendor_user"("p_vendor_id" "uuid", "p_user_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_remove_vendor_user"("p_vendor_id" "uuid", "p_user_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_remove_vendor_user"("p_vendor_id" "uuid", "p_user_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_resolve_dispute"("p_order_id" "uuid", "p_reason" "text", "p_notes" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_review_partner"("p_user_id" "uuid", "p_status" "public"."partner_application_status", "p_reason" "text", "p_notes" "text") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_set_vendor_status"("p_vendor_id" "uuid", "p_status" "public"."vendor_status", "p_reason" "text") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_config"("p_reason" "text", "p_service_fee_bps" integer, "p_delivery_fee_pesewas" bigint, "p_partner_share_of_delivery_bps" integer, "p_vendor_response_seconds" integer, "p_partner_search_seconds" integer, "p_customer_absent_wait_seconds" integer, "p_payment_pending_timeout_seconds" integer, "p_min_payout_pesewas" bigint, "p_notification_retry_limit" integer, "p_vendor_poll_seconds" integer, "p_partner_poll_seconds" integer, "p_customer_poll_seconds" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_location"("p_location_id" "uuid", "p_reason" "text", "p_name" "text", "p_is_deliverable" boolean, "p_walk_minutes" integer, "p_sort_order" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_menu_item"("p_menu_item_id" "uuid", "p_reason" "text", "p_name" "text", "p_description" "text", "p_price_pesewas" bigint, "p_sort_order" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_update_vendor"("p_vendor_id" "uuid", "p_reason" "text", "p_name" "text", "p_phone" "text", "p_location_id" "uuid", "p_location_note" "text", "p_walk_minutes_to_campus" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."admin_webhook_events"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."assert_service_or_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."assert_service_or_admin"() TO "service_role";


GRANT ALL ON TABLE "public"."payments" TO "service_role";
GRANT SELECT ON TABLE "public"."payments" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payment_transaction"("p_payment_id" "uuid", "p_provider_transaction_id" "text", "p_raw" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attach_payout_recipient"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid", "p_provider" "text", "p_recipient_code" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."check_allocations_balance"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_allocations_balance"() TO "service_role";


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


REVOKE ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_collect_instead"("p_order_id" "uuid") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status") TO "service_role";
GRANT ALL ON FUNCTION "public"."customer_order_stage"("p_order_status" "public"."order_status", "p_payment_status" "public"."payment_status", "p_delivery_status" "public"."delivery_status") TO "authenticated";


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


GRANT ALL ON TABLE "public"."payouts" TO "service_role";
GRANT SELECT ON TABLE "public"."payouts" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_payout"("p_payout_id" "uuid", "p_reason" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."forbid_mutation"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."forbid_mutation"() TO "service_role";


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
GRANT ALL ON FUNCTION "public"."get_my_pickup_code"("p_order_id" "uuid") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."is_service_or_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_service_or_admin"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_vendor_staff"("p_vendor_id" "uuid") TO "authenticated";


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


REVOKE ALL ON FUNCTION "public"."my_outstanding_terms"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_outstanding_terms"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_outstanding_terms"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_partner_application"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_partner_application"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_partner_application"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_payout_destination"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_payout_destination"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_payout_destination"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."my_vendor_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "service_role";
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."my_vendor_ids"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_already_sent"("p_dedupe_key" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."notification_events_append_only"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notification_events_append_only"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_accept_delivery"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_active_delivery"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_active_delivery"() TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_active_delivery"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_apply"("p_student_id_number" "text", "p_class_year" "text", "p_email" "text", "p_student_id_image_path" "text", "p_face_image_path" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_apply"("p_student_id_number" "text", "p_class_year" "text", "p_email" "text", "p_student_id_image_path" "text", "p_face_image_path" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_apply"("p_student_id_number" "text", "p_class_year" "text", "p_email" "text", "p_student_id_image_path" "text", "p_face_image_path" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_cancel_delivery"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_complete_delivery"("p_order_id" "uuid", "p_delivery_code" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_confirm_customer_absent"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_delivery_history"("p_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_earnings_summary"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_earnings_summary"() TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_earnings_summary"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_report_customer_absent"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_set_availability"("p_available" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."partner_set_payout_destination"("p_momo_network" "text", "p_account_number" "text", "p_account_name" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payment_checkout_url"("p_payment_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_destination_for"("p_payee_type" "public"."payee_type", "p_payee_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."payout_for_transfer"("p_provider" "text", "p_provider_transfer_id" "text", "p_reference" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."platform_config"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."platform_config"() TO "service_role";
GRANT ALL ON FUNCTION "public"."platform_config"() TO "anon";
GRANT ALL ON FUNCTION "public"."platform_config"() TO "authenticated";


REVOKE ALL ON FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."price_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."quote_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text", "p_provider_message_id" "text", "p_error" "text", "p_order_id" "uuid", "p_user_id" "uuid", "p_dedupe_key" "text", "p_correlation_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_notification"("p_event" "text", "p_audience" "text", "p_channel" "text", "p_recipient" "text", "p_succeeded" boolean, "p_provider" "text", "p_provider_message_id" "text", "p_error" "text", "p_order_id" "uuid", "p_user_id" "uuid", "p_dedupe_key" "text", "p_correlation_id" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_sms_delivery_status"("p_provider" "text", "p_correlation_id" "text", "p_status" "text", "p_provider_message_id" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_webhook_event"("p_provider" "text", "p_event_id" "text", "p_payload" "jsonb", "p_signature_valid" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."retry_payout"("p_payout_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."retry_payout"("p_payout_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reverse_payout"("p_payout_id" "uuid", "p_reason" "text") TO "service_role";


GRANT ALL ON TABLE "public"."users" TO "service_role";
GRANT SELECT ON TABLE "public"."users" TO "authenticated";


REVOKE ALL ON FUNCTION "public"."set_my_email"("p_email" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_my_email"("p_email" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."set_my_email"("p_email" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."settle_partner_earnings"("p_order_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."submit_order"("p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_order_for"("p_customer_id" "uuid", "p_vendor_id" "uuid", "p_fulfilment_type" "public"."fulfilment_type", "p_items" "jsonb", "p_destination_location_id" "uuid", "p_destination_note" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_my_profile"("p_full_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_my_profile"("p_full_name" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."update_my_profile"("p_full_name" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_accept_order"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_complete_pickup_order"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_confirm_pickup"("p_order_id" "uuid", "p_pickup_code" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_earnings_summary"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_mark_preparing"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_mark_ready"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_board"("p_vendor_id" "uuid", "p_closed_limit" integer) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_bucket"("p_order_status" "public"."order_status") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_order_detail"("p_order_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_pending_count"("p_vendor_id" "uuid") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_reject_order"("p_order_id" "uuid", "p_reason" "text") TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_accepting_orders"("p_vendor_id" "uuid", "p_accepting" boolean) TO "authenticated";


REVOKE ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean) TO "service_role";
GRANT ALL ON FUNCTION "public"."vendor_set_menu_item_available"("p_menu_item_id" "uuid", "p_available" boolean) TO "authenticated";


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


GRANT ALL ON TABLE "public"."order_secrets" TO "service_role";


GRANT ALL ON TABLE "public"."terms_documents" TO "service_role";
GRANT SELECT ON TABLE "public"."terms_documents" TO "authenticated";
GRANT SELECT ON TABLE "public"."terms_documents" TO "anon";


GRANT ALL ON TABLE "public"."webhook_events" TO "service_role";



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
