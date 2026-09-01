#!/usr/bin/env node
/**
 * Posts a correctly SIGNED delivery report at a running Campus Dash, exactly as
 * Arkesel would.
 *
 *   npm run sms:webhook -- <correlation-ref> [DELIVRD|UNDELIV|EXPIRED]
 *
 * Two things this is for:
 *
 *   1. Proving the endpoint accepts a genuine report without waiting for a real
 *      one, and that the notification row picks up the status.
 *   2. Proving it REFUSES a bad one — pass --tamper to send a valid signature
 *      over a modified payload, or --bad-signature to send nonsense. Both must
 *      come back 401.
 *
 * Sending the same report twice is safe and is the duplicate-webhook test: the
 * second is deduplicated on the webhook id and changes nothing.
 */

import { signArkeselWebhook } from '../lib/sms/arkesel-webhook.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [ref, status = 'DELIVRD'] = args.filter((a) => !a.startsWith('--'));

if (!ref) {
  console.error(
    '\nUsage: npm run sms:webhook -- <correlation-ref> [DELIVRD|UNDELIV|EXPIRED] ' +
      '[--tamper] [--bad-signature] [--id=<webhook-id>]\n'
  );
  process.exit(1);
}

const secret = process.env.ARKESEL_WEBHOOK_SECRET;
if (!secret) {
  console.error('\n  Set ARKESEL_WEBHOOK_SECRET in .env.local first. See docs/SMS.md.\n');
  process.exit(1);
}

const base = process.env.PUBLIC_APP_URL || 'http://127.0.0.1:3000';
const scheme = process.env.ARKESEL_WEBHOOK_SCHEME || 'timestamp.body:hex';
const webhookId = args.find((a) => a.startsWith('--id='))?.slice(5) ?? `wh_manual_${Date.now()}`;

// The signature covers the query string, because that is what carries the data.
const params = new URLSearchParams({ sms_id: `sms_manual_${Date.now()}`, status, ref });
const signedPayload = params.toString();

const headers = signArkeselWebhook({
  payload: signedPayload,
  secret,
  id: webhookId,
  scheme,
});

if (flags.has('--tamper')) {
  // Keep the signature, change the claim. This is the attack that matters.
  params.set('status', status === 'DELIVRD' ? 'UNDELIV' : 'DELIVRD');
}
if (flags.has('--bad-signature')) {
  headers['x-arkesel-webhook-signature'] = 'deadbeef'.repeat(8);
}

const url = `${base.replace(/\/+$/, '')}/api/sms/webhook/arkesel?${params.toString()}`;

console.log('\nCampus Dash — replaying a delivery report');
console.log(`  target:    ${base}/api/sms/webhook/arkesel`);
console.log(`  reference: ${ref}`);
console.log(`  status:    ${params.get('status')}`);
console.log(`  webhook id:${webhookId}`);
console.log(`  scheme:    ${scheme}`);
if (flags.has('--tamper')) console.log('  TAMPERED: payload changed after signing');
if (flags.has('--bad-signature')) console.log('  BAD SIGNATURE: deliberately invalid');
console.log('');

const response = await fetch(url, { method: 'GET', headers });
const body = await response.text();

console.log(`  HTTP ${response.status}`);
console.log(`  ${body}\n`);

const expectRejection = flags.has('--tamper') || flags.has('--bad-signature');
if (expectRejection) {
  console.log(
    response.status === 401
      ? '  Correct: the report was refused.\n'
      : `  WRONG: expected 401, got ${response.status}. The signature check is not doing its job.\n`
  );
  process.exitCode = response.status === 401 ? 0 : 1;
} else {
  process.exitCode = response.status === 200 ? 0 : 1;
}
