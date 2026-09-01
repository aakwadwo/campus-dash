/**
 * Makes the application's own module specifiers resolvable by plain `node --test`.
 *
 * Next.js resolves two things Node does not: the `@/` alias from jsconfig.json,
 * and extensionless imports like `./templates` or `@/lib/sms`. That gap is the
 * whole reason the notification service had never been executed by a test — its
 * templates were covered and its wiring was checked at the source level, but the
 * runtime path, the part that actually sends, could not be imported at all. Two
 * ReferenceErrors lived in it undetected as a result.
 *
 * This resolves them the same way Next does, so tests import the real modules
 * rather than a copy that has drifted.
 */
import { pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Bare `./x` → `./x.js` → `./x/index.js`, as a bundler would. */
function withExtension(path) {
  if (existsSync(path) && !existsSync(join(path, 'index.js'))) return path;
  for (const candidate of [`${path}.js`, `${path}.mjs`, join(path, 'index.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return path;
}

/**
 * `next/headers` exists only inside a request, but is imported at module top
 * level by lib/supabase/server.js — so anything that transitively reaches it
 * cannot be imported outside Next at all. The stub throws if actually called.
 */
const STUBS = {
  'next/headers': join(ROOT, 'tests', 'helpers', 'stubs', 'next-headers.mjs'),
};

export async function resolve(specifier, context, nextResolve) {
  if (STUBS[specifier]) {
    return nextResolve(pathToFileURL(STUBS[specifier]).href, context);
  }

  if (specifier.startsWith('@/')) {
    const resolved = withExtension(join(ROOT, specifier.slice(2)));
    return nextResolve(pathToFileURL(resolved).href, context);
  }

  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const fromDir = dirname(fileURLToPath(context.parentURL));
    const resolved = withExtension(join(fromDir, specifier));
    return nextResolve(pathToFileURL(resolved).href, context);
  }

  // Bare package subpaths, extensionless. `next` publishes server.js, client.js
  // and friends with no "exports" map, so `import 'next/server'` resolves under
  // a bundler and not under plain ESM. Retrying with the extension is exactly
  // what the bundler does.
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw error;
    }
    if (specifier.startsWith('.') || specifier.startsWith('/') || extname(specifier)) throw error;
    return nextResolve(`${specifier}.js`, context);
  }
}
