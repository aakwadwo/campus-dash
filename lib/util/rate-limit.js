/**
 * Fixed-window counters, held in memory.
 *
 * This exists for ONE job: stopping an unauthenticated caller from making us do
 * expensive work — specifically, writing an audit row per request. It is not a
 * general traffic limiter and it is deliberately not backed by the database,
 * because a limiter that writes to the database to decide whether to write to
 * the database protects nothing.
 *
 * WHAT IT DOES NOT DO. Each server instance keeps its own counters, so on a
 * platform that runs several of them the effective limit is the configured one
 * multiplied by the number of live instances. That is fine here: the goal is to
 * BOUND the flood, not to admit an exact number of requests. Anything stricter
 * would need shared state, which is a bigger change than the problem warrants.
 *
 * The counters are bounded too. An attacker rotating keys would otherwise turn
 * the defence into its own memory leak, so the map is swept of expired windows
 * and, once genuinely full, new keys are refused rather than admitted — the
 * safe direction for a limiter whose "deny" outcome is simply "do less work".
 */

/**
 * @param {object} options
 * @param {number} options.limit    requests admitted per key per window
 * @param {number} options.windowMs window length in milliseconds
 * @param {number} [options.maxKeys] distinct keys tracked before refusing new ones
 * @param {() => number} [options.now] clock, injectable so tests need no sleeps
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 5000, now = Date.now }) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`rate limiter needs a positive integer limit, got ${limit}`);
  }
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error(`rate limiter needs a positive integer windowMs, got ${windowMs}`);
  }

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const windows = new Map();

  function sweep(at) {
    for (const [key, window] of windows) {
      if (window.resetAt <= at) windows.delete(key);
    }
  }

  return {
    /**
     * Counts one request against `key`.
     *
     * `firstRejection` is true on exactly the request that crosses the limit,
     * which is what a caller should log on. Logging every rejected request
     * would just move the flood from the database to the log.
     */
    check(key) {
      const at = now();
      let window = windows.get(key);

      if (!window || window.resetAt <= at) {
        if (!window && windows.size >= maxKeys) {
          sweep(at);
          if (windows.size >= maxKeys) {
            // Full of live windows. Refuse without allocating another.
            return {
              allowed: false,
              count: null,
              saturated: true,
              firstRejection: false,
              retryAfterSeconds: Math.ceil(windowMs / 1000),
            };
          }
        }
        window = { count: 0, resetAt: at + windowMs };
        windows.set(key, window);
      }

      window.count += 1;
      const allowed = window.count <= limit;

      return {
        allowed,
        count: window.count,
        saturated: false,
        firstRejection: !allowed && window.count === limit + 1,
        retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - at) / 1000)),
      };
    },

    /** Drops every window. For tests, which share one process. */
    reset() {
      windows.clear();
    },

    /** Live window count, for tests asserting the bound holds. */
    get size() {
      return windows.size;
    },
  };
}
