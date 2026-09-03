import { FakePaymentProvider } from './fake';
import { PaystackPaymentProvider } from './paystack';
import { config } from '@/lib/config';

/**
 * Held on globalThis rather than in a module variable.
 *
 * FakePaymentProvider keeps its pending transactions in memory, and Next's dev
 * server reloads modules on edit — which would otherwise lose a payment that was
 * mid-flight and make it look as though the provider had forgotten a charge. A
 * real provider keeps its own records, so this only matters for the fake one.
 */
const CACHE_KEY = Symbol.for('campus-dash.payment-provider');

/**
 * Resolves the configured PaymentProvider.
 *
 * This is the ONLY place payment credentials are read. The adapter takes them
 * as constructor arguments, which keeps the secret key out of every other
 * module and lets the adapter be tested against a stub fetch with no account.
 *
 * Nothing in order, allocation or settlement code knows which provider this
 * returned.
 */
export function getPaymentProvider() {
  if (globalThis[CACHE_KEY]) return globalThis[CACHE_KEY];

  let instance;
  const name = config.paymentProvider();
  switch (name) {
    case 'fake':
      instance = new FakePaymentProvider();
      break;
    case 'paystack':
      instance = new PaystackPaymentProvider({
        secretKey: config.paystackSecretKey(),
        apiUrl: config.paystackApiUrl(),
        // Where Paystack sends the customer back to. Without a public origin we
        // send none and Paystack falls back to the dashboard setting, which on
        // a preview deployment is the wrong origin entirely.
        callbackUrl: config.publicAppUrl() ? `${config.publicAppUrl()}/payment/callback` : null,
        transfersEnabled: config.paystackTransfersEnabled(),
      });
      break;
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Implemented providers: fake, paystack.`);
  }

  globalThis[CACHE_KEY] = instance;
  return instance;
}

/** Tests and long-running processes that change PAYMENT_PROVIDER mid-flight. */
export function resetPaymentProvider() {
  delete globalThis[CACHE_KEY];
}

export { PaymentProvider } from './provider';
