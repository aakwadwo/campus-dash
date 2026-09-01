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
