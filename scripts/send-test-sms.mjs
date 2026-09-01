#!/usr/bin/env node
/**
 * Sends ONE real SMS through Arkesel, to a number you name.
 *
 *   npm run sms:test -- 0201234567
 *
 * THIS SPENDS REAL CREDIT. It is the only thing in this repository that does,
 * which is why it is a script you run deliberately and never part of `npm test`.
 * A test suite that costs money per run is a suite people stop running.
 *
 * It goes through the real ArkeselSmsProvider — the same class the application
 * uses — so a success here means the adapter, the credentials and the sender ID
 * are all genuinely working, not that a curl command happened to.
 */

import { ArkeselSmsProvider } from '../lib/sms/arkesel.js';
import { normaliseGhanaPhone } from '../lib/sms/provider.js';

const target = process.argv[2];
if (!target) {
  console.error('\nUsage: npm run sms:test -- 0201234567\n');
  process.exit(1);
}

const phone = normaliseGhanaPhone(target);
if (!phone) {
  console.error(`\n  "${target}" is not a Ghanaian phone number.\n`);
  process.exit(1);
}

const apiKey = process.env.ARKESEL_API_KEY;
const senderId = process.env.ARKESEL_SENDER_ID;

if (!apiKey || !senderId) {
  console.error(
    '\n  Set ARKESEL_API_KEY and ARKESEL_SENDER_ID in .env.local first.\n' + '  See docs/SMS.md.\n'
  );
  process.exit(1);
}

const callbackBaseUrl = process.env.PUBLIC_APP_URL ?? null;
const correlationId = `manual-test-${Date.now()}`;

console.log('\nCampus Dash — one real SMS through Arkesel');
console.log(`  to:        ${phone}`);
console.log(`  sender:    ${senderId}`);
console.log(`  endpoint:  ${process.env.ARKESEL_SMS_URL || 'https://sms.arkesel.com/sms/api'}`);
console.log(
  `  callback:  ${callbackBaseUrl ? `${callbackBaseUrl}/api/sms/webhook/arkesel` : 'none (PUBLIC_APP_URL not set)'}`
);
console.log(`  reference: ${correlationId}\n`);

const provider = new ArkeselSmsProvider({
  apiKey,
  senderId,
  endpoint: process.env.ARKESEL_SMS_URL,
  callbackBaseUrl,
});

const result = await provider.send(
  phone,
  `Campus Dash test message. Reference ${correlationId}. No action needed.`,
  { idempotencyKey: correlationId, tag: 'MANUAL_TEST' }
);

if (result.ok) {
  console.log('  ACCEPTED by Arkesel.');
  if (result.balance !== null) console.log(`  Remaining balance: ${result.balance}`);
  console.log(
    '\n  Accepted is not delivered. Watch the handset, and — if PUBLIC_APP_URL\n' +
      '  is set and reachable — the delivery report will arrive at\n' +
      '  /api/sms/webhook/arkesel within a minute or two.\n'
  );
} else {
  console.error(`  REJECTED: ${result.error}`);
  if (result.providerCode) console.error(`  Arkesel code: ${result.providerCode}`);
  console.error('\n  See the troubleshooting table in docs/SMS.md.\n');
  process.exitCode = 1;
}
