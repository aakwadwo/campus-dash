import { randomInt } from 'node:crypto';

/**
 * Human-spoken short codes. Digits only — these get read aloud across a noisy
 * counter, so no ambiguous letters.
 *
 * Generated with a CSPRNG: a guessable pickup code hands someone else's food to
 * the wrong Partner. Uniqueness and rotation are enforced in the database, not
 * here.
 */
function numericCode(length) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += randomInt(0, 10);
  return code;
}

/** Given to the Partner; the vendor checks it before handing over the food. */
export function generatePickupCode() {
  return numericCode(4);
}

/** Given to the customer; the Partner enters it to complete the delivery. */
export function generateDeliveryCode() {
  return numericCode(4);
}
