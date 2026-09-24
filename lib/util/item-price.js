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

/* ---------------------------------------------------------------------------
 * What a STORE types when it sets a variable price
 *
 * Shared by the vendor form (to say what is wrong while they type) and the
 * vendor action (to refuse it with a sentence before the database is asked).
 * The database — assert_variable_price_rule() and assert_price_choices() — is
 * still the authority; these only have to agree with it.
 * ------------------------------------------------------------------------ */

/** "GH₵6", or "GH₵6.50" — how a person writes a price back to them. */
export function cedisShort(pesewas) {
  return `GH₵${cedisText(pesewas)}`;
}

/**
 * A cedi amount as typed, in pesewas, or null. STRICT: digits, and at most two
 * decimal places, with an optional GH₵ in front. Anything else is refused
 * rather than cleaned up — "-5", "1,5" and "5a" are not prices, and quietly
 * turning them into GH₵5, GH₵15 and GH₵5 would store a price nobody typed.
 */
export function parseCedis(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^(GH₵|GH¢|GHS|₵)\s*/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [cedis, fraction = ''] = text.split('.');
  const pesewas = Number(cedis) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(pesewas) ? pesewas : null;
}

/**
 * A price that must be more than zero — a fixed price, as typed — or null.
 * parseCedis with the one extra rule a price has: "0" is not one.
 */
export function parsePositiveCedis(input) {
  const pesewas = parseCedis(input);
  return pesewas !== null && pesewas > 0 ? pesewas : null;
}

/**
 * Whether a starting price, a step and an optional maximum make a rule.
 *
 * TWO SEPARATE QUESTIONS. The start and the step are each any positive amount
 * up to the ceiling — nothing about one constrains the other, so GH₵1 in steps
 * of GH₵5 (1, 6, 11, 16…) is as valid as GH₵10 in steps of GH₵5. Only a
 * maximum, when there is one, has to lie on the sequence they make; when it
 * does not, the nearest prices that do are returned so the form can name them.
 */
export function checkSteppedRule({ minPesewas, stepPesewas, maxPesewas = null }) {
  const cap = MAX_ITEM_PRICE_PESEWAS;
  const too = `The most a price can be is ${cedisShort(cap)}.`;
  if (!(minPesewas > 0))
    return { ok: false, field: 'min', message: 'Give a starting price, like 10.' };
  if (minPesewas > cap) return { ok: false, field: 'min', message: too };
  if (!(stepPesewas > 0)) return { ok: false, field: 'step', message: 'Give a step, like 5.' };
  if (stepPesewas > cap) return { ok: false, field: 'step', message: too };
  if (maxPesewas === null || maxPesewas === undefined) return { ok: true };

  if (maxPesewas > cap) return { ok: false, field: 'max', message: too };
  if (maxPesewas < minPesewas) {
    return {
      ok: false,
      field: 'max',
      message: `The maximum cannot be below the starting price, ${cedisShort(minPesewas)}.`,
    };
  }
  const offset = (maxPesewas - minPesewas) % stepPesewas;
  if (offset === 0) return { ok: true };

  const lower = maxPesewas - offset;
  const higher = lower + stepPesewas;
  const options = [lower, higher <= cap ? higher : null].filter(Boolean).map(cedisShort);
  return {
    ok: false,
    field: 'max',
    message: `${cedisShort(maxPesewas)} is not one of your prices. Use ${options.join(' or ')}, or leave it empty.`,
  };
}

/** The first few prices a stepped rule makes: "GH₵1, GH₵6, GH₵11, GH₵16…". */
export function steppedPreview({ minPesewas, stepPesewas, maxPesewas = null }, count = 4) {
  const top = Math.min(maxPesewas ?? MAX_ITEM_PRICE_PESEWAS, MAX_ITEM_PRICE_PESEWAS);
  const prices = [];
  for (let p = minPesewas; p <= top && prices.length < count; p += stepPesewas) prices.push(p);
  const more = prices.length === count && prices[count - 1] + stepPesewas <= top;
  return prices.map(cedisShort).join(', ') + (more ? '…' : '');
}

/**
 * A store's list of exact prices, as typed: "10,15,30,50" or "10, 15, 30, 50"
 * (commas, spaces, or both). Every entry must be a price on its own; the list
 * comes back ascending. At most 20, each once, each at most the ceiling.
 */
export function parsePriceList(input) {
  const parts = String(input ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!parts.length) return { ok: false, message: 'List the prices, like 10, 15, 30, 50.' };
  if (parts.length > 20) return { ok: false, message: 'An item can have at most 20 prices.' };

  const prices = [];
  for (const part of parts) {
    const pesewas = parseCedis(part);
    if (pesewas === null) {
      return { ok: false, message: `“${part}” is not a price. Use numbers like 10 or 12.50.` };
    }
    if (pesewas <= 0) return { ok: false, message: 'Every price must be more than zero.' };
    if (pesewas > MAX_ITEM_PRICE_PESEWAS) {
      return {
        ok: false,
        message: `The most a price can be is ${cedisShort(MAX_ITEM_PRICE_PESEWAS)}.`,
      };
    }
    if (prices.includes(pesewas)) {
      return {
        ok: false,
        message: `${cedisShort(pesewas)} is listed twice. List each price once.`,
      };
    }
    prices.push(pesewas);
  }
  return { ok: true, prices: prices.sort((a, b) => a - b) };
}

/**
 * The item's pricing, as the form sent it.
 *
 * NO FIELD, NO CHANGE: `pricing_mode` is only on the form for a store that holds
 * the capability. Returns { mode } for a fixed item, { value } — the arguments
 * for the database — for a variable one, or { message } naming what is wrong.
 *
 * The same checks the form runs as the vendor types (lib/util/item-price.js),
 * so the form and the server action cannot disagree; the database then checks again
 * and is the authority. The fixed price is read by parsePositiveCedis(), just as strictly.
 */
export function readPricingForm(formData) {
  const mode = String(formData.get('pricing_mode') ?? '').trim();
  if (!mode) return {};
  if (mode === 'FIXED') return { mode };

  if (mode === 'STEPPED') {
    // STRICT, and the empty maximum is "no maximum", never zero.
    const minText = String(formData.get('variable_min') ?? '').trim();
    const stepText = String(formData.get('variable_step') ?? '').trim();
    const maxText = String(formData.get('variable_max') ?? '').trim();
    const min = parseCedis(minText);
    const step = parseCedis(stepText);
    const max = maxText ? parseCedis(maxText) : null;
    if (min === null) return { message: 'The starting price must be a number, like 10 or 12.50.' };
    if (step === null) return { message: 'The step must be a number, like 5 or 2.50.' };
    if (maxText && max === null) {
      return { message: 'The maximum must be a number, like 50, or left empty.' };
    }

    const rule = checkSteppedRule({ minPesewas: min, stepPesewas: step, maxPesewas: max });
    if (!rule.ok) return { message: rule.message };

    return {
      mode,
      value: { mode, minPesewas: min, stepPesewas: step, maxPesewas: max, clearMax: !maxText },
    };
  }

  if (mode === 'CHOICES') {
    const list = parsePriceList(formData.get('variable_choices'));
    if (!list.ok) return { message: list.message };
    return { mode, value: { mode, choicesPesewas: list.prices } };
  }

  return { message: 'Choose how this item is priced.' };
}
