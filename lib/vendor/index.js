import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * The vendor's read model.
 *
 * Every call runs as the SIGNED-IN USER. The database functions re-check
 * is_vendor_staff() themselves, so a vendor who guessed another vendor's id
 * gets an empty result from Postgres — not a page that forgot to filter.
 *
 * These functions also decide what a vendor may SEE. The destination zone comes
 * back; the room number never leaves the database. Pickup and delivery codes
 * are not readable by anyone.
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Active work first, oldest first — the order nearest its deadline leads. */
export function getOrderBoard(vendorId, closedLimit = 20) {
  return rpc('vendor_order_board', { p_vendor_id: vendorId, p_closed_limit: closedLimit });
}

export async function getOrderDetail(orderId) {
  const rows = await rpc('vendor_order_detail', { p_order_id: orderId });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

/** Cheap enough to poll for the new-order alert. */
export function getPendingCount(vendorId) {
  return rpc('vendor_pending_count', { p_vendor_id: vendorId });
}

/** The vendors the signed-in user may act for, with their open/closed state. */
export async function getMyVendors() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('vendors')
    .select('id, name, phone, status, is_accepting_orders')
    .order('name');
  if (error) throw new Error(error.message);

  // RLS also exposes ACTIVE vendors to everyone for the customer catalogue, so
  // narrow to the ones this user actually staffs.
  const { data: memberships } = await supabase.from('vendor_users').select('vendor_id');
  const mine = new Set((memberships ?? []).map((m) => m.vendor_id));
  return (data ?? []).filter((vendor) => mine.has(vendor.id));
}

/** Groups a board response into the four columns the UI shows. */
export function groupBoard(rows) {
  const buckets = { NEW: [], PREPARING: [], READY: [], CLOSED: [] };
  (rows ?? []).forEach((row) => buckets[row.bucket]?.push(row));
  return buckets;
}
