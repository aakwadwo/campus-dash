-- ============================================================================
-- Function execution grants
-- ============================================================================
-- Postgres grants EXECUTE to PUBLIC by default. For SECURITY DEFINER functions
-- that would be a disaster: any signed-in user could call confirm_payment() and
-- mark their own order paid.
--
-- So: revoke everything, then grant back only the functions a client is
-- legitimately allowed to invoke.
-- ============================================================================

revoke execute on all functions in schema public from public, anon, authenticated;

-- --- Customer ---------------------------------------------------------------
grant execute on function public.submit_order(uuid, public.fulfilment_type, jsonb, uuid, text) to authenticated;
grant execute on function public.get_my_delivery_code(uuid) to authenticated;

-- --- Vendor -----------------------------------------------------------------
grant execute on function public.vendor_accept_order(uuid)            to authenticated;
grant execute on function public.vendor_reject_order(uuid, text)      to authenticated;
grant execute on function public.vendor_mark_preparing(uuid)          to authenticated;
grant execute on function public.vendor_mark_ready(uuid)              to authenticated;
grant execute on function public.vendor_confirm_pickup(uuid, text)    to authenticated;
grant execute on function public.vendor_complete_pickup_order(uuid)   to authenticated;
grant execute on function public.vendor_set_accepting_orders(uuid, boolean) to authenticated;

-- --- Partner ----------------------------------------------------------------
grant execute on function public.get_delivery_offers()                     to authenticated;
grant execute on function public.partner_accept_delivery(uuid)             to authenticated;
grant execute on function public.partner_cancel_delivery(uuid, text)       to authenticated;
grant execute on function public.partner_complete_delivery(uuid, text)     to authenticated;
grant execute on function public.partner_set_availability(boolean)         to authenticated;
grant execute on function public.get_my_pickup_code(uuid)                  to authenticated;

-- --- Admin ------------------------------------------------------------------
-- These re-check is_admin() internally; the grant only makes them reachable.
grant execute on function public.admin_review_partner(uuid, public.partner_application_status, text, text) to authenticated;
grant execute on function public.admin_set_vendor_status(uuid, public.vendor_status, text) to authenticated;
grant execute on function public.admin_cancel_order(uuid, text)      to authenticated;
grant execute on function public.admin_reassign_delivery(uuid, text) to authenticated;
grant execute on function public.admin_complete_order(uuid, text)    to authenticated;
grant execute on function public.admin_mark_refunded(uuid, text)     to authenticated;
grant execute on function public.admin_list_actions(integer)         to authenticated;
grant execute on function public.log_admin_action(text, text, uuid, text, jsonb, jsonb, jsonb) to authenticated;

-- --- Predicates used INSIDE RLS policies ------------------------------------
-- Policies are evaluated as the invoking user, so without these grants every
-- policy that calls a helper fails with "permission denied for function".
--
-- Safe to expose: each one reports only on the CALLER. is_admin() says whether
-- you are an admin; my_vendor_ids() lists the vendors you work for. Neither
-- takes a subject, so neither can be used to probe anyone else.
grant execute on function public.is_admin()              to anon, authenticated;
grant execute on function public.my_vendor_ids()         to anon, authenticated;
grant execute on function public.is_vendor_staff(uuid)   to anon, authenticated;
grant execute on function public.current_user_id()       to anon, authenticated;

-- --- Display helpers --------------------------------------------------------
grant execute on function public.location_path(uuid) to anon, authenticated;
grant execute on function public.location_zone(uuid) to anon, authenticated;

-- ============================================================================
-- NOT granted to any client role, on purpose:
--
--   create_payment_intent      a customer must not conjure a payment intent
--   confirm_payment            ONLY the provider's webhook can mark money paid
--   fail_payment
--   create_order_allocations   the ledger is written by the server alone
--   settle_partner_earnings
--   create_settlement_run      settlement is an operational job, not a request
--   mark_payout_paid
--   record_webhook_event       provider intake
--   mark_webhook_processed
--   expire_stale_orders        scheduled jobs
--   expire_partner_search
--   generate_numeric_code      codes are issued, never requested
--   log_order_event            the log is written by the transitions themselves
--   is_approved_partner        callable with any user id, so it stays internal
--   is_service_or_admin        the server-side gate itself
--
-- These run under the service-role key from route handlers, or from a scheduled
-- job. assert_service_or_admin() enforces that a second time inside the
-- function bodies, so a future accidental grant is still not enough to call one.
-- ============================================================================
