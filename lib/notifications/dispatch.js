import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { config } from '@/lib/config';
import { notify, NOTIFICATION_EVENT, AUDIENCE } from './index';

/**
 * Notifications that are NOT about one order's state.
 *
 * lib/orders/notify.js turns an order transition into messages. These are the
 * other three kinds: a capability decision (a store approved, a Partner turned
 * down), a broadcast to a pool of people none of whom owns the thing yet, and
 * money leaving.
 *
 * Every recipient list is resolved by a SERVICE-ONLY database function. That is
 * not ceremony: each of these returns somebody's phone number to a caller who
 * is not that person, so the question "who may be told" has to be answered by
 * the database and not by whichever screen happened to trigger it.
 *
 * Failures are logged and swallowed, for the same reason they are everywhere
 * else here: an approval that happened must not un-happen because an SMS did
 * not go out.
 */

/**
 * The link in every one of these messages.
 *
 * Falls back to the canonical production origin so a message is never sent
 * containing the word "null". PUBLIC_APP_URL is what makes it right on a
 * preview deployment.
 *
 * NO TRAILING SLASH, deliberately: callers append a path (`${appUrl()}/vendor`)
 * and config.publicAppUrl() strips one, so a slash here would put "//" in a link
 * somebody actually taps.
 */
function appUrl() {
  return config.publicAppUrl() ?? 'https://campusdash.app';
}

function rows(data) {
  return Array.isArray(data) ? data : data ? [data] : [];
}

async function serviceRpc(fn, args) {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

/**
 * Tell every eligible, available Partner that work exists.
 *
 * The message names no customer, no destination and no amount — see the
 * template. Eligibility (approved, available, not at capacity, no conflict of
 * interest) is re-derived in SQL from the same rules the offer list uses, so
 * nobody is texted about a job they would then be refused.
 *
 * Deduped per order per recipient by the notification layer, so a retried
 * transition does not buzz forty phones twice.
 */
export async function notifyPartnersOfOffer(orderId) {
  try {
    const partners = rows(await serviceRpc('partners_to_notify_of_offer', { p_order_id: orderId }));
    if (partners.length === 0) return { sent: 0, skipped: 0 };

    // WHICH ROUND OF OFFERS THIS IS. `dispatch_generation` moves whenever a
    // search reopens — a Partner cancelled, an administrator reassigned — and
    // folding it into the dedupe subject is what lets the order be broadcast
    // AGAIN to everybody eligible, including the Partners who were told the
    // first time and did not take it. Without it the second broadcast keyed on
    // the order alone, matched the first, and reached nobody at all.
    //
    // A retried transition within the SAME round still deduplicates, which is
    // the property this machinery existed for: forty phones do not buzz twice
    // because a server action ran twice.
    const generation = await dispatchGenerationOf(orderId);

    const results = await notify({
      event: NOTIFICATION_EVENT.DELIVERY_AVAILABLE,
      orderId,
      dedupeSubject: `${orderId}:gen:${generation}`,
      recipients: partners.map((p) => ({
        audience: AUDIENCE.PARTNER,
        phone: p.phone,
        userId: p.user_id,
      })),
      context: { appUrl: appUrl() },
    });

    return {
      sent: results.filter((r) => r.ok).length,
      skipped: results.filter((r) => r.skipped).length,
    };
  } catch (error) {
    console.error(`[dispatch] offer broadcast for ${orderId} failed:`, error.message);
    return { sent: 0, skipped: 0 };
  }
}

/**
 * Which round of offers an order is on. Zero if it cannot be read: a broadcast
 * that deduplicates too eagerly is a worse failure than one that buzzes twice,
 * so an unreadable generation falls back to the stable first-round key rather
 * than to a random one.
 */
async function dispatchGenerationOf(orderId) {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from('orders')
      .select('dispatch_generation')
      .eq('id', orderId)
      .maybeSingle();
    return data?.dispatch_generation ?? 0;
  } catch {
    return 0;
  }
}

/** A store was approved or turned down. Goes to the owner, never to the store. */
export async function notifyVendorDecision(vendorId, { approved }) {
  try {
    const owner = rows(await serviceRpc('vendor_owner_contact', { p_vendor_id: vendorId }))[0];
    // A catalogue-only vendor has no owner to congratulate, and that is not an
    // error — it is what NULL ownership means.
    if (!owner?.phone) return { sent: 0, skipped: 1 };

    const results = await notify({
      event: approved ? NOTIFICATION_EVENT.VENDOR_APPROVED : NOTIFICATION_EVENT.VENDOR_REJECTED,
      dedupeSubject: `vendor:${vendorId}:${approved ? 'approved' : 'rejected'}`,
      recipients: [{ audience: AUDIENCE.VENDOR, phone: owner.phone, userId: owner.user_id }],
      context: { appUrl: appUrl(), storeName: owner.store_name },
    });
    return { sent: results.filter((r) => r.ok).length, skipped: 0 };
  } catch (error) {
    console.error(`[dispatch] vendor decision for ${vendorId} failed:`, error.message);
    return { sent: 0, skipped: 0 };
  }
}

/** A Partner application was approved or turned down. */
export async function notifyPartnerDecision(userId, { approved }) {
  try {
    const supabase = createAdminClient();
    const { data: user } = await supabase
      .from('users')
      .select('id, phone')
      .eq('id', userId)
      .maybeSingle();
    if (!user?.phone) return { sent: 0, skipped: 1 };

    const results = await notify({
      event: approved ? NOTIFICATION_EVENT.PARTNER_APPROVED : NOTIFICATION_EVENT.PARTNER_REJECTED,
      dedupeSubject: `partner:${userId}:${approved ? 'approved' : 'rejected'}`,
      recipients: [{ audience: AUDIENCE.PARTNER, phone: user.phone, userId }],
      context: { appUrl: appUrl() },
    });
    return { sent: results.filter((r) => r.ok).length, skipped: 0 };
  } catch (error) {
    console.error(`[dispatch] partner decision for ${userId} failed:`, error.message);
    return { sent: 0, skipped: 0 };
  }
}

/**
 * A payout completed.
 *
 * Says an amount and a link, and NOT how the money arrived. An administrator
 * may settle by bank transfer, by mobile money or in cash; naming a rail the
 * operator did not use is worse than naming none, and the dashboard is the
 * record either way.
 *
 * ONLY A VENDOR IS TEXTED. A Partner settlement sends nothing: there is no
 * PARTNER template for this event, so the recipient below is skipped as
 * 'no_template' and the notification_events row still records the attempt.
 * This function is deliberately left as it is rather than branching on
 * payee_type — templates.js is where it is decided who hears about what, and a
 * second opinion here would be a second thing to keep in step.
 */
export async function notifyPayoutSent(payoutId) {
  try {
    const recipient = rows(
      await serviceRpc('payout_recipient_contact', { p_payout_id: payoutId })
    )[0];
    if (!recipient?.phone) return { sent: 0, skipped: 1 };

    const results = await notify({
      event: NOTIFICATION_EVENT.PAYOUT_SENT,
      dedupeSubject: `payout:${payoutId}`,
      recipients: [{ audience: recipient.payee_type, phone: recipient.phone }],
      context: { appUrl: appUrl(), amountPesewas: recipient.amount_pesewas },
    });
    return { sent: results.filter((r) => r.ok).length, skipped: 0 };
  } catch (error) {
    console.error(`[dispatch] payout notice for ${payoutId} failed:`, error.message);
    return { sent: 0, skipped: 0 };
  }
}
