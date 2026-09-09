/**
 * The school domain, exactly.
 *
 * A separate module from the sign-in actions because those are a `'use server'`
 * file, and one of those may export nothing but async functions — a constant or
 * a plain helper there breaks the whole module at build time.
 *
 * Kept free of server-only imports so it can be tested as the pure decision it
 * is, and imported from a client component if a form ever wants to pre-validate.
 */
export const SCHOOL_DOMAIN = '@acity.edu.gh';

/**
 * Normalises a school address, or returns null.
 *
 * The domain check anchors the END of the string. A lookalike like
 * `someone@acity.edu.gh.evil.example` contains the domain but does not end with
 * it, and would pass a naive `includes`. The database applies the same anchored
 * rule in complete_customer_onboarding(); this is the courtesy copy that gives a
 * useful message before the round trip, not the enforcement.
 */
export function normaliseSchoolEmail(value) {
  const email = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!email.endsWith(SCHOOL_DOMAIN)) return null;

  // Something has to precede the domain, and it cannot contain another @.
  const local = email.slice(0, -SCHOOL_DOMAIN.length);
  if (!local || local.includes('@') || /\s/.test(local)) return null;
  return email;
}
