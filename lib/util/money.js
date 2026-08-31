/**
 * Money is ALWAYS an integer number of pesewas (1 GHS = 100 pesewas).
 * Floats never touch an amount — not in the database, not in transit, not here.
 */
export const CURRENCY = 'GHS';

export function pesewasToCedis(pesewas) {
  assertPesewas(pesewas);
  return pesewas / 100;
}

/** Display only. Never feed the result back into a calculation. */
export function formatPesewas(pesewas) {
  assertPesewas(pesewas);
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  return `${sign}GH₵${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function assertPesewas(value) {
  if (!Number.isInteger(value)) {
    throw new Error(`Amount must be an integer number of pesewas, got ${value}`);
  }
  return value;
}

export function sumPesewas(amounts) {
  return amounts.reduce((total, amount) => total + assertPesewas(amount), 0);
}

/**
 * Parses a human price ("35", "35.5", "35.50", "GH₵35.50") into integer pesewas.
 *
 * Deliberately string-based. `Math.floor(parseFloat(x) * 100)` is the obvious
 * version and it is wrong: parseFloat('19.99') * 100 is 1998.9999999999998, so
 * a GH₵19.99 item is stored as GH₵19.98 and underpriced on every sale for ever.
 * Same for 0.29, 1.15, 2.55, 4.35 and plenty of other ordinary prices.
 *
 * @throws when the input is not a valid price
 */
export function pesewasFromCedisInput(input) {
  const text = String(input ?? '')
    .replace(/[₵GHSghs\s,]/g, '')
    .trim();

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new Error(
      `"${input}" is not a valid price. Use cedis with at most two decimals, e.g. 35.50`
    );
  }

  const [cedis, fraction = ''] = text.split('.');
  const pesewas = Number(cedis) * 100 + Number(fraction.padEnd(2, '0'));

  if (pesewas <= 0) throw new Error('Price must be greater than zero.');
  return pesewas;
}

/** Inverse of the above, for pre-filling an edit form. */
export function cedisInputFromPesewas(pesewas) {
  assertPesewas(pesewas);
  return `${Math.floor(pesewas / 100)}.${String(pesewas % 100).padStart(2, '0')}`;
}
