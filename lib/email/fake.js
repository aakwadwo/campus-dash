import { EmailProvider } from './provider.js';

/**
 * Development provider. Prints the message to the server console so an
 * operational email can be exercised end-to-end with no account and no cost.
 *
 * Unlike the fake SMS provider this does NOT feed /dev/inbox. That inbox exists
 * so a developer can read a code they are about to type into a form; an
 * operational email has no such second step, and putting admin mail on a page
 * that is reachable in development would be a habit worth not starting.
 */
export class FakeEmailProvider extends EmailProvider {
  get name() {
    return 'fake';
  }

  async send({ to, subject, text, tag = null }) {
    const providerMessageId = `fake_email_${crypto.randomUUID()}`;

    console.log(
      [
        '',
        '┌────────────────── FAKE EMAIL ──────────────────',
        `│ to:      ${to}`,
        `│ subject: ${subject}`,
        tag ? `│ tag:     ${tag}` : null,
        `│ id:      ${providerMessageId}`,
        '├────────────────────────────────────────────────',
        ...String(text)
          .split('\n')
          .map((line) => `│ ${line}`),
        '└────────────────────────────────────────────────',
        '',
      ]
        .filter(Boolean)
        .join('\n')
    );

    return { ok: true, providerMessageId };
  }
}
