/**
 * A basket line, in the shape price_order() and submit_order() read.
 *
 * An id, a quantity and — only for an item whose price the customer chooses —
 * the unit price they chose. That price is a CLAIM: menu_item_unit_price()
 * refuses it unless it is exactly one of the item's prices, and ignores any
 * price sent for a fixed item. Nothing here decides what is valid.
 *
 * One place, so the quote and the order are sent the same thing.
 */
export function basketLines(items) {
  return (items ?? []).map(({ menuItemId, quantity, unitPricePesewas }) =>
    unitPricePesewas === undefined || unitPricePesewas === null
      ? { menu_item_id: menuItemId, quantity }
      : { menu_item_id: menuItemId, quantity, unit_price_pesewas: unitPricePesewas }
  );
}

/**
 * A BASKET LINE IS A THING BOUGHT, and its key says which.
 *
 * A fixed item is one thing: its key is its id, and adding it again adds to
 * its quantity, exactly as it always has. An item whose price the customer
 * chooses is a different thing at each price — kelewele at GH₵10 and at GH₵20
 * are two lines — so its key is the id AND the chosen price in pesewas. The
 * same price twice is the same key, so it consolidates; two prices never do.
 * The server identifies lines the same way (price_order()).
 */
export function lineKey(menuItemId, unitPricePesewas) {
  return unitPricePesewas === undefined || unitPricePesewas === null
    ? String(menuItemId)
    : `${menuItemId}@${unitPricePesewas}`;
}

/** The inverse. A price that is not a whole positive number is not a key. */
export function parseLineKey(key) {
  const at = String(key).indexOf('@');
  if (at === -1) return { menuItemId: String(key) };
  const unitPricePesewas = Number(String(key).slice(at + 1));
  if (!Number.isSafeInteger(unitPricePesewas) || unitPricePesewas <= 0) return null;
  return { menuItemId: String(key).slice(0, at), unitPricePesewas };
}

/** { key: quantity } → the lines a quote or an order is sent, in key order. */
export function basketItems(quantities) {
  return Object.entries(quantities ?? {})
    .filter(([, quantity]) => quantity > 0)
    .map(([key, quantity]) => {
      const parsed = parseLineKey(key);
      return parsed ? { ...parsed, quantity, key } : null;
    })
    .filter(Boolean);
}

/**
 * The names that appear on more than one line of an order. Those lines are the
 * same dish at different prices, and a screen that shows "1× Kelewele" and
 * "2× Kelewele" has to add the price to tell them apart.
 */
export function namesOnSeveralLines(items, nameOf = (item) => item.name) {
  const seen = new Map();
  for (const item of items ?? []) seen.set(nameOf(item), (seen.get(nameOf(item)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name));
}
