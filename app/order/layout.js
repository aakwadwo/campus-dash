import { redirectVendorOnlyAccount } from '@/lib/auth/session';

/**
 * The marketplace segment: /order and every store under it.
 *
 * A VENDOR WHO IS NOT A CUSTOMER IS SENT TO THEIR STORE, and it happens HERE
 * rather than in the pages for one reason: loading.js. The pages below render
 * inside its streaming boundary, so a redirect from a page arrives as a 200
 * with a refresh tag in the stream, after the skeleton of the marketplace has
 * already been sent. A layout renders outside its own segment's boundary, so
 * the same redirect is a real 307 before a byte of the marketplace goes out.
 *
 * Everyone else passes through untouched, signed in or signed out. The rule is
 * vendorOnlyHome() in lib/auth/landing.js, shared with the homepage and the
 * account area.
 */
export default async function OrderLayout({ children }) {
  await redirectVendorOnlyAccount();
  return children;
}
