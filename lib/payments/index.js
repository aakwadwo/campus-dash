import { FakePaymentProvider } from './fake';
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
 * Adding Hubtel or Paystack later means one new file implementing
 * PaymentProvider plus a case here. No order, allocation or settlement code
 * should need to change.
 */
export function getPaymentProvider() {
  if (globalThis[CACHE_KEY]) return globalThis[CACHE_KEY];

  let instance;
  const name = config.paymentProvider();
  switch (name) {
    case 'fake':
      instance = new FakePaymentProvider();
      break;
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Implemented providers: fake.`);
  }

  globalThis[CACHE_KEY] = instance;
  return instance;
}

export { PaymentProvider } from './provider';
