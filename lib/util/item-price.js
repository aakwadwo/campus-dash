import { formatPesewas } from './money';

/**
 * How a menu item is priced, for SCREENS.
 *
 * FIXED items have price_pesewas. STEPPED items have a rule: a starting price,
 * a step, and an optional maximum. CHOICES items have a list of exact prices.
 *
 * NOTHING HERE IS ENFORCEMENT. menu_item_unit_price() in the database decides
 * whether an amount is one of an item's prices, and it is the only thing that
 * does. This mirrors it so a customer is told before they tap Pay rather than
 * after, and so every screen describes an item the same way.
 */

export const PRICING_MODE = Object.freeze({
  FIXED: 'FIXED',
  STEPPED: 'STEPPED',
  CHOICES: 'CHOICES',
});

/**
 * The most one unit of anything can cost: GH₵1,000, the same ceiling a fixed
 * price has always had. public.max_item_price_pesewas() is the rule; this is
 * the screen's copy of the number, so it can say so before Pay.
 */
export const MAX_ITEM_PRICE_PESEWAS = 100000;

export function isVariablePrice(item) {
  return item?.pricing_mode === PRICING_MODE.STEPPED || item?.pricing_mode === PRICING_MODE.CHOICES;
}

/** The item's price choices as integers, ascending. PostgREST may send int8 as text. */
export function priceChoices(item) {
  return (item?.variable_choices_pesewas ?? []).map(Number).sort((a, b) => a - b);
}

/** The least a customer can pay for one. */
export function lowestPrice(item) {
  if (item?.pricing_mode === PRICING_MODE.STEPPED) return Number(item.variable_min_pesewas);
  if (item?.pricing_mode === PRICING_MODE.CHOICES) return priceChoices(item)[0];
  return Number(item?.price_pesewas ?? 0);
}

/**
 * Whether `pesewas` is one of the item's prices. Never rounds.
 *
 * For a STEPPED item that is not on the rule, it also returns the nearest valid
 * prices either side, so the screen can name them instead of explaining a rule.
 * An amount over the platform ceiling says so with `tooHigh`.
 */
export function checkChosenPrice(item, pesewas) {
  // A number too long to hold exactly is still "too much", not "unreadable".
  if (!(pesewas > 0) || (!Number.isSafeInteger(pesewas) && pesewas <= MAX_ITEM_PRICE_PESEWAS)) {
    return { ok: false };
  }

  if (item?.pricing_mode === PRICING_MODE.CHOICES) {
    return { ok: priceChoices(item).includes(pesewas) };
  }

  const min = Number(item.variable_min_pesewas);
  const step = Number(item.variable_step_pesewas);
  // NO STORE MAXIMUM IS STILL A CEILING: the highest step at or under what any
  // item can cost.
  const max = Math.min(
    item.variable_max_pesewas == null ? Infinity : Number(item.variable_max_pesewas),
    min + Math.floor((MAX_ITEM_PRICE_PESEWAS - min) / step) * step
  );

  if (pesewas < min) return { ok: false, higher: min };
  if (pesewas > max) {
    return { ok: false, lower: max, tooHigh: pesewas > MAX_ITEM_PRICE_PESEWAS };
  }
  const offset = (pesewas - min) % step;
  if (offset === 0) return { ok: true };

  const lower = pesewas - offset;
  const higher = lower + step;
  return { ok: false, lower, higher: higher > max ? null : higher };
}

/** "From GH₵10.00", or the range when it has one, for a list or a search result. */
export function priceSummary(item) {
  if (item?.pricing_mode === PRICING_MODE.CHOICES) {
    const choices = priceChoices(item);
    return choices.length === 1
      ? formatPesewas(choices[0])
      : `${formatPesewas(choices[0])}–${formatPesewas(choices[choices.length - 1])}`;
  }
  if (item?.pricing_mode === PRICING_MODE.STEPPED) {
    return item.variable_max_pesewas == null
      ? `From ${formatPesewas(Number(item.variable_min_pesewas))}`
      : `${formatPesewas(Number(item.variable_min_pesewas))}–${formatPesewas(
          Number(item.variable_max_pesewas)
        )}`;
  }
  return formatPesewas(Number(item?.price_pesewas ?? 0));
}

/** A cedi amount as a person types it: "35", or "17.50" when it has pesewas. */
export function cedisText(pesewas) {
  return pesewas % 100 === 0
    ? String(pesewas / 100)
    : `${Math.floor(pesewas / 100)}.${String(pesewas % 100).padStart(2, '0')}`;
}
