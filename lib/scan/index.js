import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPlatformConfig } from '@/lib/platform-config';
import { SCAN_BUCKET } from '@/lib/verification/documents';

/**
 * Scan delivery — the read and write model for the errand.
 *
 * Everything here goes through the CALLER'S session, not the service role. That
 * matters most for scanImageUrl(): the SQL that decides who may see a scan
 * resolves auth.uid() itself, so running it as the service role would silently
 * return nothing. The admin client appears exactly once, to sign a URL for a
 * path the database has already agreed this person may have.
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/** The restaurants that honour campus meal scans. Public, like the catalogue. */
export function listScanRestaurants() {
  return rpc('scan_restaurants', {}).then((rows) => rows ?? []);
}

/** What the customer will pay: service fee + delivery, and nothing for food. */
export function quoteScanOrder({ vendorId, destinationLocationId }) {
  return rpc('quote_scan_order', {
    p_vendor_id: vendorId,
    p_destination_location_id: destinationLocationId,
  }).then((rows) => (Array.isArray(rows) ? rows[0] : rows));
}

/**
 * Creates the errand. The scan path came from our own upload route, and the
 * database checks it belongs to this account before attaching it.
 */
export function submitScanOrder({
  vendorId,
  destinationLocationId,
  scanImagePath,
  contentType,
  byteSize,
  destinationNote = null,
}) {
  return rpc('submit_scan_order', {
    p_vendor_id: vendorId,
    p_destination_location_id: destinationLocationId,
    p_scan_image_path: scanImagePath,
    p_content_type: contentType,
    p_byte_size: byteSize,
    p_destination_note: destinationNote,
  }).then((rows) => (Array.isArray(rows) ? rows[0] : rows));
}

/** The scan's own state, without the image. Customer and admin only. */
export function getMyScanOrder(orderId) {
  return rpc('my_scan_order', { p_order_id: orderId }).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

/**
 * A short-lived URL for the scan image, or null.
 *
 * THE AUTHORISATION IS THE FIRST LINE, not this function's own judgement.
 * scan_image_path() returns a path only to the customer, the CURRENTLY assigned
 * Partner, or an admin — so a Partner who lost the assignment gets null here on
 * the very next request, and no URL is ever minted for them.
 *
 * The URL expires on the same clock as a verification document, because it is
 * the same kind of exposure: long enough to look at, short enough that a
 * forwarded link is dead by the time anyone else opens it.
 */
export async function scanImageUrl(orderId) {
  const path = await rpc('scan_image_path', { p_order_id: orderId });
  if (!path) return null;

  // Never let a path out of the bucket, even one the database handed us.
  if (path.includes('..') || path.startsWith('/')) {
    console.error(`[scan] refusing a suspicious path for order ${orderId}`);
    return null;
  }

  const { document_signed_url_seconds: ttl } = await getPlatformConfig();

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(SCAN_BUCKET).createSignedUrl(path, ttl);
  if (error) {
    console.error(`[scan] could not sign ${path}:`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * The Partner reports what happened at the counter.
 *
 * REPORTS, not verifications. Campus Dash has no integration with the
 * university's scan system, so what these record is a person's account of it.
 * Redemption is also what puts the food in the Partner's hands, which is why it
 * is a separate act from accepting the errand.
 */
export function reportScanRedeemed(orderId) {
  return rpc('partner_report_scan_redeemed', { p_order_id: orderId }).then(unwrap);
}

export function reportScanRefused(orderId, reason) {
  return rpc('partner_report_scan_refused', {
    p_order_id: orderId,
    p_reason: reason,
  }).then(unwrap);
}

/** Admin's view of one errand. Reports whether an image exists, never the path. */
export function adminScanOrder(orderId) {
  return rpc('admin_scan_order', { p_order_id: orderId }).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

/** State and contention failures come back as { success, reason }. Hard rule 9. */
function unwrap(result) {
  const envelope = Array.isArray(result) ? result[0] : result;
  return { success: Boolean(envelope?.success), reason: envelope?.reason ?? null };
}
