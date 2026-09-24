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
