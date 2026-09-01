/**
 * Installs the `@/` resolver for the test runner. Loaded with `--import`.
 *
 * Paired with `--conditions=react-server`, which is how `server-only` resolves
 * to its empty stub instead of throwing — the same condition Next.js uses when
 * it builds Server Components. Together these let a test import the real
 * application modules rather than a copy of them.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./alias-hooks.mjs', pathToFileURL(import.meta.filename));
