/**
 * Stands in for `next/headers` under the plain Node test runner.
 *
 * `next/headers` only exists inside a request. Modules like
 * lib/supabase/server.js import it at the top level, so importing anything that
 * transitively reaches them — lib/orders/transitions.js, for instance — fails
 * outright outside Next.
 *
 * It throws rather than returning an empty cookie store on purpose. A test that
 * genuinely needs a signed-in user's client should fail loudly and be rewritten
 * around the service-role path, not quietly get a session belonging to nobody.
 *
 * THE ONE EXCEPTION IS EXPLICIT. withRequestCookies() runs a function inside a
 * simulated request carrying exactly the cookies it is given — a real Supabase
 * session minted against the local stack, or none at all. It exists so the
 * admin action guard can be exercised as a browser POST would reach it. Outside
 * that wrapper, cookies() still throws.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const request = new AsyncLocalStorage();

/**
 * @param {Record<string, string>} initial cookie name → value
 * @param {(jar: Map<string, {value: string, options?: object}>) => Promise<T>} fn
 */
export function withRequestCookies(initial, fn) {
  const jar = new Map(Object.entries(initial).map(([name, value]) => [name, { value }]));
  return request.run(jar, () => fn(jar));
}

function storeFor(jar) {
  return {
    get: (name) => (jar.has(name) ? { name, value: jar.get(name).value } : undefined),
    getAll: () => [...jar].map(([name, { value }]) => ({ name, value })),
    has: (name) => jar.has(name),
    set: (name, value, options) => {
      if (options?.maxAge === 0) jar.delete(name);
      else jar.set(name, { value, options });
    },
    delete: (name) => jar.delete(name),
  };
}

export function cookies() {
  const jar = request.getStore();
  if (jar) return storeFor(jar);
  throw new Error(
    'next/headers is not available outside a request. A test reaching for a ' +
      'user-scoped Supabase client should use tests/helpers/db.js instead.'
  );
}

export function headers() {
  throw new Error('next/headers is not available outside a request.');
}

export function draftMode() {
  return { isEnabled: false };
}
