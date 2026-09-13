/**
 * A request's timing, for the Server-Timing header and one log line.
 *
 * Deliberately small and deliberately OPT-IN: it is used on the routes a phone
 * polls and on the payment webhook, where "was it the database or the network"
 * is the question a production measurement has to answer. Browser devtools
 * show Server-Timing next to the request, and Vercel's logs keep the line.
 *
 * Names are fixed tokens (db, app, total) — never an id, a path or anything a
 * caller supplied — so the header cannot leak what a request was about.
 */
export function startTiming() {
  const started = performance.now();
  const entries = [];

  return {
    /** Times one awaited step under `name`, and returns its result. */
    async measure(name, fn) {
      const at = performance.now();
      try {
        return await fn();
      } finally {
        entries.push([name, performance.now() - at]);
      }
    },

    /** `db;dur=12.3, total;dur=40.1` */
    header() {
      return [...entries, ['total', performance.now() - started]]
        .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
        .join(', ');
    },

    /** `db=12ms total=40ms`, for a log line. */
    summary() {
      return [...entries, ['total', performance.now() - started]]
        .map(([name, ms]) => `${name}=${Math.round(ms)}ms`)
        .join(' ');
    },
  };
}
