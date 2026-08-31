import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * Admin operations.
 *
 * Every call runs as the SIGNED-IN USER, not the service role. That is
 * deliberate: each database function re-checks is_admin() itself, so a
 * non-admin reaching these gets an error from the database rather than
 * borrowed privileges from a key the browser can never see.
 *
 * Reads go through ordinary RLS-filtered queries for the same reason.
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// --- Vendors ----------------------------------------------------------------

export function createVendor({ name, phone, reason, locationId, locationNote, walkMinutes }) {
  return rpc('admin_create_vendor', {
    p_name: name,
    p_phone: phone,
    p_reason: reason,
    p_location_id: locationId || null,
    p_location_note: locationNote || null,
    p_walk_minutes_to_campus: walkMinutes ?? null,
  });
}

export function updateVendor({
  vendorId,
  reason,
  name,
  phone,
  locationId,
  locationNote,
  walkMinutes,
}) {
  return rpc('admin_update_vendor', {
    p_vendor_id: vendorId,
    p_reason: reason,
    p_name: name ?? null,
    p_phone: phone ?? null,
    p_location_id: locationId || null,
    p_location_note: locationNote ?? null,
    p_walk_minutes_to_campus: walkMinutes ?? null,
  });
}

/** DRAFT / ACTIVE / SUSPENDED. Anything but ACTIVE also stops new orders. */
export function setVendorStatus({ vendorId, status, reason }) {
  return rpc('admin_set_vendor_status', {
    p_vendor_id: vendorId,
    p_status: status,
    p_reason: reason,
  });
}

export function setVendorAcceptingOrders({ vendorId, accepting }) {
  return rpc('vendor_set_accepting_orders', { p_vendor_id: vendorId, p_accepting: accepting });
}

export function addVendorUser({ vendorId, phone, reason }) {
  return rpc('admin_add_vendor_user', { p_vendor_id: vendorId, p_phone: phone, p_reason: reason });
}

export function removeVendorUser({ vendorId, userId, reason }) {
  return rpc('admin_remove_vendor_user', {
    p_vendor_id: vendorId,
    p_user_id: userId,
    p_reason: reason,
  });
}

// --- Menu items -------------------------------------------------------------

export function createMenuItem({ vendorId, name, pricePesewas, reason, description, sortOrder }) {
  return rpc('admin_create_menu_item', {
    p_vendor_id: vendorId,
    p_name: name,
    p_price_pesewas: pricePesewas,
    p_reason: reason,
    p_description: description || null,
    p_sort_order: sortOrder ?? 0,
  });
}

/** A price change never reaches an order already placed — order_items snapshot. */
export function updateMenuItem({ menuItemId, reason, name, description, pricePesewas, sortOrder }) {
  return rpc('admin_update_menu_item', {
    p_menu_item_id: menuItemId,
    p_reason: reason,
    p_name: name ?? null,
    p_description: description ?? null,
    p_price_pesewas: pricePesewas ?? null,
    p_sort_order: sortOrder ?? null,
  });
}

export function setMenuItemAvailable({ menuItemId, available, reason }) {
  return rpc('admin_set_menu_item_available', {
    p_menu_item_id: menuItemId,
    p_available: available,
    p_reason: reason,
  });
}

export function deleteMenuItem({ menuItemId, reason }) {
  return rpc('admin_delete_menu_item', { p_menu_item_id: menuItemId, p_reason: reason });
}

// --- Locations --------------------------------------------------------------

export function createLocation({
  kind,
  name,
  reason,
  parentId,
  isDeliverable,
  walkMinutes,
  sortOrder,
}) {
  return rpc('admin_create_location', {
    p_kind: kind,
    p_name: name,
    p_reason: reason,
    p_parent_id: parentId || null,
    p_is_deliverable: Boolean(isDeliverable),
    p_walk_minutes: walkMinutes ?? null,
    p_sort_order: sortOrder ?? 0,
  });
}

export function updateLocation({
  locationId,
  reason,
  name,
  isDeliverable,
  walkMinutes,
  sortOrder,
}) {
  return rpc('admin_update_location', {
    p_location_id: locationId,
    p_reason: reason,
    p_name: name ?? null,
    p_is_deliverable: isDeliverable ?? null,
    p_walk_minutes: walkMinutes ?? null,
    p_sort_order: sortOrder ?? null,
  });
}

export function setLocationActive({ locationId, active, reason }) {
  return rpc('admin_set_location_active', {
    p_location_id: locationId,
    p_active: active,
    p_reason: reason,
  });
}

export function deleteLocation({ locationId, reason }) {
  return rpc('admin_delete_location', { p_location_id: locationId, p_reason: reason });
}

// --- Partners ---------------------------------------------------------------

export function listPartnerApplications(status = null) {
  return rpc('admin_list_partner_applications', { p_status: status });
}

/** APPROVED, REJECTED or SUSPENDED. Anything but APPROVED also forces offline. */
export function reviewPartner({ userId, status, reason, notes }) {
  return rpc('admin_review_partner', {
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
    p_notes: notes || null,
  });
}

// --- Audit ------------------------------------------------------------------

export function listAdminActions(limit = 100) {
  return rpc('admin_list_actions', { p_limit: limit });
}

export function scheduledJobStatus() {
  return rpc('admin_scheduled_job_status', {});
}

// --- Operations --------------------------------------------------------------

/** Problems first, then work in flight, then the settled past. */
export function orderBoard(filter = null, limit = 100) {
  return rpc('admin_order_board', { p_filter: filter, p_limit: limit });
}

export function orderBoardSummary() {
  return rpc('admin_order_board_summary', {});
}

export async function orderMoney(orderId) {
  const rows = await rpc('admin_order_money', { p_order_id: orderId });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

/** Only the discrepancies. A list of everything that is fine is a distraction. */
export function reconciliation(limit = 200) {
  return rpc('admin_reconciliation', { p_limit: limit });
}

export function pendingSettlement(payeeType) {
  return rpc('admin_pending_settlement', { p_payee_type: payeeType });
}

export function settlementRuns(limit = 50) {
  return rpc('admin_settlement_runs', { p_limit: limit });
}

export function settlementPayouts(runId) {
  return rpc('admin_settlement_payouts', { p_run_id: runId });
}

export function payments(limit = 100) {
  return rpc('admin_payments', { p_limit: limit });
}

export function webhookEvents(limit = 100) {
  return rpc('admin_webhook_events', { p_limit: limit });
}

export function notificationLog(limit = 100) {
  return rpc('admin_notification_log', { p_limit: limit });
}

export function resolveDispute({ orderId, reason, notes }) {
  return rpc('admin_resolve_dispute', {
    p_order_id: orderId,
    p_reason: reason,
    p_notes: notes || null,
  });
}

export function reassignDelivery({ orderId, reason }) {
  return rpc('admin_reassign_delivery', { p_order_id: orderId, p_reason: reason });
}

export function cancelOrder({ orderId, reason }) {
  return rpc('admin_cancel_order', { p_order_id: orderId, p_reason: reason });
}

export function completeOrder({ orderId, reason }) {
  return rpc('admin_complete_order', { p_order_id: orderId, p_reason: reason });
}

export function markRefunded({ orderId, reason }) {
  return rpc('admin_mark_refunded', { p_order_id: orderId, p_reason: reason });
}

// --- Pilot operations --------------------------------------------------------

/** Everything the pilot is meant to answer, from data already recorded. */
export function pilotMetrics(since = null) {
  return rpc('admin_pilot_metrics', { p_since: since });
}

export function failedNotifications(limit = 100) {
  return rpc('admin_failed_notifications', { p_limit: limit });
}

export function platformConfig() {
  return rpc('platform_config', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

export function updateConfig(changes) {
  return rpc('admin_update_config', {
    p_reason: changes.reason,
    p_service_fee_bps: changes.serviceFeeBps ?? null,
    p_delivery_fee_pesewas: changes.deliveryFeePesewas ?? null,
    p_partner_share_of_delivery_bps: changes.partnerShareBps ?? null,
    p_vendor_response_seconds: changes.vendorResponseSeconds ?? null,
    p_partner_search_seconds: changes.partnerSearchSeconds ?? null,
    p_customer_absent_wait_seconds: changes.customerAbsentWaitSeconds ?? null,
    p_payment_pending_timeout_seconds: changes.paymentPendingTimeoutSeconds ?? null,
    p_min_payout_pesewas: changes.minPayoutPesewas ?? null,
    p_notification_retry_limit: changes.notificationRetryLimit ?? null,
    p_vendor_poll_seconds: changes.vendorPollSeconds ?? null,
    p_partner_poll_seconds: changes.partnerPollSeconds ?? null,
    p_customer_poll_seconds: changes.customerPollSeconds ?? null,
  });
}

/**
 * Compares our records against the provider's.
 *
 * The provider view is fetched through the adapter, so the same code path works
 * when a real provider replaces the fake one — only the adapter changes.
 */
export async function reconcileAgainstProvider() {
  const { getPaymentProvider } = await import('@/lib/payments');
  const provider = getPaymentProvider();

  const known = await rpc('admin_provider_transaction_ids', { p_provider: provider.name });

  const statement = [];
  for (const row of known ?? []) {
    try {
      const status = await provider.getStatus(row.provider_transaction_id);
      statement.push({
        provider_transaction_id: row.provider_transaction_id,
        status: status.status,
        amount_pesewas: status.amountPesewas,
        kind: row.kind,
      });
    } catch {
      // A transaction the provider cannot describe is itself a finding: leaving
      // it out makes it show up as MISSING_AT_PROVIDER, which is correct.
    }
  }

  return rpc('admin_reconcile_against_provider', {
    p_provider: provider.name,
    p_provider_rows: statement,
  });
}
