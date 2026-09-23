/**
 * The three doors: customer, vendor and administrator sign-in, and store
 * registration. None of them is a page anybody should land on from a search
 * result — a sign-in form has no content, and /login/admin is deliberately not
 * linked from anywhere public. Set once here so a new door cannot forget it;
 * robots.js refuses /login and /vendor as well.
 */
export const metadata = {
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }) {
  return children;
}
