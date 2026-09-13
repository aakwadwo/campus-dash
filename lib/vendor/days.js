/**
 * Trading days, as the database counts them.
 *
 * orders.order_day is the UTC calendar date — which in Ghana is the local date,
 * with no daylight saving to shift it — and the daily queue number restarts on
 * the same boundary. Everything here keys off that string so "Today" on a
 * dashboard and 001 on the counter always mean the same day.
 *
 * Pure functions, no server imports, so both a page and a client component can
 * use them.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD for the current trading day. */
export function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function isDayKey(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** "Today", "Yesterday", or "Mon 8 Sep". */
export function dayLabel(key, now = new Date()) {
  const today = todayKey(now);
  if (key === today) return 'Today';
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (key === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "Saturday 13 September" — for a page title. */
export function longDayLabel(key) {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}
