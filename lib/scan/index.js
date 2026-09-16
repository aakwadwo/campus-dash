import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getPlatformConfig } from '@/lib/platform-config';
import { SCAN_BUCKET } from '@/lib/verification/documents';

/**
 * Meal scans — the read and write model.
 *
 * A SCAN ORDER IS A STORE ORDER. It carries real menu items, takes a daily
 * queue number, sits on the store's board and is handed over across a counter
 * with the same four digits every other order uses. What makes it different is
 * only how the food is paid for: the university's meal entitlement covers it,
 * so Campus Dash charges a fee and writes the store no allocation.
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
 * Stores that honour campus meal scans AND have something eligible on the menu.
 * Public, like the rest of the catalogue: what a store will take a scan for is
 * not a secret, and hiding it only means finding out at the counter.
 */
export function listScanRestaurants() {
  return rpc('scan_restaurants', {}).then((rows) => rows ?? []);
}

/** The eligible half of one store's menu. Public, for the same reason. */
export function listScanMenu(vendorId) {
  return rpc('scan_menu', { p_vendor_id: vendorId }).then((rows) => rows ?? []);
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
  details = null,
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
    p_details: details,
    p_destination_note: destinationNote,
    p_wants_pack: wantsPack,
  }).then((rows) => (Array.isArray(rows) ? rows[0] : rows));
}

/**
 * What the assigned Partner is told about an errand.
 *
 * Gated on the same release as the image: assignment opens it, and the end of
 * the delivery closes it. Null means "not yours to read", which is the same
 * answer a stranger and a finished Partner both get.
 */
export function getPartnerScanBrief(orderId) {
  return rpc('partner_scan_brief', { p_order_id: orderId }).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
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
