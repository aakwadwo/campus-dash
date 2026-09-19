/**
 * Which number a Send SMS Hook payload should be delivered to.
 *
 * A sign-in code goes to the number on the account. A PHONE CHANGE code goes to
 * the NEW number, which GoTrue holds as `user.new_phone` until it is confirmed.
 * `sms.sms_type` names the flow when GoTrue sends it; when it is absent, a
 * pending new number on an account with no phone at all can only be a phone
 * change (a customer who signs in by email, verifying a number to open a store).
 *
 * Kept out of the route file because a route may only export its handlers, and
 * so it can be tested as the plain decision it is.
 */
export function recipientOf(payload) {
  const user = payload?.user ?? {};
  const type = payload?.sms?.sms_type ?? payload?.sms?.type ?? null;
  if (type === 'phone_change' && user.new_phone) return user.new_phone;
  if (!user.phone && user.new_phone) return user.new_phone;
  return user.phone ?? null;
}
