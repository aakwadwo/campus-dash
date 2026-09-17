import { FakeEmailProvider } from './fake.js';
import { ResendEmailProvider } from './resend.js';
import { config } from '@/lib/config';

let instance = null;

/**
 * Resolves the configured EmailProvider. Swapping providers is an env change
 * (EMAIL_PROVIDER) plus one new file in this folder — never a business-logic
 * edit.
 *
 * This factory is the ONLY place the Resend credential is read.
 */
export function getEmailProvider() {
  if (instance) return instance;

  const name = config.emailProvider();
  switch (name) {
    case 'fake':
      instance = new FakeEmailProvider();
      break;
    case 'resend':
      instance = new ResendEmailProvider({
        apiKey: config.resendApiKey(),
        fromAddress: config.emailFromAddress(),
      });
      break;
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${name}". Implemented providers: fake, resend.`);
  }
  return instance;
}

/** Tests and long-running processes that change EMAIL_PROVIDER mid-flight. */
export function resetEmailProvider() {
  instance = null;
}

export { EmailProvider, looksLikeEmail } from './provider.js';
