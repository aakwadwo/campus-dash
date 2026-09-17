import { getEmailProvider, looksLikeEmail } from '@/lib/email';
import { createAdminClient } from '@/lib/supabase/admin';
import { config } from '@/lib/config';
import { NOTIFICATION_EVENT, AUDIENCE, CHANNEL } from './events.js';

/**
 * Operational email to whoever runs the pilot.
 *
 * SEPARATE FROM notify() ON PURPOSE. That function is SMS end to end — it
 * renders from SMS_TEMPLATES, skips a recipient with no phone number, and
 * records every row as CHANNEL.SMS. Teaching it a second transport would mean
 * rewriting the one path every order notification in the system already takes,
 * to add a message that no order depends on. This is the smaller and safer
 * shape: the same dedup table, the same forgiving semantics, its own send.
 *
 * NOTHING HERE MAY THROW AT THE CALLER. Every caller is reporting something
 * that has ALREADY happened and been committed. An email that did not go out is
 * a worse day for an administrator, not a failed operation for a vendor.
 */

/** The account number is shown as the last three digits, never in full. */
export function maskAccountNumber(value) {
  const digits = String(value ?? '').replace(/\s/g, '');
  if (!digits) return 'not on file';
  return digits.length <= 3 ? `…${digits}` : `…${digits.slice(-3)}`;
}

/**
 * The subaccount notice, as plain text.
 *
 * Plain text rather than HTML because there is nothing here that a layout would
 * make clearer, and a text part is the one thing every mail client renders the
 * same way. Exported so a test can assert the contents without sending.
 */
export function renderSubaccountCreatedEmail({
  vendorName,
  accountName,
  subaccountCode,
  momoNetwork,
  accountNumber,
  settlementSchedule,
  createdAt,
}) {
  return [
    `${vendorName} now has a Paystack subaccount, and Paystack confirmed it.`,
    '',
    'From the next order this store is paid for, their share of the charge is',
    'routed straight to this account as the customer pays. Nothing needs doing.',
    '',
    `Store            : ${vendorName}`,
    `Account name     : ${accountName || 'not on file'}`,
    `Subaccount code  : ${subaccountCode}`,
    `Network          : ${momoNetwork || 'not on file'}`,
    `Account number   : ${maskAccountNumber(accountNumber)}`,
    `Settlement       : ${settlementSchedule || 'not reported by Paystack'}`,
    `Created          : ${createdAt}`,
  ].join('\n');
}

/**
 * Tells the administrators a vendor subaccount was created.
 *
 * IDEMPOTENT TWICE OVER. The caller only reaches this on the branch where
 * Paystack actually issued a code — a destination that is already registered
 * returns before it — and the dedupe key below is keyed on the subaccount code
 * itself, so a retry that somehow got here again finds the row and sends
 * nothing. A genuinely NEW subaccount has a new code and is a new notification,
 * which is right: changing a payout number clears the old code and registers a
 * fresh one, and that is a thing an administrator wants to hear about.
 */
export async function notifyAdminSubaccountCreated({
  vendorName,
  accountName = null,
  subaccountCode,
  momoNetwork = null,
  accountNumber = null,
  settlementSchedule = null,
  createdAt = null,
  deps = {},
} = {}) {
  // An INJECTED recipient wins, including an explicit null. `??` against the
  // config would make "there is deliberately no recipient" indistinguishable
  // from "nothing was injected", which silently reads the real environment —
  // and a test asserting the no-recipient path would then pass or fail
  // depending on whose machine it ran on.
  const recipient = 'recipient' in deps ? deps.recipient : config.adminNotificationEmail();

  // A deployment with no address configured is quiet, not broken. Nothing is
  // recorded either: there is no recipient to key a notification on.
  if (!recipient) return { skipped: 'no_admin_email' };
  if (!looksLikeEmail(recipient)) {
    console.error(`[notifications] ADMIN_NOTIFICATION_EMAIL is not an address: ${recipient}`);
    return { skipped: 'bad_admin_email' };
  }
  if (!subaccountCode) return { skipped: 'no_subaccount_code' };

  const email = deps.email ?? getEmailProvider();
  const db = deps.db ?? defaultDb();

  const event = NOTIFICATION_EVENT.VENDOR_SUBACCOUNT_CREATED;
  const dedupeKey = `${event}:${AUDIENCE.ADMIN}:${subaccountCode}:${recipient}`;

  if (await db.alreadySent(dedupeKey)) {
    return { skipped: 'already_sent' };
  }

  const subject = 'Campus Dash: Vendor Paystack Subaccount Created';
  const text = renderSubaccountCreatedEmail({
    vendorName: vendorName || 'A vendor',
    accountName,
    subaccountCode,
    momoNetwork,
    accountNumber,
    settlementSchedule,
    createdAt: createdAt ?? new Date().toISOString(),
  });

  try {
    const result = await email.send({ to: recipient, subject, text, tag: event });

    await db.record({
      event,
      recipient,
      succeeded: Boolean(result.ok),
      provider: email.name,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
      dedupeKey,
    });

    return { channel: CHANNEL.EMAIL, recipient, ...result };
  } catch (error) {
    // A provider that throws rather than returning is still a failed send, and
    // it is recorded as one so a person can find it.
    console.error(`[notifications] ${event} -> ADMIN failed:`, error.message);
    await db.record({
      event,
      recipient,
      succeeded: false,
      provider: email.name,
      providerMessageId: null,
      error: error.message,
      dedupeKey,
    });
    return { ok: false, error: error.message };
  }
}

/**
 * The database side, in one object so a test can substitute it.
 *
 * Forgiving in both directions, exactly as notify()'s is: losing the LOG of a
 * message must not be the reason anything rolls back, and a dedup check that
 * cannot reach the database fails OPEN. A duplicate operational email is a
 * nuisance; a silently missing one is a vendor nobody knows is set up.
 */
function defaultDb() {
  return {
    async alreadySent(dedupeKey) {
      try {
        const supabase = createAdminClient();
        const { data, error } = await supabase.rpc('notification_already_sent', {
          p_dedupe_key: dedupeKey,
        });
        if (error) {
          console.error('[notifications] dedup check failed:', error.message);
          return false;
        }
        return Boolean(data);
      } catch (caught) {
        console.error('[notifications] dedup check failed:', caught.message);
        return false;
      }
    },

    async record(entry) {
      try {
        const supabase = createAdminClient();
        const { error } = await supabase.rpc('record_notification', {
          p_event: entry.event,
          p_audience: AUDIENCE.ADMIN,
          p_channel: CHANNEL.EMAIL,
          p_recipient: entry.recipient,
          p_succeeded: entry.succeeded,
          p_provider: entry.provider,
          p_provider_message_id: entry.providerMessageId ?? null,
          p_error: entry.error ?? null,
          p_order_id: null,
          p_user_id: null,
          p_dedupe_key: entry.dedupeKey ?? null,
          p_correlation_id: null,
        });
        if (error) console.error('[notifications] could not log delivery:', error.message);
      } catch (caught) {
        console.error('[notifications] could not log delivery:', caught.message);
      }
    },
  };
}
