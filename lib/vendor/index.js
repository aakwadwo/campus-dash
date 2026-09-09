import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * The vendor's read and write model.
 *
 * Every call runs as the SIGNED-IN USER. The database functions re-check
 * is_vendor_staff() themselves — which now means "owns this business", not
 * "appears in a staff table" — so a vendor who guessed another vendor's id gets
 * an empty result from Postgres, not a page that forgot to filter.
 *
 * These functions also decide what a vendor may SEE. The destination zone comes
 * back; the room number never leaves the database. The delivery code is not
 * readable by anyone here. The PICKUP code is, and deliberately: the vendor
 * holds it and reads it out, which is the one secret this side of the app owns.
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

function one(rows) {
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

// --- Registration ------------------------------------------------------------

/**
 * Register a store, on the identity whose phone number was just verified.
 *
 * The phone is NOT a parameter: it is read inside the database from the
 * caller's own users row, so the credential and the store's contact number
 * cannot disagree, and nobody can register a store against someone else's
 * number.
 *
 * Called again by a REJECTED applicant, it is a resubmission — same store, same
 * identity, corrected facts, back to PENDING_APPROVAL. That is the entire
 * reason a rejection has to carry a reason.
 */
export function signUp({ applicantName, storeName, isStudent, description, categoryId, termsId }) {
  return rpc('vendor_signup', {
    p_applicant_name: applicantName,
    p_store_name: storeName,
    p_is_student: isStudent,
    p_description: description,
    p_category_id: categoryId,
    p_terms_id: termsId,
  });
}

/**
 * Where this account's application stands.
 *
 * Deliberately readable while PENDING_APPROVAL and while REJECTED: an applicant
 * who cannot sign in and see why they were turned down cannot fix it.
 */
export function getMyApplication() {
  return rpc('my_vendor_application', {}).then(one);
}

export function listCategories() {
  return rpc('active_vendor_categories', {});
}

/**
 * Where a store can say it is.
 *
 * Every ACTIVE location, not the deliverable ones: a store sits at a block or a
 * common area, and the deliverable list is rooms — the places food goes TO.
 */
export async function listCampusLocations() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('locations')
    .select('id, name, kind, sort_order')
    .eq('is_active', true)
    .order('sort_order')
    .order('name');
  if (error) throw new Error(error.message);
  return data ?? [];
}

// --- Orders ------------------------------------------------------------------

/** Active work first, oldest first — the order nearest its deadline leads. */
export function getOrderBoard(vendorId, closedLimit = 20) {
  return rpc('vendor_order_board', { p_vendor_id: vendorId, p_closed_limit: closedLimit });
}

export function getOrderDetail(orderId) {
  return rpc('vendor_order_detail', { p_order_id: orderId }).then(one);
}

/** Cheap enough to poll for the new-order alert. */
export function getPendingCount(vendorId) {
  return rpc('vendor_pending_count', { p_vendor_id: vendorId });
}

/**
 * The pickup code to read out to the Partner standing at the counter.
 *
 * Returned only while a Partner is actually assigned, and only to this store.
 * The Partner has no equivalent call — that asymmetry IS the handoff proof.
 */
export function getPickupCode(orderId) {
  return rpc('vendor_pickup_code', { p_order_id: orderId });
}

// --- The store itself --------------------------------------------------------

/**
 * The businesses this account operates.
 *
 * Reads my_vendor_application() rather than filtering a vendors query, because
 * the vendors table also exposes every ACTIVE store to everybody for the
 * customer catalogue — and a filter that says "mine" in JavaScript is a filter
 * that can be forgotten.
 */
export async function getMyVendors() {
  const application = await getMyApplication();
  return application ? [application] : [];
}

export function updateProfile({
  vendorId,
  name,
  description,
  categoryId,
  locationId,
  locationNote,
  walkMinutes,
}) {
  return rpc('vendor_update_profile', {
    p_vendor_id: vendorId,
    p_name: name,
    p_description: description ?? null,
    p_category_id: categoryId ?? null,
    p_location_id: locationId ?? null,
    p_location_note: locationNote ?? null,
    p_walk_minutes: walkMinutes ?? null,
  });
}

export async function listImages(vendorId) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('vendor_images')
    .select('id, storage_path, caption, sort_order, created_at')
    .eq('vendor_id', vendorId)
    .order('sort_order')
    .order('created_at');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export function addImage({ vendorId, storagePath, contentType, byteSize, caption }) {
  return rpc('vendor_add_image', {
    p_vendor_id: vendorId,
    p_storage_path: storagePath,
    p_content_type: contentType,
    p_byte_size: byteSize,
    p_caption: caption ?? null,
  });
}

/** Returns the storage path, so the caller can delete the object itself. */
export function removeImage(imageId) {
  return rpc('vendor_delete_image', { p_image_id: imageId });
}

// --- Money -------------------------------------------------------------------

export function getEarnings(vendorId) {
  return rpc('vendor_earnings_summary', { p_vendor_id: vendorId }).then(one);
}

// --- Presentation ------------------------------------------------------------

/** Groups a board response into the four columns the UI shows. */
export function groupBoard(rows) {
  const buckets = { NEW: [], PREPARING: [], READY: [], CLOSED: [] };
  (rows ?? []).forEach((row) => buckets[row.bucket]?.push(row));
  return buckets;
}

/**
 * Where this store's money is sent.
 *
 * Two things can be true independently, and the screen says so: `split_ready`
 * means Paystack will route the food subtotal straight to this account as each
 * order is paid; `transfers_ready` means a settlement run can push money to it.
 * A store with neither is still paid — an administrator settles it by hand —
 * but nothing is automatic until at least one is set up.
 */
export function getPayoutDestination() {
  return rpc('my_payout_destination', {}).then((rows) => {
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    return list.find((row) => row.payee_type === 'VENDOR') ?? null;
  });
}

/** Saves the mobile money account this store is settled to. */
export function setPayoutDestination({ vendorId, momoNetwork, accountNumber, accountName }) {
  return rpc('vendor_set_payout_destination', {
    p_vendor_id: vendorId,
    p_momo_network: momoNetwork,
    p_account_number: accountNumber,
    p_account_name: accountName,
  });
}
