/**
 * Ghana public holidays, for working out which morning a store's money lands.
 *
 * Paystack pays Ghana cedis out on the next WORKING day, and a working day is
 * one that is neither a weekend nor a public holiday. So this file answers one
 * question — is this Ghana date a public holiday? — and nothing else.
 *
 * THREE KINDS OF DATE, because Ghana has three:
 *
 *   FIXED     the same date every year, in the Public Holidays and
 *             Commemorative Days Act as amended in 2025.
 *   COMPUTED  Good Friday and Easter Monday (from Easter), and Farmers' Day
 *             (the first Friday of December).
 *   DECLARED  what the Ministry of the Interior announces for a particular
 *             year: the Eid dates and Shaqq Day (the day after Eid al-Fitr,
 *             added by the 2025 amendment), which follow the moon, and any holiday it
 *             moves to another day. THIS LIST NEEDS A PERSON. When a
 *             declaration is made, add it here — a missing Eid shows the store
 *             a morning that is a day early, which is wrong but not harmful.
 *
 * A fixed or computed holiday that falls on a weekend is observed on the next
 * weekday that is not already a holiday, which is the usual declaration.
 * Pure data and pure functions: no server imports, safe in a test.
 */

// Month-day, every year.
const FIXED = [
  ['01-01', "New Year's Day"],
  ['01-07', 'Constitution Day'],
  ['03-06', 'Independence Day'],
  ['05-01', 'May Day'],
  ['07-01', 'Republic Day'],
  ['09-21', "Founders' Day"],
  ['12-25', 'Christmas Day'],
  ['12-26', 'Boxing Day'],
];

/**
 * Per-year declarations. `add` is a holiday on that date; `move` replaces a
 * fixed or computed date with the one it was declared to be observed on.
 */
export const DECLARED = {
  2026: {
    move: {
      '2026-01-07': '2026-01-09', // Constitution Day, observed on the Friday
      '2026-07-01': '2026-07-03', // Republic Day, observed on the Friday
    },
    add: {
      '2026-03-20': 'Eid al-Fitr',
      '2026-03-21': 'Shaqq Day',
      '2026-05-27': 'Eid al-Adha',
    },
  },
};

const DAY_MS = 86_400_000;

function key(date) {
  return date.toISOString().slice(0, 10);
}

function utc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

// Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

function firstFridayOfDecember(year) {
  const first = utc(year, 12, 1);
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return utc(year, 12, 1 + offset);
}

const cache = new Map();

/** Every public holiday observed in `year`, as a Map of YYYY-MM-DD → name. */
export function ghanaHolidays(year, declared = DECLARED) {
  const cacheable = declared === DECLARED;
  if (cacheable && cache.has(year)) return cache.get(year);

  const moved = declared[year]?.move ?? {};
  const base = [
    ...FIXED.map(([md, name]) => [`${year}-${md}`, name]),
    [key(new Date(easterSunday(year).getTime() - 2 * DAY_MS)), 'Good Friday'],
    [key(new Date(easterSunday(year).getTime() + DAY_MS)), 'Easter Monday'],
    [key(firstFridayOfDecember(year)), "Farmers' Day"],
  ].map(([day, name]) => [moved[day] ?? day, name]);

  const days = new Map(base);
  for (const [day, name] of Object.entries(declared[year]?.add ?? {})) days.set(day, name);

  // A weekend holiday is observed on the next free weekday. Walked in date
  // order so Christmas and Boxing Day on a weekend become Monday and Tuesday.
  for (const [day, name] of [...base].sort(([a], [b]) => a.localeCompare(b))) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) continue;
    let next = new Date(`${day}T00:00:00Z`);
    do {
      next = new Date(next.getTime() + DAY_MS);
    } while ([0, 6].includes(next.getUTCDay()) || days.has(key(next)));
    days.set(key(next), `${name} (observed)`);
  }

  if (cacheable) cache.set(year, days);
  return days;
}

export function isGhanaHoliday(dayKey, declared = DECLARED) {
  return ghanaHolidays(Number(dayKey.slice(0, 4)), declared).has(dayKey);
}
