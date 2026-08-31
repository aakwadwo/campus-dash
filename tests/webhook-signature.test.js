import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature, signWebhook } from '../lib/auth/webhook-signature.js';

/**
 * The Send SMS Hook route is an SMS-sending endpoint. Signature verification is
 * the only thing stopping anyone who learns the URL from driving it.
 */
describe('send sms hook signature verification', () => {
  const secret = 'v1,whsec_dGVzdC1zZWNyZXQtZm9yLWNhbXB1cy1kYXNoLXVuaXQtdGVzdHM=';
  const body = JSON.stringify({ user: { phone: '233201234567' }, sms: { otp: '123456' } });

  test('a correctly signed request is accepted', () => {
    const headers = signWebhook({ body, secret });
    assert.equal(verifyWebhookSignature({ body, headers, secret }).valid, true);
  });

  test('a request with no signature headers is rejected', () => {
    const result = verifyWebhookSignature({ body, headers: {}, secret });
    assert.equal(result.valid, false);
    assert.match(result.reason, /missing webhook signature headers/);
  });

  test('a tampered body invalidates the signature', () => {
    const headers = signWebhook({ body, secret });
    const tampered = JSON.stringify({
      user: { phone: '233209999999' }, // attacker redirects the OTP
      sms: { otp: '123456' },
    });
    const result = verifyWebhookSignature({ body: tampered, headers, secret });
    assert.equal(result.valid, false);
    assert.match(result.reason, /signature mismatch/);
  });

  test('a signature made with a different secret is rejected', () => {
    const headers = signWebhook({ body, secret: 'v1,whsec_b3RoZXItc2VjcmV0LXZhbHVlLWhlcmU=' });
    assert.equal(verifyWebhookSignature({ body, headers, secret }).valid, false);
  });

  test('an old request is rejected, so a captured one cannot be replayed', () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = signWebhook({ body, secret, timestamp: now - 600 });
    const result = verifyWebhookSignature({ body, headers, secret, nowSeconds: now });
    assert.equal(result.valid, false);
    assert.match(result.reason, /timestamp outside tolerance/);
  });

  test('a request from the future is rejected too', () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = signWebhook({ body, secret, timestamp: now + 600 });
    assert.equal(verifyWebhookSignature({ body, headers, secret, nowSeconds: now }).valid, false);
  });

  test('a request within tolerance is accepted', () => {
    const now = Math.floor(Date.now() / 1000);
    const headers = signWebhook({ body, secret, timestamp: now - 60 });
    assert.equal(verifyWebhookSignature({ body, headers, secret, nowSeconds: now }).valid, true);
  });

  test('changing the webhook id invalidates the signature', () => {
    const headers = signWebhook({ body, secret, id: 'msg_one' });
    headers['webhook-id'] = 'msg_two';
    assert.equal(verifyWebhookSignature({ body, headers, secret }).valid, false);
  });

  test('a server with no secret configured rejects everything', () => {
    const headers = signWebhook({ body, secret });
    const result = verifyWebhookSignature({ body, headers, secret: undefined });
    assert.equal(result.valid, false);
    assert.match(result.reason, /no hook secret configured/);
  });

  test('one valid signature among several rotated ones is enough', () => {
    // During a secret rotation Supabase sends space-separated signatures.
    const good = signWebhook({ body, secret });
    const headers = {
      ...good,
      'webhook-signature': `v1,AAAAinvalidsignatureAAAA= ${good['webhook-signature']}`,
    };
    assert.equal(verifyWebhookSignature({ body, headers, secret }).valid, true);
  });

  test('a non-v1 signature scheme is not silently accepted', () => {
    const headers = signWebhook({ body, secret });
    headers['webhook-signature'] = headers['webhook-signature'].replace('v1,', 'v0,');
    const result = verifyWebhookSignature({ body, headers, secret });
    assert.equal(result.valid, false);
    assert.match(result.reason, /no v1 signature present/);
  });
});
