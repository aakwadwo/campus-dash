/**
 * Stands in for `next/navigation` under the plain Node test runner.
 *
 * The real module pulls in the client router, which needs React's client build
 * and cannot load under `--conditions=react-server`. Server code only ever uses
 * the throwing helpers, so those are re-exported from Next's own
 * implementation: a redirect in a test throws the same NEXT_REDIRECT error, with
 * the same digest, that Next catches in a request.
 */
export {
  redirect,
  permanentRedirect,
  getURLFromRedirectError,
} from 'next/dist/client/components/redirect.js';
export { notFound } from 'next/dist/client/components/not-found.js';
