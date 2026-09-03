#!/usr/bin/env node
/**
 * Opens ONE real Paystack checkout, against whatever key is in your
 * environment, and then reads it back.
 *
 *   npm run paystack:test
 *   npm run paystack:test -- 250 you@example.com
 *
 * With a TEST key (sk_test_…) this costs nothing and moves no money: it proves
 * the credential works, that the adapter speaks the API correctly, and that GHS
 * amounts survive the round trip as integer pesewas. It REFUSES to run against
 * a live key, because "one real checkout" means something very different there.
 *
 * It goes through the real PaystackPaymentProvider — the same class the
 * application uses — so a success here means the adapter and the credentials
 * are genuinely working, not that a curl command happened to.
 *
 * Nothing is written to our database. This talks to Paystack and nothing else.
 */

import { randomUUID } from 'node:crypto';

import { PaystackPaymentProvider } from '../lib/payments/paystack.js';

const secretKey = process.env.PAYSTACK_SECRET_KEY;

if (!secretKey) {
  console.error('\n  Set PAYSTACK_SECRET_KEY in .env.local first. See docs/PAYMENTS.md.\n');
  process.exit(1);
}

if (!secretKey.startsWith('sk_test_')) {
  console.error(
    '\n  PAYSTACK_SECRET_KEY is not a TEST key.\n' +
      '  This script opens a real checkout and will not run against a live account.\n'
  );
  process.exit(1);
}

const amountPesewas = Number(process.argv[2] ?? 100);
const customerEmail = process.argv[3] ?? 'campus-dash-test@example.com';

if (!Number.isInteger(amountPesewas) || amountPesewas <= 0) {
  console.error(`\n  "${process.argv[2]}" is not a whole number of pesewas.\n`);
  process.exit(1);
}

// A throwaway id, so this never collides with a real payment.
const reference = randomUUID();
const callbackBaseUrl = process.env.PUBLIC_APP_URL ?? null;

console.log('\nCampus Dash — one real Paystack TEST checkout');
console.log(`  amount:    ${amountPesewas} pesewas (GH₵${(amountPesewas / 100).toFixed(2)})`);
console.log(`  email:     ${customerEmail}`);
console.log(`  reference: ${reference}`);
console.log(`  endpoint:  ${process.env.PAYSTACK_API_URL || 'https://api.paystack.co'}`);
console.log(
  `  callback:  ${callbackBaseUrl ? `${callbackBaseUrl}/payment/callback` : 'none (PUBLIC_APP_URL not set)'}\n`
);

const provider = new PaystackPaymentProvider({
  secretKey,
  apiUrl: process.env.PAYSTACK_API_URL,
  callbackUrl: callbackBaseUrl ? `${callbackBaseUrl}/payment/callback` : null,
  // Never from a script. Transfers move real money even in a funded test account.
  transfersEnabled: false,
});

const collection = await provider.initiateCollection({
  idempotencyKey: `manual-test-${reference}`,
  amountPesewas,
  customerEmail,
  reference,
  metadata: { source: 'npm run paystack:test' },
});

console.log('  initialised');
console.log(`    status:       ${collection.status}`);
console.log(`    checkout:     ${collection.redirectUrl}`);
console.log(`    transaction:  ${collection.providerTransactionId}\n`);

// The authoritative read — the same call the browser return and the polling
// screen both go through.
const verified = await provider.getStatus(reference);

console.log('  verified back');
console.log(`    status:       ${verified.status}`);
console.log(`    amount:       ${verified.amountPesewas} pesewas`);

if (verified.amountPesewas !== null && verified.amountPesewas !== amountPesewas) {
  console.error(
    `\n  MISMATCH: asked for ${amountPesewas} pesewas, Paystack reports ${verified.amountPesewas}.\n`
  );
  process.exit(1);
}

console.log(
  '\n  The credential, the adapter and the GHS pesewa round trip all work.\n' +
    '  Open the checkout URL above to complete it with a Paystack test card;\n' +
    '  nothing in our database is touched by this script either way.\n'
);
