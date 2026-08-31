import { SmsProvider } from './provider';

/**
 * Development provider. Prints the message to the server console so phone OTP
 * and every order notification can be exercised end-to-end with no external
 * account, no cost and no real handset.
 */
export class FakeSmsProvider extends SmsProvider {
  get name() {
    return 'fake';
  }

  async send(phoneNumber, message, options = {}) {
    const providerMessageId = `fake_sms_${crypto.randomUUID()}`;

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
