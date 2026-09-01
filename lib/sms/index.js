import { FakeSmsProvider } from './fake.js';
import { ArkeselSmsProvider } from './arkesel.js';
import { config } from '@/lib/config';

let instance = null;

/**
 * Resolves the configured SmsProvider. Swapping providers is an env change
 * (SMS_PROVIDER) plus one new file in this folder — never a business-logic edit.
 *
 * This factory is the ONLY place Arkesel credentials are read. The adapter
 * takes them as constructor arguments, which is what keeps it testable without
 * a live account and keeps the key out of every other module.
 */
export function getSmsProvider() {
  if (instance) return instance;

  const name = config.smsProvider();
  switch (name) {
    case 'fake':
      instance = new FakeSmsProvider();
      break;
    case 'arkesel':
      instance = new ArkeselSmsProvider({
        apiKey: config.arkeselApiKey(),
        senderId: config.arkeselSenderId(),
        endpoint: config.arkeselSmsUrl(),
        // Without a public origin we simply do not ask for delivery reports.
        // Sending still works; we just never learn the outcome.
        callbackBaseUrl: config.publicAppUrl(),
      });
      break;
    default:
      throw new Error(`Unknown SMS_PROVIDER "${name}". Implemented providers: fake, arkesel.`);
  }
  return instance;
}

/** Tests and long-running processes that change SMS_PROVIDER mid-flight. */
export function resetSmsProvider() {
  instance = null;
}

export { SmsProvider, normaliseGhanaPhone } from './provider.js';
