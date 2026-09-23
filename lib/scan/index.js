import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPlatformConfig } from '@/lib/platform-config';
import { SCAN_BUCKET } from '@/lib/verification/documents';

/**
 * Meal Scans — the read and write model.
 *
 * A MEAL SCAN ORDER IS A STORE ORDER. It carries real menu items, takes a daily
 * queue number, sits on the store's board and is handed over across a counter
 * with the same four digits every other order uses. What makes it different is
 * only how the food is paid for: the university's meal entitlement covers it,
 * so Campus Dash charges a fee and writes the store no allocation.
 *
 * IT IS ALSO NOT A PLACE TO GO. There is no scan catalogue and no scan menu any
 * more: a Meal Scan is a switch on an eligible store's ordinary checkout, and
 * the items come from the same storefront read every other order uses.
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

/**
 * What the customer will pay: a FLAT service fee, the pack if it applies, and
 * the Partner fee when they have asked for one. NOTHING FOR THE FOOD — the
 * scan already paid the store for that, which is the whole point.
 *
 * The fee does not move with the value of the meal. A percentage would be a
 * commission on a transaction between the student and the university, and the
 * errand is the same work whichever dish was chosen.
 *
 * wantsPack is a REQUEST, not an instruction. On a Partner order the pack is
 * compulsory and the answer comes back charged regardless, which is why
 * pack_is_compulsory is returned rather than worked out here — the screen must
 * not hold a second copy of the rule.
 *
 * The client sends item ids, quantities, a fulfilment choice and that request.
 * It sends no prices, and none of what it sends is used as one.
 */
export function quoteScanOrder({
  vendorId,
  items,
  fulfilmentType = 'PICKUP',
  destinationLocationId = null,
  wantsPack = false,
}) {
  return rpc('quote_scan_order', {
    p_vendor_id: vendorId,
    p_items: (items ?? []).map(({ menuItemId, quantity }) => ({
      menu_item_id: menuItemId,
      quantity,
    })),
    p_fulfilment_type: fulfilmentType,
    p_destination_location_id: destinationLocationId,
    p_wants_pack: wantsPack,
  }).then((rows) => (Array.isArray(rows) ? rows[0] : rows));
}

/**
 * Creates the order. The scan path came from our own upload route, and the
 * database checks it belongs to this account before attaching it — as well as
 * re-checking that every item is one the store actually honours a scan for.
 */
export function submitScanOrder({
  vendorId,
  items,
  fulfilmentType,
  destinationLocationId = null,
  scanImagePath,
  contentType,
  byteSize,
  orderNote = null,
  destinationNote = null,
  wantsPack = false,
}) {
  return rpc('submit_scan_order', {
    p_vendor_id: vendorId,
    p_items: (items ?? []).map(({ menuItemId, quantity }) => ({
      menu_item_id: menuItemId,
      quantity,
    })),
    p_fulfilment_type: fulfilmentType,
    p_scan_image_path: scanImagePath,
    p_content_type: contentType,
    p_byte_size: byteSize,
    p_destination_location_id: destinationLocationId,
    // Order information, for the store. The parameter kept its old name.
    p_details: orderNote,
    p_destination_note: destinationNote,
    p_wants_pack: wantsPack,
  }).then((rows) => (Array.isArray(rows) ? rows[0] : rows));
}

/** The scan's own state, without the image. Customer and admin only. */
export function getMyScanOrder(orderId) {
  return rpc('my_scan_order', { p_order_id: orderId }).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

/**
 * A short-lived URL for the Meal Scan image, or null.
 *
 * THE AUTHORISATION IS THE FIRST LINE, not this function's own judgement.
 * scan_image_path() returns a path only to the customer who uploaded it or to
 * an administrator. A PARTNER IS NOT ON THAT LIST: the store verifies the scan
 * before a Partner is even looked for, so there is nothing a Partner could do
 * with the image and no reason for one to hold a link to it.
 *
 * The URL expires on the same clock as a verification document, because it is
 * the same kind of exposure: long enough to look at, short enough that a
 * forwarded link is dead by the time anyone else opens it.
 */
export async function scanImageUrl(orderId) {
  const path = await rpc('scan_image_path', { p_order_id: orderId });
  return signScanPath(path, orderId);
}

/**
 * Turns an already-authorised path into a short-lived URL, or null.
 *
 * Shared by the customer/Partner/admin reader and the vendor one so there is a
 * single place a scan object can be signed. It deliberately makes no
 * authorisation decision of its own: the caller's SQL has already made it, and
 * a second opinion here would be a second thing to keep in step.
 */
async function signScanPath(path, orderId) {
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
 * The STORE says whether the scan is good.
 *
 * It used to be the Partner who reported this, which recorded an account of
 * something nobody had checked. The restaurant is the only party that can
 * actually judge whether an entitlement is honoured, and it is the party
 * holding the food — so the act belongs to them, and the Partner's version has
 * been removed rather than left as a second road to the same state.
 *
 * Refusal moves no money. What the customer paid is a Campus Dash fee, and
 * whether it is refunded is a decision nobody has made; an administrator picks
 * it up from the exceptions list.
 */
export function vendorRedeemScan(orderId) {
  return rpc('vendor_redeem_scan', { p_order_id: orderId }).then(unwrap);
}

export function vendorRefuseScan(orderId, reason) {
  return rpc('vendor_refuse_scan', { p_order_id: orderId, p_reason: reason }).then(unwrap);
}

/**
 * The scan image, for the store about to honour it.
 *
 * Live orders only. vendor_scan_image_path() re-checks that this caller staffs
 * the store and that the order is still on its board, so the right closes when
 * the order does — exactly as the assigned Partner's does.
 */
export async function vendorScanImageUrl(orderId) {
  const path = await rpc('vendor_scan_image_path', { p_order_id: orderId });
  return signScanPath(path, orderId);
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
