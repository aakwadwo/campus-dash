import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { processPaymentWebhook, resetPaymentWebhookThrottle } from '@/lib/payments/webhook';
import { resetPaymentProvider, getPaymentProvider } from '@/lib/payments';

/**
 * Who is allowed to authenticate an event on this deployment.
 *
 * `/api/payments/webhook/[provider]` used to ignore its own path segment and
 * hand the payload to whichever adapter PAYMENT_PROVIDER happened to select.
 * The serious half of that was the fake adapter: its "signature" is the literal
 * header `x-fake-signature: fake-signature`, so a production deployment left on
 * `fake` had an effectively unauthenticated endpoint that can mark orders paid
 * and payouts PAID.
 *
 * Everything below stops BEFORE the database. That is not a convenience — it is
 * the assertion. The guard has to reject a request without recording anything,
 * so the only outcomes here are:
 *
 *   404 / 503  the guard refused; the adapter was never reached
 *   400        the guard passed and the adapter parsed the body
 *
 * A 400 is therefore the proof that a matching path gets through, and no test
 * here needs — or is allowed — a live Supabase project to say so.
 */
describe('the payment webhook provider guard', () => {
  const ORIGINAL = {
    provider: process.env.PAYMENT_PROVIDER,
    nodeEnv: process.env.NODE_ENV,
  };

  afterEach(() => {
    restore('PAYMENT_PROVIDER', ORIGINAL.provider);
    restore('NODE_ENV', ORIGINAL.nodeEnv);
    resetPaymentProvider();
    // The unverified-request counters are module-level state, and every
    // malformed body below counts against them. Without this the later tests
    // in this file would inherit the earlier ones' spending.
    resetPaymentWebhookThrottle();
  });

  function restore(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  /** Runs fn with PAYMENT_PROVIDER (and optionally NODE_ENV) set. */
  function withDeployment({ provider, production = false }, fn) {
    process.env.PAYMENT_PROVIDER = provider;
    process.env.NODE_ENV = production ? 'production' : 'test';
    resetPaymentProvider();
    return fn();
  }

  // Valid JSON that no adapter can turn into an event id, so the fake adapter
  // stops at "event has no id" rather than recording anything.
  const NO_EVENT_ID = '{}';
  // Not JSON at all, so any adapter throws inside handleWebhook and the handler
  // answers "malformed" — again without touching the database.
  const UNPARSEABLE = '{';

  const post = (provider, rawBody, headers = {}) =>
    processPaymentWebhook({ provider, rawBody, headers });

  // =========================================================================
  // The matching path gets through
  // =========================================================================
  test('/paystack reaches the Paystack adapter when Paystack is configured', async (t) => {
    if (!process.env.PAYSTACK_SECRET_KEY) return t.skip('no PAYSTACK_SECRET_KEY configured');

    await withDeployment({ provider: 'paystack' }, async () => {
      assert.equal(getPaymentProvider().name, 'paystack', 'this is the adapter being guarded');

      const result = await post('paystack', UNPARSEABLE);
      assert.equal(result.status, 400, 'the guard passed and the adapter parsed the body');
      assert.match(result.body.error, /malformed webhook/);
    });
  });

  test('the path segment is matched case- and whitespace-insensitively', async (t) => {
    if (!process.env.PAYSTACK_SECRET_KEY) return t.skip('no PAYSTACK_SECRET_KEY configured');

    await withDeployment({ provider: 'paystack' }, async () => {
      for (const asked of ['Paystack', 'PAYSTACK', ' paystack ']) {
        const result = await post(asked, UNPARSEABLE);
        assert.equal(result.status, 400, `"${asked}" should be the same provider`);
      }
    });
  });

  // =========================================================================
  // A mismatched path is refused before the payload is touched
  // =========================================================================
  test('/fake is refused on a Paystack deployment', async (t) => {
    if (!process.env.PAYSTACK_SECRET_KEY) return t.skip('no PAYSTACK_SECRET_KEY configured');

    await withDeployment({ provider: 'paystack' }, async () => {
      // The body is one the fake adapter would happily accept. It must not get
      // that far: the refusal is on the path, before anything is parsed.
      const result = await post('fake', '{"eventId":"evt_1","status":"SUCCEEDED"}', {
        'x-fake-signature': 'fake-signature',
      });
      assert.equal(result.status, 404);
      assert.equal(result.body.error, 'unknown payment provider');
    });
  });

  test('/paystack is refused on a fake deployment', async () => {
    await withDeployment({ provider: 'fake' }, async () => {
      const result = await post('paystack', UNPARSEABLE);
      assert.equal(result.status, 404, 'a real Paystack POST must not meet the fake adapter');
      assert.equal(result.body.error, 'unknown payment provider');
    });
  });

  test('an invented provider name is refused', async () => {
    await withDeployment({ provider: 'fake' }, async () => {
      for (const asked of ['hubtel', 'flutterwave', '', 'fake/../paystack']) {
        assert.equal((await post(asked, NO_EVENT_ID)).status, 404, `"${asked}" is not served here`);
      }
    });
  });

  test('naming no provider at all is refused, not waved through', async () => {
    await withDeployment({ provider: 'fake' }, async () => {
      assert.equal((await post(undefined, NO_EVENT_ID)).status, 404);
      assert.equal((await post(null, NO_EVENT_ID)).status, 404);
    });
  });

  test('the refusal never says which provider IS configured', async () => {
    await withDeployment({ provider: 'fake' }, async () => {
      const result = await post('paystack', UNPARSEABLE);
      assert.equal(JSON.stringify(result.body).includes('fake'), false);
    });
  });

  // =========================================================================
  // The fake adapter is not a production adapter
  // =========================================================================
  test('production refuses the fake provider outright', async () => {
    await withDeployment({ provider: 'fake', production: true }, async () => {
      // Correctly addressed, correctly "signed" by the fake adapter's own
      // rules, and still refused — because those rules are forgeable by anyone.
      const result = await post('fake', '{"eventId":"evt_forged","status":"SUCCEEDED"}', {
        'x-fake-signature': 'fake-signature',
      });
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'payments are not configured');
    });
  });

  test('production refuses the fake provider however the path is spelled', async () => {
    await withDeployment({ provider: 'fake', production: true }, async () => {
      for (const asked of ['fake', 'paystack', undefined]) {
        assert.equal((await post(asked, NO_EVENT_ID)).status, 503);
      }
    });
  });

  test('production is fine with a real provider', async (t) => {
    if (!process.env.PAYSTACK_SECRET_KEY) return t.skip('no PAYSTACK_SECRET_KEY configured');

    await withDeployment({ provider: 'paystack', production: true }, async () => {
      const result = await post('paystack', UNPARSEABLE);
      assert.equal(result.status, 400, 'the guard is about the fake adapter, not about production');
    });
  });

  test('a provider that cannot be built is a 503, not a crash', async () => {
    await withDeployment({ provider: 'hubtel' }, async () => {
      const result = await post('hubtel', NO_EVENT_ID);
      assert.equal(result.status, 503);
      assert.equal(result.body.error, 'payments are not configured');
    });
  });

  // =========================================================================
  // Local development is untouched
  // =========================================================================
  test('the fake adapter still works locally when the path names it', async () => {
    await withDeployment({ provider: 'fake' }, async () => {
      // Reached the adapter: this 400 comes from the fake adapter's own event,
      // which has no id, not from the guard.
      const result = await post('fake', NO_EVENT_ID);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /event has no id/);
    });
  });

  test('the in-process poller names the provider it just resolved', async () => {
    // lib/orders/payments.js hands processPaymentWebhook `provider.name` from
    // the very adapter it read the status from. That is the contract this
    // asserts: whatever getPaymentProvider() returns is accepted by the guard.
    await withDeployment({ provider: 'fake' }, async () => {
      const result = await post(getPaymentProvider().name, NO_EVENT_ID);
      assert.equal(result.status, 400, 'the guard passed');
      assert.match(result.body.error, /event has no id/);
    });
  });
});
