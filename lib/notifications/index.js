import { getSmsProvider } from '@/lib/sms';
import { renderSms } from './templates';
import { NOTIFICATION_EVENT, AUDIENCE, CHANNEL } from './events';

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
export async function notify({ event, recipients, context }) {
  if (!NOTIFICATION_EVENT[event]) {
    throw new Error(`Unknown notification event: ${event}`);
  }

  const sms = getSmsProvider();

  const results = await Promise.all(
    recipients.map(async ({ audience, phone }) => {
      const message = renderSms(event, audience, context);
      if (!message) return { audience, skipped: true, reason: 'no_template' };
      if (!phone) return { audience, skipped: true, reason: 'no_phone' };

      try {
        const result = await sms.send(phone, message, { tag: `${event}:${audience}` });
        return { audience, channel: CHANNEL.SMS, ...result };
      } catch (error) {
        console.error(`[notifications] ${event} -> ${audience} failed:`, error.message);
        return { audience, ok: false, error: error.message };
      }
    })
  );

  return results;
}

export { NOTIFICATION_EVENT, AUDIENCE, CHANNEL };
