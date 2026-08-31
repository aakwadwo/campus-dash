import { FakePaymentProvider } from './fake';
import { config } from '@/lib/config';

let instance = null;

/**
 * Resolves the configured PaymentProvider.
 *
 * Adding Hubtel or Paystack later means one new file implementing
 * PaymentProvider plus a case here. No order, allocation or settlement code
 * should need to change.
 */
export function getPaymentProvider() {
  if (instance) return instance;

  const name = config.paymentProvider();
  switch (name) {
    case 'fake':
      instance = new FakePaymentProvider();
      break;
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Implemented providers: fake.`);
  }
  return instance;
}

export { PaymentProvider } from './provider';
