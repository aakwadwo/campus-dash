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

/**
 * The marketplace, browsable with no account at all.
 *
 * storefront_vendors() is anon-callable and returns only what a storefront
 * shows. The vendor's phone number is deliberately not among those columns: it
 * is the owner's sign-in credential, and a customer has no reason to hold it.
 *
 * Open stores sort first. A CLOSED one still appears, with its menu — "they are
 * closed right now" is information a customer wants, and a store that vanishes
 * at 9pm reads as one that has left the platform.
 */
export function listVendors({ categoryId = null, search = null } = {}) {
  return rpc('storefront_vendors', {
    p_category_id: categoryId ?? null,
    p_search: search ?? null,
  });
}

/** The category filter. Active categories only, in the admin's chosen order. */
export function listCategories() {
  return rpc('active_vendor_categories', {});
}

export async function getVendorWithMenu(vendorId) {
  const rows = await rpc('storefront_vendor', { p_vendor_id: vendorId });
  const vendor = Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
  if (!vendor) return null;

  const supabase = await createClient();
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
 * Food plus the 5% service fee, and nothing else — there is no delivery fee to
 * quote yet, because the customer has not been asked the question. The same
 * function prices the order at submission, so what is shown is what is charged.
 */
export function quoteOrder({ vendorId, items }) {
  return rpc('quote_order', {
    p_vendor_id: vendorId,
    p_items: items.map(({ menuItemId, quantity }) => ({
      menu_item_id: menuItemId,
      quantity,
    })),
  }).then((rows) => (Array.isArray(rows) ? (rows[0] ?? null) : rows));
}

/**
 * What each fulfilment would cost this order, for the screen that asks.
 *
 * Both totals come from the database, from the order's own price snapshot.
 * The screen never adds a delivery fee to a subtotal itself.
 */
export function fulfilmentOptions(orderId) {
  return rpc('fulfilment_options', { p_order_id: orderId });
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

// --- The CUSTOMER capability -------------------------------------------------

/**
 * Customer sign-up. This is what grants the CUSTOMER capability.
 *
 * One call, one transaction: identity fields, the student facts, and the terms
 * acceptance land together. Splitting them would leave an account that has
 * agreed to nothing holding a capability, or an acceptance with no capability
 * to attach to.
 *
 * THE EMAIL IS NOT A PARAMETER. It is read inside the database from
 * auth.users, where GoTrue put it after checking the verification code — so
 * "verified @acity.edu.gh address" means verified, not typed. The phone number
 * IS a parameter, because it is a profile fact rather than a credential: it is
 * the number a Partner rings on arrival.
 */
export function completeOnboarding({
  firstName,
  lastName,
  studentIdNumber,
  level,
  phone,
  termsId,
}) {
  return rpc('complete_customer_onboarding', {
    p_first_name: firstName,
    p_last_name: lastName,
    p_student_id_number: studentIdNumber,
    p_level: level,
    p_phone: phone,
    p_terms_id: termsId,
  });
}

/**
 * Progress towards the order goal.
 *
 * Counts COMPLETED orders, so there is no separate total to keep in step with
 * the order list and nothing that can double-count a delivery.
 */
export function getMyRewardProgress() {
  return rpc('my_reward_progress', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}

/** What this account has declared about itself. Never the storage path. */
export function getMyCustomerProfile() {
  return rpc('my_customer_profile', {}).then((rows) =>
    Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null)
  );
}
