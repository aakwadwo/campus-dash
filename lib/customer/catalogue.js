import 'server-only';

import { unstable_cache, revalidateTag } from 'next/cache';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { config } from '@/lib/config';

/**
 * THE PUBLIC CATALOGUE, CACHED ACROSS REQUESTS.
 *
 * Stores, their menus, the categories, the campus places and the platform
 * settings read the same for every visitor: none of the functions behind them
 * looks at who is asking. At lunch every student opening /order was asking
 * Postgres the same questions and getting the same answers, so they are asked
 * once, kept in the platform's data cache, and shared.
 *
 * READ AS NOBODY. The cached reads use a client with no session — the anon
 * role, through the same anon-readable functions and RLS policies a signed-out
 * visitor hits. That is what makes an answer safe to hand to everybody: it
 * cannot contain anything only one person was allowed to see. (A store owner
 * therefore sees their own storefront exactly as a customer does. Their menu
 * management screens do not read from here.)
 *
 * FRESH WHEN IT MATTERS. Every write that changes what a customer would see —
 * a store opening or closing, an item selling out, a price, a photo, a place,
 * a fee — invalidates its tag the moment it succeeds (see invalidateAfter),
 * so the next visitor gets the new answer. The TTLs are only a backstop for
 * a write that happens outside this app. And nothing here is trusted for money
 * or state: submission re-checks the store is open, every item is available,
 * and prices every line from the live menu.
 *
 * NOT CACHED, EVER: orders, payments, dispatch, anything with a customer in it.
 */

export const CATALOGUE_TAG = 'catalogue';
export const PLACES_TAG = 'campus-places';
export const CONFIG_TAG = 'platform-config';

// A write made outside this application (an operator in the SQL editor, a
// script) is picked up within this long. Writes made through the app do not
// wait for it.
const CATALOGUE_TTL_SECONDS = 60;
const PLACES_TTL_SECONDS = 3600;
const CONFIG_TTL_SECONDS = 60;

function publicClient() {
  return createSupabaseClient(config.supabaseUrl(), config.supabasePublishableKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function publicRpc(fn, args = {}) {
  const { data, error } = await publicClient().rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Every ACTIVE store, open ones first. Filtering happens in the browser. */
export const cachedStorefrontVendors = unstable_cache(
  () => publicRpc('storefront_vendors', { p_category_id: null, p_search: null }),
  ['storefront-vendors'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL_SECONDS }
);

export const cachedCategories = unstable_cache(
  () => publicRpc('active_vendor_categories'),
  ['active-vendor-categories'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL_SECONDS }
);

/**
 * HOW AN ITEM IS PRICED, for the screen to show and nothing else. A fixed
 * item's price, a stepped item's rule or a choice item's list. A variable item
 * at a store without the capability is not returned at all: the public read
 * policy hides it.
 */
const PRICING_COLUMNS =
  'pricing_mode, variable_min_pesewas, variable_step_pesewas, variable_max_pesewas, variable_choices_pesewas';

/** Every available item on an active store, for the marketplace search box. */
export const cachedSearchableItems = unstable_cache(
  async () => {
    const { data, error } = await publicClient()
      .from('menu_items')
      .select(`id, name, description, price_pesewas, vendor_id, ${PRICING_COLUMNS}`)
      .eq('is_available', true)
      .order('name');
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  ['searchable-items'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL_SECONDS }
);

/** One store and its active menu, or null. Keyed by the store's id. */
export const cachedStorefront = unstable_cache(
  async (vendorId) => {
    const client = publicClient();
    // Independent reads, so asked together.
    const [vendorResult, menuResult] = await Promise.all([
      client.rpc('storefront_vendor', { p_vendor_id: vendorId }),
      client
        .from('menu_items')
        .select(
          `id, name, description, price_pesewas, is_available, sort_order, image_path, scan_eligible, ${PRICING_COLUMNS}`
        )
        .eq('vendor_id', vendorId)
        .order('sort_order'),
    ]);
    if (vendorResult.error) throw new Error(vendorResult.error.message);
    const rows = vendorResult.data;
    const vendor = Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
    if (!vendor) return null;
    if (menuResult.error) throw new Error(menuResult.error.message);
    return { vendor, menu: menuResult.data ?? [] };
  },
  ['storefront'],
  { tags: [CATALOGUE_TAG], revalidate: CATALOGUE_TTL_SECONDS }
);

/** The campus tree for the destination picker. Changes when an admin edits it. */
export const cachedDestinationPlaces = unstable_cache(
  () => publicRpc('destination_places'),
  ['destination-places'],
  { tags: [PLACES_TAG], revalidate: PLACES_TTL_SECONDS }
);

/** pricing_config, which is anon-readable by design. */
export const cachedPlatformConfig = unstable_cache(
  async () => {
    const data = await publicRpc('platform_config');
    return Array.isArray(data) ? (data[0] ?? null) : data;
  },
  ['platform-config'],
  { tags: [CONFIG_TAG], revalidate: CONFIG_TTL_SECONDS }
);

/**
 * WHICH WRITES CHANGE WHAT A VISITOR SEES. Kept here, next to the reads they
 * invalidate, rather than scattered across the actions that make them.
 * A function not listed changes nothing a cached read returns.
 */
const TAGS_FOR = new Map(
  Object.entries({
    // A store's own screens.
    vendor_set_accepting_orders: [CATALOGUE_TAG],
    vendor_update_profile: [CATALOGUE_TAG],
    vendor_update_location: [CATALOGUE_TAG],
    vendor_add_image: [CATALOGUE_TAG],
    vendor_delete_image: [CATALOGUE_TAG],
    vendor_set_primary_image: [CATALOGUE_TAG],
    vendor_create_menu_item: [CATALOGUE_TAG],
    vendor_update_menu_item: [CATALOGUE_TAG],
    vendor_delete_menu_item: [CATALOGUE_TAG],
    vendor_set_menu_item_active: [CATALOGUE_TAG],
    vendor_set_menu_item_available: [CATALOGUE_TAG],
    vendor_set_menu_item_image: [CATALOGUE_TAG],
    vendor_clear_menu_item_image: [CATALOGUE_TAG],
    // The console.
    admin_review_vendor: [CATALOGUE_TAG],
    admin_set_vendor_status: [CATALOGUE_TAG],
    admin_update_vendor: [CATALOGUE_TAG],
    admin_create_vendor: [CATALOGUE_TAG],
    admin_create_vendor_account: [CATALOGUE_TAG],
    admin_delete_vendor: [CATALOGUE_TAG],
    admin_set_vendor_scans: [CATALOGUE_TAG],
    // Hides or restores every variable item the store has.
    admin_set_vendor_variable_pricing: [CATALOGUE_TAG],
    admin_create_menu_item: [CATALOGUE_TAG],
    admin_update_menu_item: [CATALOGUE_TAG],
    admin_delete_menu_item: [CATALOGUE_TAG],
    admin_set_menu_item_available: [CATALOGUE_TAG],
    admin_create_vendor_category: [CATALOGUE_TAG],
    admin_update_vendor_category: [CATALOGUE_TAG],
    admin_delete_customer: [CATALOGUE_TAG],
    admin_set_user_suspended: [CATALOGUE_TAG],
    // A place's name is also a store's location line.
    admin_create_location: [PLACES_TAG, CATALOGUE_TAG],
    admin_update_location: [PLACES_TAG, CATALOGUE_TAG],
    admin_set_location_active: [PLACES_TAG, CATALOGUE_TAG],
    admin_delete_location: [PLACES_TAG, CATALOGUE_TAG],
    admin_update_config: [CONFIG_TAG],
  })
);

/** The writes above, by name. A test checks every one of them exists. */
export const WRITES_THAT_INVALIDATE = Object.freeze([...TAGS_FOR.keys()]);

/**
 * Called by each RPC helper after a write SUCCEEDS. Expires the affected
 * tags at once, so the next visitor reads fresh rather than being served the
 * stale answer while it refreshes. Outside a Next.js request (a script, a
 * test) there is no cache to expire, and that is not an error.
 */
export function invalidateAfter(fn) {
  const tags = TAGS_FOR.get(fn);
  if (!tags) return;
  for (const tag of tags) {
    try {
      revalidateTag(tag, { expire: 0 });
    } catch {
      // No request scope: nothing cached to expire.
    }
  }
}
