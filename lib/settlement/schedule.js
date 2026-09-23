import { isGhanaHoliday, DECLARED } from './ghana-holidays';

/**
 * When a store's money arrives.
 *
 * A store with a Paystack subaccount is not paid by Campus Dash. Its share is
 * split off each charge and Paystack settles it to the store's mobile money on
 * the NEXT WORKING DAY — Paystack's published schedule for Ghana cedis, and the
 * default every subaccount Campus Dash creates is left on. A working day is
 * neither a weekend nor a Ghana public holiday. So:
 *
 *   paid Friday, Saturday or Sunday  →  Monday morning
 *   ... and if that Monday is a public holiday  →  Tuesday morning
 *
 * Paystack does not promise an hour, so neither does this: "morning" and no
 * more. Money is treated as arrived from the morning it is due, so on a Monday
 * the weekend's sales have left "pending" and Monday's own are due Tuesday.
 *
 * Money a store is owed through the ledger instead (no subaccount yet) does
 * not follow this calendar at all — a settlement run pays it — and is reported
 * separately rather than given a day nobody has promised.
 *
 * Pure functions over Ghana calendar days (YYYY-MM-DD), no server imports.
 */

const DAY_MS = 86_400_000;
const GHANA = 'Africa/Accra';

/** Today's date in Ghana, as YYYY-MM-DD. */
export function ghanaDayKey(now = new Date()) {
  // en-CA formats as YYYY-MM-DD. Africa/Accra is UTC+0 with no daylight
  // saving, but it is named so the rule reads as what it is: a Ghana day.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: GHANA,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(dayKey, days) {
  return new Date(new Date(`${dayKey}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function isWorkingDay(dayKey, declared = DECLARED) {
  const weekday = new Date(`${dayKey}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isGhanaHoliday(dayKey, declared);
}

/** The morning Paystack settles money a customer paid on `paidDay`. */
export function settlementDay(paidDay, declared = DECLARED) {
  let day = addDays(paidDay, 1);
  while (!isWorkingDay(day, declared)) day = addDays(day, 1);
  return day;
}

/**
 * What the store's screen says.
 *
 * `rows` is vendor_payout_days(): one row per (paid_day, settlement_channel).
 * Returns the split money not yet due and the first morning any of it lands,
 * plus whatever the ledger still owes through a settlement run.
 */
export function payoutOutlook(rows, now = new Date(), declared = DECLARED) {
  const today = ghanaDayKey(now);
  let pendingPesewas = 0;
  let heldPesewas = 0;
  let nextPayoutDay = null;

  for (const row of rows ?? []) {
    const amount = Number(row.amount_pesewas) || 0;
    if (!amount) continue;
    if (row.settlement_channel !== 'SPLIT') {
      heldPesewas += amount;
      continue;
    }
    const day = settlementDay(String(row.paid_day).slice(0, 10), declared);
    if (day <= today) continue;
    pendingPesewas += amount;
    if (!nextPayoutDay || day < nextPayoutDay) nextPayoutDay = day;
  }

  return { pendingPesewas, nextPayoutDay, heldPesewas };
}

/** "Tomorrow morning", "Monday morning", or "Tue 29 Dec, morning". */
export function payoutDayLabel(dayKey, now = new Date()) {
  const today = ghanaDayKey(now);
  if (dayKey === addDays(today, 1)) return 'Tomorrow morning';
  const date = new Date(`${dayKey}T00:00:00Z`);
  if (dayKey <= addDays(today, 6)) {
    return `${date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })} morning`;
  }
  return `${date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })}, morning`;
}
