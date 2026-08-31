import { FakeSmsProvider } from './fake';
import { config } from '@/lib/config';

let instance = null;

/**
 * Resolves the configured SmsProvider. Swapping providers is an env change
 * (SMS_PROVIDER) plus one new file in this folder — never a business-logic edit.
 */
export function getSmsProvider() {
  if (instance) return instance;

  const name = config.smsProvider();
  switch (name) {
    case 'fake':
      instance = new FakeSmsProvider();
      break;
    default:
      throw new Error(`Unknown SMS_PROVIDER "${name}". Implemented providers: fake.`);
  }
  return instance;
}

export { SmsProvider, normaliseGhanaPhone } from './provider';
