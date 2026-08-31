-- ============================================================================
-- Close the default TABLE-grant hole
-- ============================================================================
-- Phase 2 revoked all table privileges from anon and authenticated, and Phase 5
-- did the same for functions. Both revokes only covered objects that existed at
-- the moment they ran.
--
-- Supabase ships default ACLs granting anon and authenticated full DML on
-- tables in this schema, so every table added since came back with INSERT,
-- UPDATE, DELETE and TRUNCATE. The three tables added in this milestone —
-- terms_documents, terms_acceptances and notification_events — were all
-- writable by anonymous visitors.
--
-- Caught by the "no client role holds INSERT/UPDATE/DELETE" invariant test,
-- which is the entire reason that test exists.
--
-- RLS limited the damage (terms_acceptances would only have accepted rows the
-- policies allowed, and notification_events has an append-only trigger), but
-- anon holding TRUNCATE on an audit table is not something to reason about. It
-- is something to remove.
-- ============================================================================

-- 1. Take back every implicit grant on every table, then hand back SELECT.
revoke all on all tables in schema public from anon, authenticated;

-- 2. Stop it happening again for tables added later, exactly as we did for
--    functions. Revoking from PUBLIC alone is not enough: the Supabase defaults
--    name anon and authenticated explicitly.
alter default privileges in schema public
  revoke all on tables from public, anon, authenticated;

-- 3. Re-grant SELECT, and only SELECT. Every write in this system goes through
--    a SECURITY DEFINER function.
grant select on
  public.users, public.partner_profiles, public.vendors, public.vendor_users,
  public.locations, public.menu_items, public.pricing_config,
  public.orders, public.order_items, public.order_events,
  public.payments, public.allocations, public.settlement_runs, public.payouts,
  public.terms_documents, public.terms_acceptances
to authenticated;

grant select on
  public.vendors, public.menu_items, public.locations, public.pricing_config,
  public.terms_documents
to anon;

-- Deliberately NOT granted to anyone: order_secrets, webhook_events,
-- idempotency_keys, admin_actions, notification_events. Pickup codes, provider
-- payloads, replay state, the audit trail, and a log containing phone numbers
-- and message bodies are all read through functions or not at all.

-- ---------------------------------------------------------------------------
-- 4. Make the admin-check invariant absolute
-- ---------------------------------------------------------------------------
-- admin_order_board_summary() was safe — it reads admin_order_board(), which
-- filters on is_admin() — but "safe because of what it happens to call" is a
-- property that survives exactly until someone rewrites the body. State it
-- directly instead.
create or replace function public.admin_order_board_summary()
returns table (attention text, count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select b.attention, count(*)
    from public.admin_order_board(null, 500) b
   where public.is_admin()
   group by b.attention
   order by count(*) desc;
$$;

revoke execute on function public.admin_order_board_summary() from public, anon;
grant execute on function public.admin_order_board_summary() to authenticated;
