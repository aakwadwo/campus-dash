/**
 * Whether a store sells food, decided by its category.
 *
 * A food store has a MENU; a store selling phone chargers or stationery has
 * ITEMS, and calling a printing shop's price list a menu reads as a mistake.
 * The categories are admin-managed rows with stable slugs (see
 * 20260922000003_vendor_accounts.sql), so the food ones are named here by slug.
 * A store with no category, or one added later that is not listed, is treated
 * as not food: "items" is never wrong, "menu" sometimes is.
 */
export const FOOD_CATEGORY_SLUGS = Object.freeze([
  'meals-food',
  'snacks',
  'drinks-beverages',
  'bakery-pastries',
  'fruits',
  'desserts',
]);

export function isFoodCategory(slug) {
  return FOOD_CATEGORY_SLUGS.includes(slug);
}

/** "Menu" for a food store, "Items" for anything else. */
export function catalogueLabel(slug) {
  return isFoodCategory(slug) ? 'Menu' : 'Items';
}

/**
 * Whether an item or store matches what somebody typed.
 *
 * Every word must appear somewhere, in any order, ignoring case and accents, so
 * "jollof chicken" finds "Chicken Jollof" and "cafe" finds "Café".
 */
export function matchesQuery(haystack, query) {
  const words = normalise(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = normalise(haystack);
  return words.every((word) => text.includes(word));
}

function normalise(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}
