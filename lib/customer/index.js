import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * The customer's read model.
 *
 * Vendor and menu browsing go through ordinary RLS-filtered queries — the
 * catalogue is public by design, and using the same policies a real visitor
 * hits means the tests cover the real path. Orders go through SECURITY DEFINER
 * functions scoped to auth.uid().
 */

async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Open stalls first: a closed one cannot take an order anyway. */
export async function listVendors() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('vendors')
    .select('id, name, is_accepting_orders, location_id')
    .eq('status', 'ACTIVE')
    .order('name');
  if (error) throw new Error(error.message);
  return (data ?? []).sort((a, b) => Number(b.is_accepting_orders) - Number(a.is_accepting_orders));
}

export async function getVendorWithMenu(vendorId) {
  const supabase = await createClient();

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id, name, is_accepting_orders, status')
    .eq('id', vendorId)
    .eq('status', 'ACTIVE')
    .maybeSingle();

  if (!vendor) return null;

  const { data: menu } = await supabase
    .from('menu_items')
    .select('id, name, description, price_pesewas, is_available, sort_order')
    .eq('vendor_id', vendorId)
    .order('sort_order');

  return { vendor, menu: menu ?? [] };
}

export function listDeliverableLocations() {
  return rpc('deliverable_locations', {});
}

/**
 * The basket total, computed by the server.
 *
 * Called before submission so the customer sees the real number. The same
 * function priced it, so what is shown is what will be charged.
 */
export function quoteOrder({ vendorId, fulfilmentType, items, destinationLocationId }) {
  return rpc('quote_order', {
    p_vendor_id: vendorId,
    p_fulfilment_type: fulfilmentType,
    p_items: items.map(({ menuItemId, quantity }) => ({
      menu_item_id: menuItemId,
      quantity,
    })),
    p_destination_location_id: destinationLocationId ?? null,
  }).then((rows) => (Array.isArray(rows) ? (rows[0] ?? null) : rows));
}

export function listMyOrders(limit = 30) {
  return rpc('customer_order_list', { p_limit: limit });
}

export async function getMyOrder(orderId) {
  const rows = await rpc('customer_order_detail', { p_order_id: orderId });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

/**
 * Stores the customer's own email address.
 *
 * Needed because the payment provider's hosted checkout requires one. The
 * database validates the shape and writes it against auth.uid(), so this cannot
 * set anybody else's address — and no address is ever generated for someone who
 * has not given us one.
 */
export function setMyEmail(email) {
  return rpc('set_my_email', { p_email: email });
}
