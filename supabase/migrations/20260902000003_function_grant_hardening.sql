-- ============================================================================
-- Phase 4 — close the default-grant hole
-- ============================================================================
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Phase 2
-- revoked that across the schema, but the revoke applied only to functions that
-- existed AT THAT MOMENT. Every function added since — the Phase 3 auth
-- provisioning helpers, and anything a later migration adds — quietly came back
-- with a PUBLIC grant.
--
-- Found by the schema invariant test, not by anyone noticing. In practice the
-- exposure was small (the provisioning helpers only do what the trigger already
-- does, and refuse anything else), but "small" is not a security model.
-- ============================================================================

-- 1. Take back every implicit grant.
revoke execute on all functions in schema public from public, anon, authenticated;

-- 2. Stop it happening again. Functions created from here on are deny-by-default
--    and must be granted deliberately, the same as every other capability.
--
--    Revoking from PUBLIC alone is NOT enough: Supabase ships its own default
--    ACLs that grant EXECUTE on functions in this schema to anon and
--    authenticated explicitly, so a new function stays reachable even after the
--    PUBLIC default is gone. All three have to be revoked.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- 3. Re-grant exactly what a client is meant to reach.

-- Predicates used inside RLS policies. Policies are evaluated as the invoking
-- user, so without these every policy that calls one fails outright. Each
-- reports only on the CALLER, so neither can be used to probe anyone else.
grant execute on function public.is_admin()            to anon, authenticated;
grant execute on function public.my_vendor_ids()       to anon, authenticated;
grant execute on function public.is_vendor_staff(uuid) to anon, authenticated;
grant execute on function public.current_user_id()     to anon, authenticated;

-- Display helpers for the campus tree.
grant execute on function public.location_path(uuid) to anon, authenticated;
grant execute on function public.location_zone(uuid) to anon, authenticated;

-- Session and profile.
grant execute on function public.my_capabilities()        to authenticated;
grant execute on function public.update_my_profile(text)  to authenticated;

-- Customer.
grant execute on function public.submit_order(uuid, public.fulfilment_type, jsonb, uuid, text) to authenticated;
grant execute on function public.get_my_delivery_code(uuid) to authenticated;

-- Vendor.
grant execute on function public.vendor_accept_order(uuid)                  to authenticated;
grant execute on function public.vendor_reject_order(uuid, text)            to authenticated;
grant execute on function public.vendor_mark_preparing(uuid)                to authenticated;
grant execute on function public.vendor_mark_ready(uuid)                    to authenticated;
grant execute on function public.vendor_confirm_pickup(uuid, text)          to authenticated;
grant execute on function public.vendor_complete_pickup_order(uuid)         to authenticated;
grant execute on function public.vendor_set_accepting_orders(uuid, boolean) to authenticated;

-- Partner.
grant execute on function public.get_delivery_offers()                 to authenticated;
grant execute on function public.partner_accept_delivery(uuid)         to authenticated;
grant execute on function public.partner_cancel_delivery(uuid, text)   to authenticated;
grant execute on function public.partner_complete_delivery(uuid, text) to authenticated;
grant execute on function public.partner_set_availability(boolean)     to authenticated;
grant execute on function public.get_my_pickup_code(uuid)              to authenticated;

-- Admin. Each re-checks is_admin() internally, so the grant decides only who
-- may attempt a call, never who succeeds.
grant execute on function public.admin_review_partner(uuid, public.partner_application_status, text, text) to authenticated;
grant execute on function public.admin_set_vendor_status(uuid, public.vendor_status, text) to authenticated;
grant execute on function public.admin_cancel_order(uuid, text)      to authenticated;
grant execute on function public.admin_reassign_delivery(uuid, text) to authenticated;
grant execute on function public.admin_complete_order(uuid, text)    to authenticated;
grant execute on function public.admin_mark_refunded(uuid, text)     to authenticated;
grant execute on function public.admin_list_actions(integer)         to authenticated;
grant execute on function public.admin_scheduled_job_status()        to authenticated;

grant execute on function public.admin_create_vendor(text, text, text, uuid, text, integer) to authenticated;
grant execute on function public.admin_update_vendor(uuid, text, text, text, uuid, text, integer) to authenticated;
grant execute on function public.admin_add_vendor_user(uuid, text, text) to authenticated;
grant execute on function public.admin_remove_vendor_user(uuid, uuid, text) to authenticated;

grant execute on function public.admin_create_menu_item(uuid, text, bigint, text, text, integer) to authenticated;
grant execute on function public.admin_update_menu_item(uuid, text, text, text, bigint, integer) to authenticated;
grant execute on function public.admin_set_menu_item_available(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_menu_item(uuid, text) to authenticated;

grant execute on function public.admin_create_location(public.location_kind, text, text, uuid, boolean, integer, integer) to authenticated;
grant execute on function public.admin_update_location(uuid, text, text, boolean, integer, integer) to authenticated;
grant execute on function public.admin_set_location_active(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_location(uuid, text) to authenticated;

grant execute on function public.admin_list_partner_applications(public.partner_application_status) to authenticated;
grant execute on function public.admin_partner_documents_due_for_purge() to authenticated;
grant execute on function public.admin_clear_partner_documents(uuid, text) to authenticated;

-- ============================================================================
-- Deliberately NOT granted, and now genuinely unreachable:
--
--   handle_new_auth_user            trigger + provisioning internals, previously
--   handle_new_auth_user_for        callable by anon through the default grant
--   handle_auth_user_phone_confirmed
--   log_admin_action                only ever called from inside other definer
--                                   functions, which run as the owner
--   set_updated_at, forbid_mutation, locations_prevent_cycle,
--   check_allocations_balance       trigger functions
--   next_order_number, generate_numeric_code
--   is_approved_partner, is_service_or_admin, assert_service_or_admin
--   log_order_event
--   every payment, allocation, settlement, payout and webhook function
--   expire_stale_orders, expire_partner_search
-- ============================================================================
