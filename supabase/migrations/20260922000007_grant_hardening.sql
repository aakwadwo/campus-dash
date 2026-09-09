-- ============================================================================
-- Close the default-grant hole. Again.
-- ============================================================================
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase ships
-- default ACLs that hand anon and authenticated the same. 20260902000003 took
-- both back and set ALTER DEFAULT PRIVILEGES so it would not recur — and it
-- recurred anyway, because a default-privilege rule only governs objects
-- created while it is in force and the platform's own grants have been through
-- the schema since.
--
-- Found by tests/customer.test.js, which asks whether an anonymous visitor can
-- reach the ordering surface and discovered that quote_order() had come back
-- PUBLIC-executable. That is the third time this hole has opened, which is why
-- the schema allowlist test asserts the WHOLE surface rather than a sample.
--
-- So: take everything back, then re-grant exactly what a client is meant to
-- reach, function by function, with a reason for each group.
-- ============================================================================

revoke execute on all functions in schema public from public, anon, authenticated;

alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ANON — the marketplace is browsable with no account at all
-- ---------------------------------------------------------------------------
-- Predicates used INSIDE RLS policies. Policies are evaluated as the invoking
-- role, so without these every policy that calls one fails outright. Each
-- reports only on the CALLER, so none can be used to probe anybody else.
grant execute on function public.is_admin()            to anon, authenticated;
grant execute on function public.is_customer(uuid)     to anon, authenticated;
grant execute on function public.is_vendor_staff(uuid) to anon, authenticated;
grant execute on function public.my_vendor_ids()       to anon, authenticated;
grant execute on function public.current_user_id()     to anon, authenticated;

-- The campus tree, and what a storefront shows.
grant execute on function public.location_path(uuid)        to anon, authenticated;
grant execute on function public.location_zone(uuid)        to anon, authenticated;
grant execute on function public.deliverable_locations()    to anon, authenticated;
grant execute on function public.platform_config()          to anon, authenticated;
grant execute on function public.current_terms(terms_audience) to anon, authenticated;
grant execute on function public.scan_restaurants()         to anon, authenticated;

-- THE STOREFRONT. Anon-callable because the whole point is that somebody can
-- look before they sign up. Neither returns the vendor's phone number: that is
-- the owner's sign-in credential, and a customer has no reason to hold it.
grant execute on function public.vendor_categories()               to anon, authenticated;
grant execute on function public.storefront_vendors(uuid, text)    to anon, authenticated;
grant execute on function public.storefront_vendor(uuid)           to anon, authenticated;

-- ---------------------------------------------------------------------------
-- AUTHENTICATED — session, profile and terms
-- ---------------------------------------------------------------------------
grant execute on function public.my_capabilities()       to authenticated;
grant execute on function public.update_my_profile(text) to authenticated;
grant execute on function public.set_my_email(text)      to authenticated;
grant execute on function public.my_customer_profile()   to authenticated;
grant execute on function public.my_outstanding_terms()  to authenticated;
grant execute on function public.accept_terms(uuid)      to authenticated;
grant execute on function public.complete_customer_onboarding(text, text, text, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Customer — ordering, choosing, tracking
-- ---------------------------------------------------------------------------
grant execute on function public.quote_order(uuid, jsonb)  to authenticated;
grant execute on function public.submit_order(uuid, jsonb) to authenticated;
grant execute on function public.fulfilment_options(uuid)  to authenticated;
grant execute on function public.customer_choose_fulfilment(uuid, fulfilment_type, uuid, text)
  to authenticated;
grant execute on function public.customer_order_list(integer)       to authenticated;
grant execute on function public.customer_order_detail(uuid)        to authenticated;
grant execute on function public.customer_order_stage(order_status, payment_status, delivery_status, fulfilment_type) to authenticated;
grant execute on function public.get_my_delivery_code(uuid)         to authenticated;
grant execute on function public.get_my_pickup_code(uuid)           to authenticated;
grant execute on function public.customer_keep_waiting(uuid)        to authenticated;
grant execute on function public.customer_collect_instead(uuid)     to authenticated;
grant execute on function public.customer_dispute_delivery(uuid, text) to authenticated;
grant execute on function public.customer_abandon_stuck_payment(uuid)  to authenticated;

-- Scan delivery.
grant execute on function public.quote_scan_order(uuid, uuid)                     to authenticated;
grant execute on function public.submit_scan_order(uuid, uuid, text, text, bigint, text)
  to authenticated;
grant execute on function public.scan_image_path(uuid)                      to authenticated;
grant execute on function public.my_scan_order(uuid)                        to authenticated;

-- ---------------------------------------------------------------------------
-- Vendor — registration, the board, the store
-- ---------------------------------------------------------------------------
grant execute on function public.vendor_signup(text, text, boolean, text, uuid, uuid) to authenticated;
grant execute on function public.my_vendor_application()          to authenticated;
grant execute on function public.vendor_update_profile(uuid, text, text, uuid, uuid, text, integer)
  to authenticated;
grant execute on function public.vendor_add_image(uuid, text, text, bigint, text) to authenticated;
grant execute on function public.vendor_delete_image(uuid)        to authenticated;
grant execute on function public.vendor_order_board(uuid, integer) to authenticated;
grant execute on function public.vendor_order_detail(uuid)        to authenticated;
grant execute on function public.vendor_order_bucket(order_status) to authenticated;
grant execute on function public.vendor_pending_count(uuid)       to authenticated;
grant execute on function public.vendor_accept_order(uuid)        to authenticated;
grant execute on function public.vendor_reject_order(uuid, text)  to authenticated;
grant execute on function public.vendor_mark_preparing(uuid)      to authenticated;
grant execute on function public.vendor_mark_ready(uuid)          to authenticated;
-- THE PICKUP CODE. Readable by the store, and only while a Partner is actually
-- waiting. The Partner has no equivalent call — that asymmetry IS the proof.
grant execute on function public.vendor_pickup_code(uuid)         to authenticated;
grant execute on function public.vendor_complete_pickup_order(uuid, text) to authenticated;
grant execute on function public.vendor_set_accepting_orders(uuid, boolean) to authenticated;
grant execute on function public.vendor_set_menu_item_available(uuid, boolean) to authenticated;
grant execute on function public.vendor_earnings_summary(uuid)    to authenticated;

-- ---------------------------------------------------------------------------
-- Partner
-- ---------------------------------------------------------------------------
grant execute on function public.partner_apply(text, text)        to authenticated;
grant execute on function public.my_partner_application()         to authenticated;
grant execute on function public.partner_set_availability(boolean) to authenticated;
grant execute on function public.get_delivery_offers()            to authenticated;
grant execute on function public.partner_accept_delivery(uuid)    to authenticated;
grant execute on function public.partner_cancel_delivery(uuid, text) to authenticated;
grant execute on function public.partner_active_delivery()        to authenticated;
grant execute on function public.partner_confirm_pickup(uuid, text) to authenticated;
grant execute on function public.partner_complete_delivery(uuid, text) to authenticated;
grant execute on function public.partner_report_customer_absent(uuid)  to authenticated;
grant execute on function public.partner_confirm_customer_absent(uuid) to authenticated;
grant execute on function public.partner_delivery_history(integer) to authenticated;
grant execute on function public.partner_earnings_summary()       to authenticated;
grant execute on function public.partner_set_payout_destination(text, text, text) to authenticated;
grant execute on function public.my_payout_destination()          to authenticated;
grant execute on function public.partner_report_scan_redeemed(uuid) to authenticated;
grant execute on function public.partner_report_scan_refused(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin
-- ---------------------------------------------------------------------------
-- Reachability, not authorisation: every one of these re-checks is_admin() in
-- its own body, so a non-admin who calls one directly gets an empty result or a
-- raised exception, never data. None is anon-callable.
grant execute on function public.admin_dashboard()                to authenticated;
grant execute on function public.admin_pilot_metrics(timestamp with time zone)            to authenticated;
grant execute on function public.admin_exceptions(integer)        to authenticated;
grant execute on function public.admin_list_actions(integer)      to authenticated;
grant execute on function public.admin_scheduled_job_status()     to authenticated;

grant execute on function public.admin_customers(text, integer)   to authenticated;
grant execute on function public.admin_customer_detail(uuid)      to authenticated;
grant execute on function public.admin_partners(text)             to authenticated;
grant execute on function public.admin_partner_detail(uuid)       to authenticated;
grant execute on function public.admin_list_partner_applications(partner_application_status)
  to authenticated;
grant execute on function public.admin_review_partner(uuid, partner_application_status, text, text)
  to authenticated;
grant execute on function public.admin_partner_documents_due_for_purge() to authenticated;
grant execute on function public.admin_clear_partner_documents(uuid, text) to authenticated;
grant execute on function public.admin_set_user_suspended(uuid, boolean, text) to authenticated;

grant execute on function public.admin_vendors(text, text, uuid)  to authenticated;
grant execute on function public.admin_create_vendor(text, text, text, uuid, uuid, text, integer)
  to authenticated;
grant execute on function public.admin_update_vendor(uuid, text, text, text, uuid, text, uuid, text, integer)
  to authenticated;
grant execute on function public.admin_review_vendor(uuid, vendor_status, text) to authenticated;
grant execute on function public.admin_set_vendor_status(uuid, vendor_status, text) to authenticated;
grant execute on function public.admin_set_vendor_scans(uuid, boolean, text) to authenticated;
grant execute on function public.admin_vendor_categories()        to authenticated;
grant execute on function public.admin_create_vendor_category(text, text, integer, text) to authenticated;
grant execute on function public.admin_update_vendor_category(uuid, text, integer, boolean, text)
  to authenticated;

grant execute on function public.admin_create_menu_item(uuid, text, bigint, text, text, integer)
  to authenticated;
grant execute on function public.admin_update_menu_item(uuid, text, text, text, bigint, integer) to authenticated;
grant execute on function public.admin_set_menu_item_available(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_menu_item(uuid, text) to authenticated;

grant execute on function public.admin_create_location(location_kind, text, text, uuid, boolean, integer, integer)
  to authenticated;
grant execute on function public.admin_update_location(uuid, text, text, boolean, integer, integer)
  to authenticated;
grant execute on function public.admin_set_location_active(uuid, boolean, text) to authenticated;
grant execute on function public.admin_delete_location(uuid, text) to authenticated;

grant execute on function public.admin_order_board(text, integer, text, text, text, text, uuid, timestamp with time zone, timestamp with time zone, text)
  to authenticated;
grant execute on function public.admin_order_board_summary()      to authenticated;
grant execute on function public.admin_order_money(uuid)          to authenticated;
grant execute on function public.admin_cancel_order(uuid, text)   to authenticated;
grant execute on function public.admin_complete_order(uuid, text) to authenticated;
grant execute on function public.admin_reassign_delivery(uuid, text) to authenticated;
grant execute on function public.admin_resolve_dispute(uuid, text, text) to authenticated;
grant execute on function public.admin_mark_refunded(uuid, text)  to authenticated;
grant execute on function public.admin_scan_order(uuid)           to authenticated;

grant execute on function public.admin_ledger(text, text, text, text, uuid, uuid, timestamp with time zone, timestamp with time zone, integer)
  to authenticated;
grant execute on function public.admin_ledger_totals(text, timestamp with time zone, timestamp with time zone) to authenticated;
grant execute on function public.admin_payments(integer) to authenticated;
grant execute on function public.admin_pending_settlement(payee_type) to authenticated;
grant execute on function public.admin_settlement_overview()      to authenticated;
grant execute on function public.admin_settlement_runs(integer)   to authenticated;
grant execute on function public.admin_settlement_payouts(uuid)   to authenticated;
grant execute on function public.admin_payout_history(payee_type, text, integer) to authenticated;
grant execute on function public.admin_payout_destinations()      to authenticated;
grant execute on function public.admin_set_payout_destination(payee_type, uuid, text, text, text, text)
  to authenticated;
grant execute on function public.admin_reconciliation(integer)    to authenticated;
grant execute on function public.admin_reconcile_against_provider(text, jsonb) to authenticated;
grant execute on function public.admin_provider_transaction_ids(text) to authenticated;

grant execute on function public.admin_webhook_events(integer)
  to authenticated;
grant execute on function public.admin_notification_log(integer) to authenticated;
grant execute on function public.admin_failed_notifications(integer) to authenticated;
grant execute on function public.admin_undelivered_notifications(integer) to authenticated;
grant execute on function public.admin_update_config(text, integer, bigint, integer, integer, integer, integer, integer, bigint, integer, integer, integer, integer, bigint)
  to authenticated;
