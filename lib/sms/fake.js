import { SmsProvider } from './provider';
import { record } from './dev-inbox.js';

/**
 * Development provider. Prints the message to the server console so phone OTP
 * and every order notification can be exercised end-to-end with no external
 * account, no cost and no real handset.
 *
 * It also hands the message to the development inbox (see ./dev-inbox), which
 * is what makes /dev/inbox work. That call lives HERE rather than in the
 * SmsProvider base class on purpose: no real provider can then accumulate
 * message bodies, whatever anyone adds later.
 */

export class FakeSmsProvider extends SmsProvider {
  get name() {
    return 'fake';
  }

  async send(phoneNumber, message, options = {}) {
    const providerMessageId = `fake_sms_${crypto.randomUUID()}`;

    record({
      id: providerMessageId,
      phoneNumber,
      message,
      tag: options.tag ?? null,
      sentAt: new Date().toISOString(),
    });

    console.log(
      [
        '',
        '┌─────────────────── FAKE SMS ───────────────────',
        `│ to:   ${phoneNumber}`,
        options.tag ? `│ tag:  ${options.tag}` : null,
        `│ id:   ${providerMessageId}`,
        '├────────────────────────────────────────────────',
        ...message.split('\n').map((line) => `│ ${line}`),
        '└────────────────────────────────────────────────',
        '',
      ]
        .filter(Boolean)
        .join('\n')
    );

    return { ok: true, providerMessageId };
  }
}
