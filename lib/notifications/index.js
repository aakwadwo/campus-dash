import { getSmsProvider } from '@/lib/sms';
import { renderSms } from './templates';
import { NOTIFICATION_EVENT, AUDIENCE, CHANNEL } from './events';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Notification service.
 *
 * Business logic calls notify() with a domain event and a list of recipients;
 * it never talks to an SMS provider directly and never composes copy inline.
 *
 * Failures are logged and swallowed: a dropped SMS must not roll back a state
 * transition that already happened. Persisting a notification log and retrying
 * comes with the Phase 2 schema.
 */
export async function notify({ event, recipients, context, orderId = null }) {
  if (!NOTIFICATION_EVENT[event]) {
    throw new Error(`Unknown notification event: ${event}`);
  }

  const sms = getSmsProvider();

  const results = await Promise.all(
    recipients.map(async ({ audience, phone, userId = null }) => {
      const message = renderSms(event, audience, context);
      if (!message) return { audience, skipped: true, reason: 'no_template' };
      if (!phone) return { audience, skipped: true, reason: 'no_phone' };

      // A notification is identified by what it IS: this event, for this order,
      // to this recipient. Server actions retry and pages revalidate, and until
      // this check existed each of those could put a second identical SMS in
      // somebody's pocket — which costs real money and reads, to them, like the
      // system is broken.
      const dedupeKey = orderId ? `${event}:${audience}:${orderId}:${phone}` : null;
      if (dedupeKey && (await alreadySent(dedupeKey))) {
        return { audience, skipped: true, reason: 'already_sent' };
      }

      try {
        const result = await sms.send(phone, message, { tag: `${event}:${audience}` });
        await record({
          event,
          audience,
          phone,
          userId,
          orderId,
          succeeded: Boolean(result.ok),
          provider: sms.name,
          providerMessageId: result.providerMessageId,
          error: result.error ?? null,
        });
        return { audience, channel: CHANNEL.SMS, ...result };
      } catch (error) {
        console.error(`[notifications] ${event} -> ${audience} failed:`, error.message);
        await record({
          event,
          audience,
          phone,
          userId,
          orderId,
          succeeded: false,
          provider: sms.name,
          providerMessageId: null,
          error: error.message,
        });
        return { audience, ok: false, error: error.message };
      }
    })
  );

  return results;
}

/**
 * Writes the delivery record.
 *
 * Answers "did they actually get the code?" without becoming an analytics
 * product. Failures here are swallowed: losing the LOG of a message must never
 * be the reason a state transition rolls back.
 */
async function record({
  event,
  audience,
  phone,
  userId,
  orderId,
  succeeded,
  provider,
  providerMessageId,
  error,
}) {
  try {
    const supabase = createAdminClient();
    const { error: logError } = await supabase.rpc('record_notification', {
      p_event: event,
      p_audience: audience,
      p_channel: CHANNEL.SMS,
      p_recipient: phone,
      p_succeeded: succeeded,
      p_provider: provider,
      p_provider_message_id: providerMessageId ?? null,
      p_error: error ?? null,
      p_order_id: orderId,
      p_user_id: userId,
      p_dedupe_key: dedupeKey ?? null,
    });
    if (logError) console.error('[notifications] could not log delivery:', logError.message);
  } catch (caught) {
    console.error('[notifications] could not log delivery:', caught.message);
  }
}

export { NOTIFICATION_EVENT, AUDIENCE, CHANNEL };
