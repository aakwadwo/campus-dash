import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { invalidateAfter } from '@/lib/customer/catalogue';

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
  // A write the public catalogue shows expires its cached copy. See
  // lib/customer/catalogue.js.
  invalidateAfter(fn);
  return data;
}

// --- Vendors ----------------------------------------------------------------

/**
 * The vendor list, filterable.
 *
 * Filters are applied IN THE DATABASE. Narrowing a list is not a security
 * boundary — is_admin() inside the function is — but a pilot with sixty stores
 * should not ship all sixty to a phone so the browser can hide most of them.
 */
export function listVendors({ search = null, status = null, categoryId = null } = {}) {
  return rpc('admin_vendors', {
    p_search: search || null,
    p_status: status || null,
    p_category_id: categoryId || null,
  });
}

/**
 * Creates a CATALOGUE ENTRY, not an account.
 *
 * This is now for one thing: a business Campus Dash lists so a prepaid meal can
 * be fetched from it, which has signed up for nothing and operates no
 * dashboard. It has no owner and nobody can sign in as it. A business that
 * wants a dashboard registers itself at /vendor/signup.
 */
export function createVendor({
  name,
  phone,
  reason,
  categoryId,
  locationId,
  locationNote,
  walkMinutes,
}) {
  return rpc('admin_create_vendor', {
    p_name: name,
    p_phone: phone,
    p_reason: reason,
    p_category_id: categoryId || null,
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
  categoryId,
  description,
  locationId,
  locationNote,
  walkMinutes,
}) {
  return rpc('admin_update_vendor', {
    p_vendor_id: vendorId,
    p_reason: reason,
    p_name: name ?? null,
    p_phone: phone ?? null,
    p_category_id: categoryId || null,
    p_description: description ?? null,
    p_location_id: locationId || null,
    p_location_note: locationNote ?? null,
    p_walk_minutes_to_campus: walkMinutes ?? null,
  });
}

/**
 * Approve or reject a store application.
 *
 * APPROVAL DOES NOT OPEN THE STORE. It grants the capability; opening for
 * orders is the vendor's own decision, made when they are actually standing
 * behind the counter. A rejection carries a reason because the applicant can
 * correct it and resubmit — a rejection they cannot read is a dead end.
 *
 * The owner is told by SMS. Sending is deliberately after the decision has
 * committed and its failure is swallowed: an approval that happened must not
 * un-happen because a message did not go out.
 */
export async function reviewVendor({ vendorId, approved, reason }) {
  const vendor = await rpc('admin_review_vendor', {
    p_vendor_id: vendorId,
    p_status: approved ? 'ACTIVE' : 'REJECTED',
    p_reason: reason,
  });
  // AFTER THE RESPONSE: the decision has committed, and an operator working
  // through a queue of applications should not wait on Arkesel for each one.
  const { notifyVendorDecision } = await import('@/lib/notifications/dispatch');
  const { deferNotification } = await import('@/lib/notifications/defer');
  await deferNotification('VENDOR_DECISION', () => notifyVendorDecision(vendorId, { approved }));
  return vendor;
}

/**
 * Creates a store that has an ACCOUNT, for a vendor recruited in person.
 *
 * TWO HALVES, AND ONLY ONE OF THEM IS SQL. The identity belongs to GoTrue, so
 * it is provisioned here through the auth admin API; the store is a row, so it
 * is created by admin_create_vendor_account() running as the signed-in
 * administrator — which is what puts their id on the audit row. A service-role
 * call would have no identity to record.
 *
 * A NUMBER CAMPUS DASH ALREADY KNOWS IS REUSED, NEVER DUPLICATED. That is the
 * whole lesson of the phone-collision migration: asking GoTrue for a second
 * identity on a number public.users already carries is what turned a vendor
 * sign-up into `500 Error confirming user`. So the existing account is looked up
 * first and, when there is one, the store is simply attached to it.
 *
 * IF THE STORE CANNOT BE CREATED, AN IDENTITY MADE HERE IS REMOVED AGAIN. An
 * account that can sign in and owns nothing is precisely the orphan this is
 * meant to avoid. An account that already existed is never touched.
 */
export async function createVendorAccount({
  storeName,
  ownerPhone,
  applicantName,
  categoryId,
  description,
  ownerIsStudent,
  locationId,
  locationNote,
  walkMinutes,
  reason,
}) {
  const { getCapabilities } = await import('@/lib/auth/session');
  const me = await getCapabilities();
  if (!me.is_admin) throw new Error('admin privileges required');

  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from('users')
    .select('id')
    .eq('phone', ownerPhone)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);

  let ownerUserId = existing?.id ?? null;
  let provisioned = false;

  if (!ownerUserId) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      phone: ownerPhone,
      // CONFIRMED, because an administrator standing in front of the owner is
      // the verification. An unconfirmed identity provisions no public.users
      // row at all — see handle_new_auth_user_for().
      phone_confirm: true,
      user_metadata: applicantName ? { full_name: applicantName } : {},
    });
    if (createError) throw new Error(`could not create the owner account: ${createError.message}`);
    ownerUserId = created.user.id;
    provisioned = true;
  }

  try {
    return await rpc('admin_create_vendor_account', {
      p_owner_user_id: ownerUserId,
      p_store_name: storeName,
      p_reason: reason,
      p_applicant_name: applicantName ?? null,
      p_category_id: categoryId || null,
      p_description: description ?? null,
      p_owner_is_student: ownerIsStudent ?? null,
      p_location_id: locationId || null,
      p_location_note: locationNote ?? null,
      p_walk_minutes_to_campus: walkMinutes ?? null,
    });
  } catch (error) {
    if (provisioned) {
      const { error: undoError } = await admin.auth.admin.deleteUser(ownerUserId);
      if (undoError) {
        console.error(
          `[admin] a vendor account was provisioned and its store was refused, and the identity could not be removed (${ownerUserId}):`,
          undoError.message
        );
      }
    }
    throw error;
  }
}

/**
 * Deletes a store, and the storage objects its photographs pointed at.
 *
 * THE DATABASE DECIDES WHETHER IT MAY GO. admin_delete_vendor() refuses a store
 * with orders or settlement records outright, so there is no check here that
 * could disagree with it.
 *
 * STORAGE IS SECOND, AND DELIBERATELY NOT IN THE TRANSACTION. storage.objects
 * refuses a SQL delete by design, so the function returns the paths it saw and
 * they are removed afterwards. A failure here leaves files behind and is logged
 * loudly; it must never make the deletion itself look as though it failed.
 */
export async function deleteVendor({ vendorId, reason }) {
  const result = await rpc('admin_delete_vendor', { p_vendor_id: vendorId, p_reason: reason });
  await removeStorageObjects(result?.storage_paths);
  return result;
}

/** The same, for an account. See admin_delete_customer() for what it refuses. */
export async function deleteCustomer({ userId, reason }) {
  const result = await rpc('admin_delete_customer', { p_user_id: userId, p_reason: reason });
  await removeStorageObjects(result?.storage_paths);
  return result;
}

/**
 * Removes the objects a delete left behind, keyed by BUCKET.
 *
 * The shape comes straight from the database — `{ 'vendor-images': [...] }` —
 * because the bucket a path belongs to is known there and guessing it here from
 * the path would be a second, drifting copy of that knowledge.
 */
async function removeStorageObjects(byBucket) {
  const entries = Object.entries(byBucket ?? {}).filter(([, paths]) => paths?.length);
  if (!entries.length) return;

  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();

  for (const [bucket, paths] of entries) {
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error) {
      console.error(
        `[admin] the rows are gone but ${paths.length} object(s) remain in ${bucket}:`,
        error.message
      );
    }
  }
}

// --- Vendor categories --------------------------------------------------------

export function listVendorCategories() {
  return rpc('admin_vendor_categories', {});
}

export function createVendorCategory({ slug, name, sortOrder, reason }) {
  return rpc('admin_create_vendor_category', {
    p_slug: slug,
    p_name: name,
    p_sort_order: sortOrder ?? 0,
    p_reason: reason,
  });
}

/**
 * Rename, reorder or disable a category.
 *
 * Disabling is not deleting and touches no vendor row: a disabled category
 * disappears from the sign-up form and the customer filter, the stores already
 * in it keep trading, and every historical order keeps the category it was
 * placed under.
 */
export function updateVendorCategory({ categoryId, name, sortOrder, isActive, reason }) {
  return rpc('admin_update_vendor_category', {
    p_category_id: categoryId,
    p_name: name ?? null,
    p_sort_order: sortOrder ?? null,
    p_is_active: isActive ?? null,
    p_reason: reason,
  });
}

// --- Vendor images ------------------------------------------------------------

/**
 * The same two functions the vendor uses. The authorisation question is
 * "owner or admin", asked once in SQL, rather than twice in two languages.
 */
export function addVendorImage({ vendorId, storagePath, contentType, byteSize, caption }) {
  return rpc('vendor_add_image', {
    p_vendor_id: vendorId,
    p_storage_path: storagePath,
    p_content_type: contentType,
    p_byte_size: byteSize,
    p_caption: caption ?? null,
  });
}

export function deleteVendorImage(imageId) {
  return rpc('vendor_delete_image', { p_image_id: imageId });
}

/** The same function a store calls: owner or admin, checked in the body. */
export function setVendorPrimaryImage(imageId) {
  return rpc('vendor_set_primary_image', { p_image_id: imageId });
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

/**
 * Turns campus meal scans on or off for one restaurant.
 *
 * Separate from setVendorStatus because it answers a different question: an
 * ACTIVE restaurant sells food, and only some of them are on the university's
 * meal system. Audited in the same transaction as every other vendor change.
 */
export function setVendorScans({ vendorId, accepts, reason }) {
  return rpc('admin_set_vendor_scans', {
    p_vendor_id: vendorId,
    p_accepts: accepts,
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

/**
 * APPROVED, REJECTED or SUSPENDED. Anything but APPROVED also forces offline.
 *
 * An approval or rejection is told to the applicant by SMS — a suspension is
 * not, because that is a conversation an operator should be having rather than
 * a text message somebody receives with no context.
 */
export async function reviewPartner({ userId, status, reason, notes }) {
  const profile = await rpc('admin_review_partner', {
    p_user_id: userId,
    p_status: status,
    p_reason: reason,
    p_notes: notes || null,
  });

  if (status === 'APPROVED' || status === 'REJECTED') {
    const { notifyPartnerDecision } = await import('@/lib/notifications/dispatch');
    const { deferNotification } = await import('@/lib/notifications/defer');
    await deferNotification('PARTNER_DECISION', () =>
      notifyPartnerDecision(userId, { approved: status === 'APPROVED' })
    );
  }
  return profile;
}

// --- Accounts ----------------------------------------------------------------

/**
 * Suspends or reinstates one account.
 *
 * ONE SWITCH, EVERY CAPABILITY. `users.is_suspended` is what is_admin(),
 * is_customer(), is_approved_partner() and my_vendor_ids() all consult, so this
 * does not suspend "the customer" or "the Partner" — it suspends the person,
 * and every capability they hold goes at once and returns at once.
 *
 * Distinct from reviewPartner('SUSPENDED'), which withdraws only the Partner
 * capability and leaves the account able to order. Both exist because both are
 * real decisions.
 *
 * Self-suspension is refused BY THE DATABASE, not by the screen: is_admin()
 * requires `not is_suspended`, so an admin suspending themselves would revoke
 * the authority needed to undo it.
 */
export function setUserSuspended({ userId, suspended, reason }) {
  return rpc('admin_set_user_suspended', {
    p_user_id: userId,
    p_suspended: suspended,
    p_reason: reason,
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

/**
 * Problems first, then work in flight, then the settled past.
 *
 * Every filter is optional and every one is applied IN THE DATABASE. Narrowing
 * a list is not a security boundary — is_admin() inside the function is — but
 * filtering server-side keeps a busy pilot day from shipping five hundred rows
 * to a phone so the browser can hide most of them.
 */
export function orderBoard({
  attention = null,
  limit = 100,
  orderType = null,
  orderStatus = null,
  paymentStatus = null,
  partnerState = null,
  vendorId = null,
  since = null,
  until = null,
  search = null,
} = {}) {
  return rpc('admin_order_board', {
    p_filter: attention,
    p_limit: limit,
    p_order_type: orderType,
    p_order_status: orderStatus,
    p_payment_status: paymentStatus,
    p_partner_state: partnerState,
    p_vendor_id: vendorId,
    p_since: since,
    p_until: until,
    p_search: search,
  });
}

/**
 * The whole console in one round trip: operations, money, people, system.
 *
 * Returns null for a non-admin rather than raising, because every one of these
 * pages already redirects an unauthorised visitor — the null is the database
 * refusing a second time, and the dashboard renders zeros rather than crashing.
 */
export function dashboard() {
  return rpc('admin_dashboard', {});
}

/**
 * Lifetime totals — orders, sales, the vendor and Partner shares, the pending
 * Partner payout, and who is waiting for approval.
 *
 * A second read rather than a bigger first one: admin_dashboard() answers "what
 * is happening now" and is left alone, so nothing that reads it can break.
 */
export function dashboardTotals() {
  return rpc('admin_dashboard_totals', {});
}

// --- People ------------------------------------------------------------------

/**
 * The customer base, filtered IN THE DATABASE.
 *
 * Every dimension below narrows the query rather than the rendered array. A
 * list of everyone fetched and then filtered in the page is a table that gets
 * slower every week and a payload carrying people the operator did not ask
 * about — and it is silently wrong the moment the row limit bites.
 */
export function customers({
  search = null,
  affiliation = null,
  graduationYear = null,
  gender = null,
  joinedSince = null,
  minOrders = null,
  active = null,
  fulfilment = null,
  limit = 200,
} = {}) {
  return rpc('admin_customers', {
    p_search: search,
    p_affiliation: affiliation,
    p_graduation_year: graduationYear,
    p_gender: gender,
    p_joined_since: joinedSince,
    p_min_orders: minOrders,
    p_active: active,
    p_fulfilment: fulfilment,
    p_limit: limit,
  });
}

/**
 * The same population, COUNTED.
 *
 * A count is not a shorter list: "how many staff use this" answered by fetching
 * every staff member and reading .length is both slow and quietly wrong once
 * the query truncates.
 */
export function customerSummary({
  affiliation = null,
  graduationYear = null,
  gender = null,
  joinedSince = null,
} = {}) {
  return rpc('admin_customer_summary', {
    p_affiliation: affiliation,
    p_graduation_year: graduationYear,
    p_gender: gender,
    p_joined_since: joinedSince,
  });
}

export async function customerDetail(userId) {
  const rows = await rpc('admin_customer_detail', { p_user_id: userId });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

/** Everyone holding the Partner capability, not just the review queue. */
export function partners(status = null) {
  return rpc('admin_partners', { p_status: status });
}

/**
 * Partner supply, MEASURED.
 *
 * Online time is summed from partner_sessions rows clipped to the window, so a
 * session still open counts only the part of itself inside it. Never derived
 * from page visits, which measure whether somebody looked at their phone.
 */
/**
 * The weekly settlement list, and the act of recording that money was sent.
 *
 * MANUAL BY DESIGN, not by configuration. A Partner run creates payouts and
 * stops; a person sends the money and records the reference, which is the only
 * evidence a manual settlement has and is therefore required.
 */
export function payoutsAwaitingSettlement(payeeType = 'PARTNER') {
  return rpc('admin_payouts_awaiting_settlement', { p_payee_type: payeeType });
}

export function settlePayoutManually({ payoutId, reference, reason }) {
  return rpc('admin_settle_payout_manually', {
    p_payout_id: payoutId,
    p_reference: reference,
    p_reason: reason,
  });
}

export function partnerActivity() {
  return rpc('admin_partner_activity', {});
}

export async function partnerDetail(userId) {
  const rows = await rpc('admin_partner_detail', { p_user_id: userId });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

/** Unfiltered, for the console dashboard's counts. See listVendors for the list. */
export function vendors() {
  return rpc('admin_vendors', { p_search: null, p_status: null, p_category_id: null });
}

// --- Money -------------------------------------------------------------------

/** One row per allocation: who is owed what, on which order, and has it moved. */
export function ledger({
  orderType = null,
  payeeType = null,
  allocationStatus = null,
  payoutStatus = null,
  vendorId = null,
  payeeId = null,
  since = null,
  until = null,
  limit = 200,
} = {}) {
  return rpc('admin_ledger', {
    p_order_type: orderType,
    p_payee_type: payeeType,
    p_allocation_status: allocationStatus,
    p_payout_status: payoutStatus,
    p_vendor_id: vendorId,
    p_payee_id: payeeId,
    p_since: since,
    p_until: until,
    p_limit: limit,
  });
}

export function ledgerTotals({ orderType = null, since = null, until = null } = {}) {
  return rpc('admin_ledger_totals', {
    p_order_type: orderType,
    p_since: since,
    p_until: until,
  });
}

/** Everything waiting on a human decision, from orders, payouts and the ledger. */
export function exceptions(limit = 200) {
  return rpc('admin_exceptions', { p_limit: limit });
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

/**
 * What is owed AND whether it is due yet.
 *
 * pendingSettlement answers "how much"; this answers "is today the day". The
 * cadence — vendors daily, Partners weekly — used to live only in JavaScript,
 * so an operator looking at GH₵240 owed had no way to tell whether pressing
 * the button would do anything.
 */
export function settlementOverview() {
  return rpc('admin_settlement_overview', {});
}

/** Every payout ever, filterable. Not only the ones in the run on screen. */
export function payoutHistory({ payeeType = null, status = null, limit = 100 } = {}) {
  return rpc('admin_payout_history', {
    p_payee_type: payeeType,
    p_status: status || null,
    p_limit: limit,
  });
}

export function settlementRuns(limit = 50) {
  return rpc('admin_settlement_runs', { p_limit: limit });
}

/**
 * Where each payee's settlement money goes.
 *
 * The account numbers live in a server-only table with no client grants at
 * all — this function is the only way they are read, and it checks is_admin()
 * in its own body.
 */
export function payoutDestinations() {
  return rpc('admin_payout_destinations', {});
}

/**
 * Who could be owed money, and whether they can actually be paid.
 *
 * A list of the destinations that exist cannot answer that — the interesting
 * rows are the vendors and Partners with NO destination, and they are exactly
 * the ones such a list leaves out.
 */
export function payoutReadiness() {
  return rpc('admin_payout_readiness', {});
}

/**
 * Every approved Partner, what they are owed, and whether it clears the weekly
 * threshold.
 *
 * The rows that matter are the ones a payout list cannot show: a Partner who is
 * owed money and has no destination, or one sitting just under the threshold.
 */
export function partnerBalances() {
  return rpc('admin_partner_balances', {});
}

/** Ratings left for Partners. `maxStars` narrows it to the ones worth reading. */
export function partnerRatings({ partnerId = null, maxStars = null, limit = 100 } = {}) {
  return rpc('admin_partner_ratings', {
    p_partner_id: partnerId,
    p_max_stars: maxStars,
    p_limit: limit,
  });
}

/** Customers who have reached the order goal. */
export function customerRewards({ status = 'UNLOCKED', limit = 100 } = {}) {
  return rpc('admin_customer_rewards', { p_status: status, p_limit: limit });
}

/** Marks a reward as given, with a note saying what it was. */
export function settleCustomerReward({ rewardId, notes }) {
  return rpc('admin_settle_customer_reward', { p_reward_id: rewardId, p_notes: notes });
}

/**
 * Sets or changes a payee's mobile money destination.
 *
 * Changing the number clears the provider's recipient code, so the next
 * transfer registers the new destination rather than paying the old one.
 */
export function setPayoutDestination({
  payeeType,
  payeeId,
  momoNetwork,
  accountNumber,
  accountName,
  reason,
}) {
  return rpc('admin_set_payout_destination', {
    p_payee_type: payeeType,
    p_payee_id: payeeId,
    p_momo_network: momoNetwork,
    p_account_number: accountNumber,
    p_account_name: accountName,
    p_reason: reason,
  });
}

/**
 * Registers a saved destination with the payment provider.
 *
 * Separate from setting it, because saving a number must work when Paystack is
 * unreachable and because an administrator sometimes needs to retry the
 * registration on a destination that was saved long ago.
 */
export async function syncPayoutDestination({ payeeType, payeeId, businessName, contactEmail }) {
  const { syncPayoutSubaccount } = await import('@/lib/settlement/destinations');
  return syncPayoutSubaccount({ payeeType, payeeId, businessName, contactEmail });
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
    p_scan_service_fee_pesewas: changes.scanServiceFeePesewas ?? null,
    p_max_active_deliveries_per_partner: changes.maxActiveDeliveriesPerPartner ?? null,
    p_partner_min_payout_pesewas: changes.partnerMinPayoutPesewas ?? null,
    p_scan_pack_fee_pesewas: changes.scanPackFeePesewas ?? null,
    p_partner_delivery_enabled: changes.partnerDeliveryEnabled ?? null,
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
