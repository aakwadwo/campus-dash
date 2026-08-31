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
