import { getSmsProvider } from '@/lib/sms';
import { renderSms } from './templates.js';
import { NOTIFICATION_EVENT, AUDIENCE, CHANNEL } from './events.js';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Notification service.
 *
 * Business logic calls notify() with a domain event and a list of recipients;
 * it never talks to an SMS provider directly and never composes copy inline.
 *
 *   application event → notify() → dedup → SmsProvider → Arkesel
 *
 * Failures are logged and swallowed: a dropped SMS must not roll back a state
 * transition that already happened. The order is real whether or not the
 * message arrived.
 *
 * The provider and the database client are injectable. That is not decoration:
 * without it this function could not be executed by a test at all, and for
 * months it was not — it carried two ReferenceErrors, one calling a helper that
 * did not exist and one reading a variable out of scope, so every order-scoped
 * notification threw and notifyOrderEvent() swallowed it. The dedup machinery
 * in the database had never once been reached.
 */
export async function notify({ event, recipients, context, orderId = null, deps = {} }) {
  if (!NOTIFICATION_EVENT[event]) {
    throw new Error(`Unknown notification event: ${event}`);
  }

  const sms = deps.sms ?? getSmsProvider();
  const db = deps.db ?? defaultDb();

  const results = await Promise.all(
    recipients.map(async ({ audience, phone, userId = null }) => {
      const message = renderSms(event, audience, context);
      if (!message) return { audience, skipped: true, reason: 'no_template' };
      if (!phone) return { audience, skipped: true, reason: 'no_phone' };

      // A notification is identified by what it IS: this event, for this order,
      // to this recipient. Server actions retry and pages revalidate, and
      // without this check each of those could put a second identical SMS in
      // somebody's pocket — which costs real money and reads, to them, like the
      // system is broken.
      const dedupeKey = orderId ? `${event}:${audience}:${orderId}:${phone}` : null;
      if (dedupeKey && (await db.alreadySent(dedupeKey))) {
        return { audience, skipped: true, reason: 'already_sent' };
      }

      // Generated BEFORE the send. Arkesel's v1 response carries no message id,
      // so this reference — handed to it in the callback URL and given back on
      // the delivery report — is the only way to match an outcome to a message.
      const correlationId = crypto.randomUUID();

      try {
        const result = await sms.send(phone, message, {
          tag: `${event}:${audience}`,
          idempotencyKey: correlationId,
        });

        await db.record({
          event,
          audience,
          phone,
          userId,
          orderId,
          succeeded: Boolean(result.ok),
          provider: sms.name,
          providerMessageId: result.providerMessageId ?? null,
          error: result.error ?? null,
          dedupeKey,
          correlationId,
        });

        return { audience, channel: CHANNEL.SMS, correlationId, ...result };
      } catch (error) {
        // A provider that throws rather than returning is still a failed send,
        // and it is recorded as one so a retry can find it.
        console.error(`[notifications] ${event} -> ${audience} failed:`, error.message);
        await db.record({
          event,
          audience,
          phone,
          userId,
          orderId,
          succeeded: false,
          provider: sms.name,
          providerMessageId: null,
          error: error.message,
          dedupeKey,
          correlationId,
        });
        return { audience, ok: false, error: error.message };
      }
    })
  );

  return results;
}

/**
 * The database side, in one object so a test can substitute it.
 *
 * Both calls are deliberately forgiving. Losing the LOG of a message must never
 * be the reason a state transition rolls back, and a dedup check that cannot
 * reach the database must fail OPEN — an SMS sent twice is a worse day than a
 * missed one, but an OTP that never arrives because the log was unreachable is
 * a customer who cannot sign in at all.
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
          p_audience: entry.audience,
          p_channel: CHANNEL.SMS,
          p_recipient: entry.phone,
          p_succeeded: entry.succeeded,
          p_provider: entry.provider,
          p_provider_message_id: entry.providerMessageId ?? null,
          p_error: entry.error ?? null,
          p_order_id: entry.orderId,
          p_user_id: entry.userId,
          p_dedupe_key: entry.dedupeKey ?? null,
          p_correlation_id: entry.correlationId ?? null,
        });
        if (error) console.error('[notifications] could not log delivery:', error.message);
      } catch (caught) {
        console.error('[notifications] could not log delivery:', caught.message);
      }
    },
  };
}

export { NOTIFICATION_EVENT, AUDIENCE, CHANNEL };
