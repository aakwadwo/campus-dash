// Pins the service-role client at the local stack BEFORE anything reads
// configuration. Nothing below is meant to reach a database at all, but
// `.env.local` may name a hosted project and a webhook handler's job is to
// write rows — so the belt and the braces are both worth having.
import './helpers/local-supabase.js';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimiter } from '@/lib/util/rate-limit';
import { processPaymentWebhook, resetPaymentWebhookThrottle } from '@/lib/payments/webhook';
import { resetPaymentProvider } from '@/lib/payments';

/**
 * Throttling the unverified half of the payment webhook.
 *
 * The endpoint records every attempt so that forged callbacks are visible. That
 * is also what made it floodable: vary the event id and an attacker with no
 * signing key writes webhook_events rows for as long as they care to.
 *
 * The requirement has two halves, and the second is the one worth guarding:
 *
 *   1. an unverified flood stops writing rows;
 *   2. a REAL provider is never affected by it. Paystack retries what it thinks
 *      failed, so a limiter in front of the HMAC would eventually drop money.
 *
 * Everything below stops before the database — the assertions are about which
 * status comes back, not about what was stored.
 */
describe('the payment webhook throttle', () => {
  const ORIGINAL = {
    provider: process.env.PAYMENT_PROVIDER,
    nodeEnv: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.PAYMENT_PROVIDER = 'fake';
    process.env.NODE_ENV = 'test';
    resetPaymentProvider();
    resetPaymentWebhookThrottle();
  });

  afterEach(() => {
    restore('PAYMENT_PROVIDER', ORIGINAL.provider);
    restore('NODE_ENV', ORIGINAL.nodeEnv);
    resetPaymentProvider();
    resetPaymentWebhookThrottle();
  });

  function restore(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  // Not JSON, so no adapter can have signed it. The cheapest unverified request.
  const UNPARSEABLE = '{';
  // Valid JSON the fake adapter accepts but cannot turn into an event id, so a
  // SIGNED request stops at "event has no id" without touching the database.
  const SIGNED_NO_ID = ['{}', { 'x-fake-signature': 'fake-signature' }];

  const post = (rawBody, headers = {}) =>
    processPaymentWebhook({ provider: 'fake', rawBody, headers });

  const from = (ip) => ({ 'x-forwarded-for': ip });

  // =========================================================================
  // The flood stops
  // =========================================================================
  test('unverified requests are served up to the limit, then refused', async () => {
    const headers = from('203.0.113.5');

    for (let i = 1; i <= 10; i += 1) {
      const result = await post(UNPARSEABLE, headers);
      assert.equal(result.status, 400, `request ${i} is still recorded and answered normally`);
    }

    const refused = await post(UNPARSEABLE, headers);
    assert.equal(refused.status, 429, 'the eleventh is refused without reaching the database');
    assert.equal(refused.body.error, 'too many unverified requests');
    assert.match(refused.headers['retry-after'], /^\d+$/, 'and says when to come back');
  });

  test('an invalid signature is throttled on the same budget', async () => {
    const headers = from('203.0.113.6');
    // Parses cleanly, but carries no x-fake-signature header, so the adapter
    // reports the signature invalid — the parsed-but-forged shape, which the
    // malformed-body test above cannot reach.
    //
    // NO eventId, deliberately. The throttle is consulted at the signature
    // check, which comes first, so the counting is fully exercised — while the
    // missing id stops the request before record_webhook_event(). Give these
    // bodies an id and the test writes a row per request into whichever project
    // the environment happens to name, which for a hosted .env.local is the
    // real one. Every assertion in this file stops short of the database.
    const forged = () => JSON.stringify({ status: 'SUCCEEDED' });

    for (let i = 1; i <= 10; i += 1) {
      const result = await post(forged(), headers);
      assert.equal(result.status, 400, `forgery ${i} is still served, not throttled`);
      assert.match(result.body.error, /event has no id/);
    }

    assert.equal(
      (await post(forged(), headers)).status,
      429,
      'the signature failures were counted'
    );
  });

  test('a body far larger than any real event is refused before it is parsed', async () => {
    const huge = `{"padding":"${'x'.repeat(1_100_000)}"}`;
    const result = await post(huge, from('203.0.113.7'));
    assert.equal(result.status, 413);
    assert.equal(result.body.error, 'webhook body is too large');
  });

  // =========================================================================
  // A real provider is never caught by it
  // =========================================================================
  test('a correctly signed event is served after the limit is exhausted', async () => {
    const headers = from('203.0.113.8');
    for (let i = 0; i < 15; i += 1) await post(UNPARSEABLE, headers);
    assert.equal((await post(UNPARSEABLE, headers)).status, 429, 'the budget is spent');

    // Same caller, same window — but this one authenticated, so the counters
    // are never consulted. This is the assertion that protects Paystack's
    // retries, and money with them.
    const signed = await processPaymentWebhook({
      provider: 'fake',
      rawBody: SIGNED_NO_ID[0],
      headers: { ...headers, ...SIGNED_NO_ID[1] },
    });
    assert.equal(signed.status, 400, 'a verified event is not throttled');
    assert.equal(signed.body.error, 'event has no id, so it cannot be deduplicated');
  });

  test('one hostile caller does not spend another caller’s budget', async () => {
    for (let i = 0; i < 11; i += 1) await post(UNPARSEABLE, from('203.0.113.9'));
    assert.equal((await post(UNPARSEABLE, from('203.0.113.9'))).status, 429);

    const other = await post(UNPARSEABLE, from('198.51.100.4'));
    assert.equal(other.status, 400, 'a different address starts with a full budget');
  });

  // =========================================================================
  // The distributed case
  // =========================================================================
  test('a flood spread across many addresses still hits the global backstop', async () => {
    let refused = 0;
    // Each address stays under the per-client limit, so only the global counter
    // can stop this.
    for (let i = 0; i < 60; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        const result = await post(UNPARSEABLE, from(`198.51.100.${i}`));
        if (result.status === 429) refused += 1;
      }
    }
    assert.ok(refused > 0, 'the global limit refused the tail of the flood');
  });
});

/**
 * The counter itself.
 *
 * Exercised through an injected clock rather than by sleeping, so the window
 * behaviour is actually asserted instead of approximated.
 */
describe('the fixed-window rate limiter', () => {
  test('admits exactly the limit, then refuses', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });
    const allowed = [1, 2, 3, 4, 5].map(() => limiter.check('k').allowed);
    assert.deepEqual(allowed, [true, true, true, false, false]);
  });

  test('flags only the request that crosses the limit', () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
    const flags = [1, 2, 3, 4].map(() => limiter.check('k').firstRejection);
    assert.deepEqual(
      flags,
      [false, false, true, false],
      'one log line per window, not per request'
    );
  });

  test('the budget returns when the window rolls over', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => clock });

    assert.equal(limiter.check('k').allowed, true);
    assert.equal(limiter.check('k').allowed, false);

    clock = 1000;
    assert.equal(limiter.check('k').allowed, true, 'a new window, a new budget');
  });

  test('retryAfterSeconds counts down within the window', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => clock });
    limiter.check('k');
    clock = 30_000;
    assert.equal(limiter.check('k').retryAfterSeconds, 30);
  });

  test('key rotation cannot grow the map without bound', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 10 });
    for (let i = 0; i < 500; i += 1) limiter.check(`key-${i}`);
    assert.ok(limiter.size <= 10, `bounded at maxKeys, got ${limiter.size}`);
  });

  test('a saturated limiter refuses rather than admitting new keys', () => {
    const limiter = createRateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 2 });
    limiter.check('a');
    limiter.check('b');

    const overflow = limiter.check('c');
    assert.equal(overflow.allowed, false, 'refusing is the safe direction here');
    assert.equal(overflow.saturated, true);
    assert.equal(limiter.check('a').allowed, true, 'an established key is unaffected');
  });

  test('expired windows are swept, so the map recovers', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, maxKeys: 3, now: () => clock });
    limiter.check('a');
    limiter.check('b');
    limiter.check('c');

    clock = 2000;
    assert.equal(limiter.check('d').allowed, true, 'the dead windows made room');
  });

  test('a nonsensical configuration is refused outright', () => {
    assert.throws(() => createRateLimiter({ limit: 0, windowMs: 1000 }), /positive integer limit/);
    assert.throws(() => createRateLimiter({ limit: 1, windowMs: 0 }), /positive integer windowMs/);
  });
});
