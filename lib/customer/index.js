import 'server-only';

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { basketLines } from '@/lib/orders/basket';
import {
  cachedStorefrontVendors,
  cachedCategories,
  cachedSearchableItems,
  cachedStorefront,
  cachedDestinationPlaces,
} from './catalogue';

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
  // The unfiltered list is the same for everybody and is what every page asks
  // for, so it comes from the shared cache. See ./catalogue.js.
  if (!categoryId && !search?.trim()) return cachedStorefrontVendors();
  return rpc('storefront_vendors', {
    p_category_id: categoryId ?? null,
    p_search: search ?? null,
  });
}

/**
 * Every item on sale, for the one search box on the marketplace.
 *
 * The same anon-readable rows the store pages read, through the same RLS policy
 * (menu_items_read_public: ACTIVE stores only). Available items only: a search
 * that finds something sold out sends somebody to a store to be told no.
 * Campus-sized, so the browser filters it rather than a round trip per letter.
 */
export function listSearchableItems() {
  return cachedSearchableItems();
}

/** The category filter. Active categories only, in the admin's chosen order. */
export function listCategories() {
  return cachedCategories();
}

/**
 * One store and its menu, from the shared cache, and asked once per render —
 * the page and its metadata both want it.
 */
export const getVendorWithMenu = cache((vendorId) => cachedStorefront(vendorId));

/**
 * The campus tree for the destination picker: every active place with its
 * parent, whether it can itself be chosen, and the label an order will carry.
 * Deliverability is re-checked at submission; this only shapes the screen.
 */
export function listDestinationPlaces() {
  return cachedDestinationPlaces();
}

/**
 * THE FINAL PRICE, computed by the server.
 *
 * Food, the 5% service fee, and the delivery fee when the customer has chosen
 * delivery. The same numbers price the order at submission, so the figure above
 * the Pay button cannot disagree with the charge.
 *
 * It also reports whether delivery is on offer at all, so the checkout can grey
 * the option out rather than letting somebody pick one submission would refuse.
 */
export function quoteOrder({ vendorId, items, fulfilmentType = null }) {
  return rpc('quote_order', {
    p_vendor_id: vendorId,
    p_items: basketLines(items),
    p_fulfilment_type: fulfilmentType,
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

/**
 * How many orders this account has placed, how many finished, how many are live.
 *
 * Counted in the database off the orders themselves, so the headline on the
 * account screen can never disagree with the list underneath it.
 */
export function getMyOrderSummary() {
  return rpc('my_order_summary', {}).then((rows) =>
    Array.isArray(rows)
      ? (rows[0] ?? { total_orders: 0, completed_orders: 0, active_orders: 0 })
      : rows
  );
}

/**
 * An opaque signature of what somebody else can change on this order, for the
 * screen that polls it. The caller's own orders only; null otherwise.
 */
export function getMyOrderSignal(orderId) {
  return rpc('customer_order_signal', { p_order_id: orderId });
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
 * One call, one transaction: identity fields, the level, and the terms
 * acceptance land together. Splitting them would leave an account that has
 * agreed to nothing holding a capability, or an acceptance with no capability
 * to attach to.
 *
 * THE EMAIL IS NOT A PARAMETER. It is read inside the database from
 * auth.users, where GoTrue put it after checking the verification code — so
 * "verified @acity.edu.gh address" means verified, not typed. The phone number
 * IS a parameter, because it is a profile fact rather than a credential: it is
 * the number a Partner rings on arrival.
 *
 * NO STUDENT ID NUMBER. The verified school address is the school's own record
 * of who this is; a number typed into a box and checked against nothing was a
 * third copy that proved nothing. The column survives for the accounts that
 * already carry one — see the migration.
 */
export function completeOnboarding({
  firstName,
  lastName,
  phone,
  affiliation,
  graduationYear,
  gender,
  termsId,
}) {
  return rpc('complete_customer_onboarding', {
    p_first_name: firstName,
    p_last_name: lastName,
    p_phone: phone,
    // STUDENT OR STAFF, and what follows from it. A graduation year is a
    // student's fact — staff do not graduate — so it goes as null for them and
    // a CHECK constraint says the same thing independently.
    p_affiliation: affiliation,
    p_graduation_year: affiliation === 'STAFF' ? null : graduationYear,
    p_gender: gender ?? null,
    p_terms_id: termsId,
  });
}

/** Editing the same fields afterwards, from the account screen. */
export function updateMyProfile({
  firstName,
  lastName,
  phone,
  affiliation,
  graduationYear,
  gender,
}) {
  return rpc('update_my_profile', {
    p_first_name: firstName ?? null,
    p_last_name: lastName ?? null,
    p_phone: phone ?? null,
    p_affiliation: affiliation ?? null,
    p_graduation_year: affiliation === 'STAFF' ? null : (graduationYear ?? null),
    p_gender: gender ?? null,
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
