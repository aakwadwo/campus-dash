// Pins the service-role client at the local stack before anything reads config.
import './helpers/local-supabase.js';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  PaystackPaymentProvider,
  PaystackError,
  MOMO_BANK_CODE,
} from '../lib/payments/paystack.js';
import { getPaymentProvider, resetPaymentProvider } from '../lib/payments/index.js';
import { initiationOutcomeFor } from '../lib/settlement/index.js';

/**
 * The Paystack adapter, against a stub `fetch`.
 *
 * No account, no network, no credit spent. Everything that matters here is a
 * decision the adapter makes about a response — which is exactly what a live
 * call would not let us assert, because we cannot make Paystack return a
 * mismatched currency or a duplicate reference on demand.
 *
 * The one thing NOT stubbed is the signature maths. That is real HMAC-SHA512
 * against a real key, because a signature check that passes only against its
 * own implementation checks nothing.
 */

const SECRET = 'sk_test_stub_key_for_unit_tests_only';
const PAYMENT_ID = '11111111-1111-4111-8111-111111111111';
const PAYOUT_ID = '22222222-2222-4222-8222-222222222222';

/** A stub `fetch` that replays canned responses and records what it was asked. */
function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];

  const impl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

function providerWith(fetchImpl, options = {}) {
  return new PaystackPaymentProvider({
    secretKey: SECRET,
    apiUrl: 'https://api.paystack.test',
    callbackUrl: 'https://campus.example/payment/callback',
    fetchImpl,
    ...options,
  });
}

function sign(body, secret = SECRET) {
  return createHmac('sha512', secret).update(body, 'utf8').digest('hex');
}

describe('paystack — opening a checkout', () => {
  test('a successful initialisation returns the hosted checkout URL', async () => {
    const fetchImpl = stubFetch({
      body: {
        status: true,
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          access_code: 'abc123',
          reference: PAYMENT_ID,
        },
      },
    });

    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: `order:x:attempt:1`,
      amountPesewas: 4235,
      customerEmail: 'ama@example.com',
      reference: PAYMENT_ID,
      metadata: { orderId: 'order-1' },
    });

    assert.equal(result.status, 'PENDING');
    assert.equal(result.redirectUrl, 'https://checkout.paystack.com/abc123');
    // The reference is our own payment id, which is what verify and the webhook
    // both key on.
    assert.equal(result.providerTransactionId, PAYMENT_ID);

    const [call] = fetchImpl.calls;
    assert.match(call.url, /\/transaction\/initialize$/);
    assert.equal(call.options.headers.Authorization, `Bearer ${SECRET}`);
    // GHS minor unit IS the pesewa. The integer crosses unchanged.
    assert.equal(call.body.amount, 4235);
    assert.equal(call.body.currency, 'GHS');
    assert.equal(call.body.email, 'ama@example.com');
    assert.equal(call.body.reference, PAYMENT_ID);
    assert.equal(call.body.callback_url, 'https://campus.example/payment/callback');
  });

  test('a rejected initialisation raises with what Paystack said', async () => {
    const fetchImpl = stubFetch({
      ok: false,
      status: 400,
      body: { status: false, message: 'Invalid email address passed' },
    });

    await assert.rejects(
      providerWith(fetchImpl).initiateCollection({
        idempotencyKey: 'k',
        amountPesewas: 1000,
        customerEmail: 'not-an-email',
        reference: PAYMENT_ID,
      }),
      (error) => {
        assert.ok(error instanceof PaystackError);
        assert.match(error.message, /Invalid email address/);
        return true;
      }
    );
  });

  test('a duplicate reference is a retry, not a second charge', async () => {
    // The same reference means the same payment. Paystack refuses it; the right
    // answer is to go and read what that transaction is doing, not to open
    // another one.
    const fetchImpl = stubFetch([
      {
        ok: false,
        status: 400,
        body: { status: false, message: 'Duplicate Transaction Reference' },
      },
      {
        body: {
          status: true,
          data: {
            id: 998,
            status: 'success',
            amount: 4235,
            currency: 'GHS',
            reference: PAYMENT_ID,
          },
        },
      },
    ]);

    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k',
      amountPesewas: 4235,
      customerEmail: 'ama@example.com',
      reference: PAYMENT_ID,
    });

    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.providerTransactionId, PAYMENT_ID);
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[1].url, /\/transaction\/verify\//);
  });

  test('no email, no checkout — and no address is ever invented', async () => {
    await assert.rejects(
      providerWith(stubFetch({ body: { status: true, data: {} } })).initiateCollection({
        idempotencyKey: 'k',
        amountPesewas: 1000,
        reference: PAYMENT_ID,
      }),
      /email/
    );
  });

  test('a non-integer or negative amount never reaches Paystack', async () => {
    const fetchImpl = stubFetch({ body: { status: true, data: {} } });
    const provider = providerWith(fetchImpl);

    for (const amount of [42.5, 0, -100]) {
      await assert.rejects(
        provider.initiateCollection({
          idempotencyKey: 'k',
          amountPesewas: amount,
          customerEmail: 'a@b.com',
          reference: PAYMENT_ID,
        }),
        /positive integer/
      );
    }
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('paystack — reading a transaction', () => {
  test('a successful transaction reports SUCCEEDED and its amount in pesewas', async () => {
    const fetchImpl = stubFetch({
      body: {
        status: true,
        data: { id: 1, status: 'success', amount: 4235, currency: 'GHS', reference: PAYMENT_ID },
      },
    });

    const status = await providerWith(fetchImpl).getStatus(PAYMENT_ID);
    assert.equal(status.status, 'SUCCEEDED');
    assert.equal(status.amountPesewas, 4235);
  });

  test('an amount in the wrong currency is refused rather than believed', async () => {
    // 4235 NGN is not 4235 pesewas. Reporting a null amount makes
    // confirm_payment() raise a mismatch, which is the correct outcome — the
    // alternative is a number that is right as an integer and wrong as money.
    const fetchImpl = stubFetch({
      body: {
        status: true,
        data: { id: 1, status: 'success', amount: 4235, currency: 'NGN', reference: PAYMENT_ID },
      },
    });

    const status = await providerWith(fetchImpl).getStatus(PAYMENT_ID);
    assert.equal(status.status, 'SUCCEEDED');
    assert.equal(status.amountPesewas, null);
  });

  test('an abandoned checkout is CANCELLED, and a failed one FAILED', async () => {
    for (const [paystack, ours] of [
      ['abandoned', 'CANCELLED'],
      ['failed', 'FAILED'],
      ['reversed', 'FAILED'],
      ['ongoing', 'PENDING'],
    ]) {
      const fetchImpl = stubFetch({
        body: { status: true, data: { status: paystack, amount: 100, currency: 'GHS' } },
      });
      const status = await providerWith(fetchImpl).getStatus(PAYMENT_ID);
      assert.equal(status.status, ours, `${paystack} should map to ${ours}`);
    }
  });

  test('a transaction Paystack cannot describe is a finding, not a success', async () => {
    const fetchImpl = stubFetch({
      ok: false,
      status: 404,
      body: { status: false, message: 'Transaction reference not found' },
    });
    const status = await providerWith(fetchImpl).getStatus('missing');
    assert.equal(status.status, 'FAILED');
    assert.equal(status.amountPesewas, null);
  });

  test('an unknown provider status is PENDING, never SUCCEEDED', async () => {
    const fetchImpl = stubFetch({
      body: { status: true, data: { status: 'something_new', amount: 100, currency: 'GHS' } },
    });
    assert.equal((await providerWith(fetchImpl).getStatus('x')).status, 'PENDING');
  });
});

describe('paystack — webhook signatures', () => {
  const provider = providerWith(stubFetch({ body: {} }));
  const body = JSON.stringify({ event: 'charge.success', data: { id: 1 } });

  test('a correctly signed body is accepted', () => {
    assert.equal(provider.verifySignature(body, sign(body)), true);
  });

  test('a tampered body invalidates the signature', () => {
    const signature = sign(body);
    const tampered = JSON.stringify({ event: 'charge.success', data: { id: 2 } });
    assert.equal(provider.verifySignature(tampered, signature), false);
  });

  test('a signature made with a different secret is rejected', () => {
    assert.equal(provider.verifySignature(body, sign(body, 'sk_test_someone_else')), false);
  });

  test('a missing or malformed signature is false, never a throw', () => {
    // processPaymentWebhook still wants to RECORD the attempt, flagged. Throwing
    // here would turn a probe into a 500 and lose the trail.
    for (const value of [undefined, null, '', 'abc', 123, {}]) {
      assert.equal(provider.verifySignature(body, value), false);
    }
  });

  test('the signature covers the exact bytes received', () => {
    // Re-serialising a parsed object changes whitespace and key order, and the
    // hash with it. This is why the route reads the raw body.
    const raw = '{"event":"charge.success",  "data":{"id":1}}';
    const signature = sign(raw);
    assert.equal(provider.verifySignature(raw, signature), true);
    assert.equal(provider.verifySignature(JSON.stringify(JSON.parse(raw)), signature), false);
  });
});

describe('paystack — normalising webhook events', () => {
  const provider = providerWith(stubFetch({ body: {} }));

  const deliver = (payload, { signed = true } = {}) => {
    const rawBody = JSON.stringify(payload);
    return provider.handleWebhook({
      rawBody,
      headers: signed ? { 'x-paystack-signature': sign(rawBody) } : {},
    });
  };

  test('charge.success is a COLLECTION carrying our payment id', async () => {
    const event = await deliver({
      event: 'charge.success',
      data: { id: 4001, status: 'success', amount: 4235, currency: 'GHS', reference: PAYMENT_ID },
    });

    assert.equal(event.kind, 'collection');
    assert.equal(event.status, 'SUCCEEDED');
    assert.equal(event.reference, PAYMENT_ID);
    assert.equal(event.amountPesewas, 4235);
    assert.equal(event.signatureValid, true);
  });

  test('transfer.success is a TRANSFER carrying our payout id', async () => {
    const event = await deliver({
      event: 'transfer.success',
      data: {
        id: 7001,
        status: 'success',
        amount: 3150,
        currency: 'GHS',
        transfer_code: 'TRF_abc',
        reference: PAYOUT_ID,
      },
    });

    assert.equal(event.kind, 'transfer');
    assert.equal(event.status, 'SUCCEEDED');
    // The transfer code is what later lookups agree on.
    assert.equal(event.providerTransactionId, 'TRF_abc');
    assert.equal(event.reference, PAYOUT_ID);
  });

  test('transfer.failed is a TRANSFER at FAILED', async () => {
    const event = await deliver({
      event: 'transfer.failed',
      data: { id: 7002, status: 'failed', transfer_code: 'TRF_def', reference: PAYOUT_ID },
    });
    assert.equal(event.kind, 'transfer');
    assert.equal(event.status, 'FAILED');
  });

  test('a collection and a transfer are never confused for one another', async () => {
    // This is the property that keeps a payout id out of confirmPayment(): the
    // kind is decided here, from the event name, before anything is looked up.
    const collection = await deliver({ event: 'charge.success', data: { id: 1, reference: 'r' } });
    const transfer = await deliver({ event: 'transfer.success', data: { id: 1, reference: 'r' } });
    assert.equal(collection.kind, 'collection');
    assert.equal(transfer.kind, 'transfer');
    // Same numeric id, same reference, DIFFERENT dedup anchors.
    assert.notEqual(collection.eventId, transfer.eventId);
  });

  test('the event id is stable across redeliveries, so retries deduplicate', async () => {
    const payload = {
      event: 'charge.success',
      data: { id: 4001, status: 'success', amount: 100, currency: 'GHS', reference: PAYMENT_ID },
    };
    const first = await deliver(payload);
    const second = await deliver(payload);

    assert.equal(first.eventId, second.eventId);
    assert.equal(first.eventId, 'charge.success:4001');
  });

  test('an unsigned event is normalised but flagged, never trusted', async () => {
    const event = await deliver(
      { event: 'charge.success', data: { id: 1, status: 'success', amount: 100, currency: 'GHS' } },
      { signed: false }
    );
    assert.equal(event.signatureValid, false);
    // Still parsed, so the attempt can be recorded rather than lost.
    assert.equal(event.status, 'SUCCEEDED');
  });

  test('an event Paystack invents later is PENDING, and is still deduplicable', async () => {
    const event = await deliver({ event: 'charge.dispute.create', data: { id: 5150 } });
    assert.equal(event.status, 'PENDING');
    assert.equal(event.eventId, 'charge.dispute.create:5150');
  });
});

describe('paystack — transfers', () => {
  const destination = {
    momoNetwork: 'MTN',
    accountNumber: '0551234567',
    accountName: 'Ama Mensah',
  };

  test('transfers are OFF by default, and nothing is sent', async () => {
    const fetchImpl = stubFetch({ body: { status: true, data: {} } });

    await assert.rejects(
      providerWith(fetchImpl).sendTransfer({
        idempotencyKey: 'payout:1',
        amountPesewas: 3150,
        recipient: { recipientCode: 'RCP_x' },
        reference: PAYOUT_ID,
      }),
      (error) => {
        assert.equal(error.code, 'transfers_disabled');
        return true;
      }
    );
    // The important assertion: Paystack was never called at all.
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('a transfer with no recipient is refused before any call', async () => {
    const fetchImpl = stubFetch({ body: { status: true, data: {} } });
    await assert.rejects(
      providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
        idempotencyKey: 'payout:1',
        amountPesewas: 3150,
        recipient: {},
        reference: PAYOUT_ID,
      }),
      (error) => {
        assert.equal(error.code, 'no_recipient');
        return true;
      }
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('an accepted transfer is PENDING on our side — acceptance is not arrival', async () => {
    const fetchImpl = stubFetch({
      body: {
        status: true,
        data: { transfer_code: 'TRF_abc', id: 7001, status: 'pending', reference: PAYOUT_ID },
      },
    });

    const result = await providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
      idempotencyKey: 'payout:1',
      amountPesewas: 3150,
      recipient: { recipientCode: 'RCP_x' },
      reference: PAYOUT_ID,
    });

    assert.equal(result.status, 'PENDING');
    assert.equal(result.providerTransferId, 'TRF_abc');

    const [call] = fetchImpl.calls;
    assert.equal(call.body.amount, 3150);
    assert.equal(call.body.currency, 'GHS');
    assert.equal(call.body.recipient, 'RCP_x');
    // Our payout id, so the transfer webhook can be matched back to it.
    assert.equal(call.body.reference, PAYOUT_ID);
  });

  test('a transfer awaiting an OTP is PENDING too, not a failure', async () => {
    const fetchImpl = stubFetch({
      body: { status: true, data: { transfer_code: 'TRF_otp', status: 'otp' } },
    });
    const result = await providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
      idempotencyKey: 'k',
      amountPesewas: 100,
      recipient: { recipientCode: 'RCP_x' },
      reference: PAYOUT_ID,
    });
    assert.equal(result.status, 'PENDING');
  });

  test('a refused transfer raises with the provider reason', async () => {
    const fetchImpl = stubFetch({
      ok: false,
      status: 400,
      body: { status: false, message: 'Your balance is not enough to fulfil this request' },
    });

    await assert.rejects(
      providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
        idempotencyKey: 'k',
        amountPesewas: 100000,
        recipient: { recipientCode: 'RCP_x' },
        reference: PAYOUT_ID,
      }),
      /balance is not enough/
    );
  });

  test('recipients map our network names onto Paystack Ghana bank codes', async () => {
    for (const [ours, theirs] of Object.entries(MOMO_BANK_CODE)) {
      const fetchImpl = stubFetch({
        body: { status: true, data: { recipient_code: `RCP_${theirs}` } },
      });

      const result = await providerWith(fetchImpl, {
        transfersEnabled: true,
      }).ensureTransferRecipient({ ...destination, momoNetwork: ours });

      assert.equal(result.recipientCode, `RCP_${theirs}`);
      const [call] = fetchImpl.calls;
      assert.match(call.url, /\/transferrecipient$/);
      assert.equal(call.body.type, 'mobile_money');
      assert.equal(call.body.bank_code, theirs);
      assert.equal(call.body.account_number, '0551234567');
      assert.equal(call.body.currency, 'GHS');
    }
  });

  test('the three networks Paystack Ghana supports are the three we offer', () => {
    assert.deepEqual(Object.keys(MOMO_BANK_CODE).sort(), ['AIRTELTIGO', 'MTN', 'VODAFONE']);
  });

  test('an unsupported network is refused before any call', async () => {
    const fetchImpl = stubFetch({ body: { status: true, data: {} } });
    await assert.rejects(
      providerWith(fetchImpl, { transfersEnabled: true }).ensureTransferRecipient({
        ...destination,
        momoNetwork: 'GLO',
      }),
      /unsupported mobile money network/
    );
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('paystack — transfer hardening', () => {
  const REF = `${PAYOUT_ID}`;

  test('a duplicate transfer reference is resolved, never re-sent', async () => {
    // D1. Paystack refusing a reference means a transfer for it may already
    // exist. Sending another would be a second payout for one debt.
    const fetchImpl = stubFetch([
      { ok: false, status: 400, body: { status: false, message: 'Duplicate transfer reference' } },
      {
        body: {
          status: true,
          data: { transfer_code: 'TRF_existing', status: 'success', amount: 3150, currency: 'GHS' },
        },
      },
    ]);

    const result = await providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
      idempotencyKey: 'payout:1',
      amountPesewas: 3150,
      recipient: { recipientCode: 'RCP_x' },
      reference: REF,
    });

    assert.equal(result.providerTransferId, 'TRF_existing');
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.raw.duplicate_reference, true);
    // Two calls: the refused create, then the read. Never a second create.
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[0].url, /\/transfer$/);
    assert.match(fetchImpl.calls[1].url, /\/transfer\/verify\//);
    assert.equal(fetchImpl.calls.filter((c) => /\/transfer$/.test(c.url)).length, 1);
  });

  test('a duplicate reference Paystack cannot describe is refused outright', async () => {
    // The dangerous case: they say it exists but will not say what it is. The
    // only safe answer is to stop, not to guess.
    const fetchImpl = stubFetch([
      { ok: false, status: 400, body: { status: false, message: 'Duplicate transfer reference' } },
      { ok: false, status: 404, body: { status: false, message: 'Transfer not found' } },
    ]);

    await assert.rejects(
      providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
        idempotencyKey: 'payout:1',
        amountPesewas: 3150,
        recipient: { recipientCode: 'RCP_x' },
        reference: REF,
      }),
      (error) => {
        assert.equal(error.code, 'duplicate_reference_unresolved');
        assert.match(error.message, /must not be reused/);
        return true;
      }
    );
    assert.equal(fetchImpl.calls.filter((c) => /\/transfer$/.test(c.url)).length, 1);
  });

  test('transfer.reversed is REVERSED, not FAILED', async () => {
    // D3. A reversal is not a failure: the transfer completed first.
    const provider = providerWith(stubFetch({ body: {} }));
    const payload = {
      event: 'transfer.reversed',
      data: { id: 7003, status: 'reversed', transfer_code: 'TRF_rev', reference: PAYOUT_ID },
    };
    const rawBody = JSON.stringify(payload);
    const event = await provider.handleWebhook({
      rawBody,
      headers: { 'x-paystack-signature': sign(rawBody) },
    });

    assert.equal(event.kind, 'transfer');
    assert.equal(event.status, 'REVERSED');
    assert.equal(event.eventId, 'transfer.reversed:7003');
  });

  test('a reversal is trusted from the event name even if data.status lags', async () => {
    const provider = providerWith(stubFetch({ body: {} }));
    const payload = {
      event: 'transfer.reversed',
      // Paystack leaving the old status on the object must not read as success.
      data: { id: 7004, status: 'success', transfer_code: 'TRF_lag', reference: PAYOUT_ID },
    };
    const rawBody = JSON.stringify(payload);
    const event = await provider.handleWebhook({
      rawBody,
      headers: { 'x-paystack-signature': sign(rawBody) },
    });
    assert.equal(event.status, 'REVERSED');
  });

  test('transfer.failed is still FAILED, and distinct from a reversal', async () => {
    const provider = providerWith(stubFetch({ body: {} }));
    const payload = {
      event: 'transfer.failed',
      data: { id: 7005, status: 'failed', transfer_code: 'TRF_f', reference: PAYOUT_ID },
    };
    const rawBody = JSON.stringify(payload);
    const event = await provider.handleWebhook({
      rawBody,
      headers: { 'x-paystack-signature': sign(rawBody) },
    });
    assert.equal(event.status, 'FAILED');
  });

  test('a transfer webhook reports the amount, so the caller can check it', async () => {
    // D2. The amount has to survive normalisation for the check to be possible.
    const provider = providerWith(stubFetch({ body: {} }));
    const payload = {
      event: 'transfer.success',
      data: {
        id: 7006,
        status: 'success',
        amount: 3150,
        currency: 'GHS',
        transfer_code: 'TRF_a',
        reference: PAYOUT_ID,
      },
    };
    const rawBody = JSON.stringify(payload);
    const event = await provider.handleWebhook({
      rawBody,
      headers: { 'x-paystack-signature': sign(rawBody) },
    });
    assert.equal(event.amountPesewas, 3150);

    // And a non-GHS transfer reports no amount at all, which fails the check.
    const other = JSON.stringify({
      event: 'transfer.success',
      data: { id: 7007, status: 'success', amount: 3150, currency: 'NGN', reference: PAYOUT_ID },
    });
    const otherEvent = await provider.handleWebhook({
      rawBody: other,
      headers: { 'x-paystack-signature': sign(other) },
    });
    assert.equal(otherEvent.amountPesewas, null);
  });
});

describe('paystack — adapter hygiene', () => {
  test('a provider with no secret key cannot be constructed', () => {
    assert.throws(() => new PaystackPaymentProvider({}), /requires a secret key/);
  });

  test('it declares that it needs a customer email', () => {
    assert.equal(providerWith(stubFetch({ body: {} })).requiresCustomerEmail, true);
  });

  test('a network failure reads as unreachable, not as a failed payment', async () => {
    const impl = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(
      providerWith(impl).initiateCollection({
        idempotencyKey: 'k',
        amountPesewas: 100,
        customerEmail: 'a@b.com',
        reference: PAYMENT_ID,
      }),
      /could not reach Paystack/
    );
  });

  test('the key configured for a local test run is a TEST key', (t) => {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) return t.skip('no PAYSTACK_SECRET_KEY in the environment');

    // The suite resets and rewrites a database and would happily drive a real
    // account. A live key here is a mistake worth failing loudly on.
    assert.match(key, /^sk_test_/, 'the local suite must never run against a LIVE Paystack key');
  });
});

describe('the payment provider factory', () => {
  // The factory is the ONLY place payment credentials are read. Everything else
  // takes an already-built adapter, which is what keeps the secret key out of
  // every other module.
  const original = process.env.PAYMENT_PROVIDER;

  const withProvider = (name, fn) => {
    process.env.PAYMENT_PROVIDER = name;
    resetPaymentProvider();
    try {
      return fn();
    } finally {
      if (original === undefined) delete process.env.PAYMENT_PROVIDER;
      else process.env.PAYMENT_PROVIDER = original;
      resetPaymentProvider();
    }
  };

  test('PAYMENT_PROVIDER=fake still resolves, so the flow runs with no account', () => {
    withProvider('fake', () => {
      const provider = getPaymentProvider();
      assert.equal(provider.name, 'fake');
      assert.equal(provider.requiresCustomerEmail, false);
      assert.equal(provider.canSendTransfers, true, 'the fake provider settles its own transfers');
    });
  });

  test('PAYMENT_PROVIDER=paystack builds the real adapter from the environment', (t) => {
    if (!process.env.PAYSTACK_SECRET_KEY) return t.skip('no PAYSTACK_SECRET_KEY configured');

    withProvider('paystack', () => {
      const provider = getPaymentProvider();
      assert.equal(provider.name, 'paystack');
      assert.equal(provider.requiresCustomerEmail, true);
      // Money out is shut unless somebody deliberately opened it.
      assert.equal(
        provider.canSendTransfers,
        process.env.PAYSTACK_TRANSFERS_ENABLED === 'true',
        'transfers must default to off'
      );
    });
  });

  test('an unknown provider name fails loudly rather than falling back', () => {
    withProvider('hubtel', () => {
      assert.throws(() => getPaymentProvider(), /Unknown PAYMENT_PROVIDER "hubtel"/);
    });
  });
});

/**
 * The gap between "Paystack took it" and "the money arrived".
 *
 * This is the rule a real TEST transfer taught us the hard way. Paystack's test
 * mode answers POST /transfer with status "success" and the message "Transfer
 * has been queued" — in the SAME breath. `transferred_at` is null. Nothing has
 * moved. Believing that response marked a payout PAID, with no amount checked,
 * on nothing but an echo of the figure we had just sent.
 *
 * So the adapter keeps reporting what Paystack actually said (SUCCEEDED — that
 * IS what the field means, and getTransferStatus needs the truth to resolve a
 * duplicate reference), and the settlement layer decides separately that no
 * initiation response, whatever it says, may settle money.
 */
describe('an initiation response never settles a payout', () => {
  /** The verbatim body Paystack TEST returned for the real GHS 3.00 transfer. */
  const QUEUED_BUT_SUCCESS = {
    status: true,
    message: 'Transfer has been queued',
    data: {
      domain: 'test',
      amount: 300,
      currency: 'GHS',
      reference: PAYOUT_ID,
      status: 'success',
      failures: null,
      transfer_code: 'TRF_qjhuzc0k6a0xmajo',
      transferred_at: null,
    },
  };

  async function initiate(body) {
    return providerWith(stubFetch({ body }), { transfersEnabled: true }).sendTransfer({
      idempotencyKey: 'payout:1',
      amountPesewas: 300,
      recipient: { recipientCode: 'RCP_x' },
      reference: PAYOUT_ID,
    });
  }

  test('the real "queued but success" response leaves the payout PROCESSING', async () => {
    const result = await initiate(QUEUED_BUT_SUCCESS);

    // The adapter reports what Paystack said, unchanged.
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.providerTransferId, 'TRF_qjhuzc0k6a0xmajo');
    // Nothing had actually moved when they said that.
    assert.equal(result.raw.transferred_at, null);

    // And settlement still refuses to call it paid.
    assert.equal(initiationOutcomeFor(result.status), 'PROCESSING');
  });

  test('an initiation still awaiting an OTP is PROCESSING', async () => {
    const result = await initiate({
      status: true,
      message: 'Transfer requires OTP to continue',
      data: { transfer_code: 'TRF_otp', status: 'otp', amount: 300, currency: 'GHS' },
    });

    assert.equal(result.status, 'PENDING');
    assert.equal(initiationOutcomeFor(result.status), 'PROCESSING');
  });

  test('an initiation reported as pending is PROCESSING', async () => {
    const result = await initiate({
      status: true,
      data: { transfer_code: 'TRF_p', status: 'pending', amount: 300, currency: 'GHS' },
    });

    assert.equal(result.status, 'PENDING');
    assert.equal(initiationOutcomeFor(result.status), 'PROCESSING');
  });

  test('no provider status whatsoever can produce PAID from an initiation', () => {
    // Every PaymentStatus the adapter can return, plus the transfer-only one
    // and a value it has never heard of.
    for (const status of [
      'SUCCEEDED',
      'PENDING',
      'FAILED',
      'CANCELLED',
      'REVERSED',
      'something_paystack_invents_next_year',
      undefined,
      null,
    ]) {
      const outcome = initiationOutcomeFor(status);
      assert.notEqual(outcome, 'PAID', `${status} must never settle a payout`);
      assert.ok(outcome === 'PROCESSING' || outcome === 'FAIL');
    }
  });

  test('only a terminal answer fails the payout; everything else waits', () => {
    assert.equal(initiationOutcomeFor('FAILED'), 'FAIL');
    assert.equal(initiationOutcomeFor('CANCELLED'), 'FAIL');

    // A duplicate-reference resolution that comes back REVERSED is NOT treated
    // as terminal here — unchanged behaviour, and the reversal webhook is what
    // moves the payout to REVERSED.
    assert.equal(initiationOutcomeFor('REVERSED'), 'PROCESSING');
    assert.equal(initiationOutcomeFor('PENDING'), 'PROCESSING');
    assert.equal(initiationOutcomeFor('SUCCEEDED'), 'PROCESSING');
  });

  test('a duplicate reference resolved to a dead transfer still fails the payout', async () => {
    // POST /transfer rejects as duplicate, then GET /transfer/verify says it
    // failed. That is terminal: no webhook is coming.
    const fetchImpl = stubFetch([
      {
        ok: false,
        status: 400,
        body: { status: false, message: 'Transfer reference is duplicate' },
      },
      {
        body: {
          status: true,
          data: { transfer_code: 'TRF_dead', status: 'failed', amount: 300, currency: 'GHS' },
        },
      },
    ]);

    const result = await providerWith(fetchImpl, { transfersEnabled: true }).sendTransfer({
      idempotencyKey: 'payout:1',
      amountPesewas: 300,
      recipient: { recipientCode: 'RCP_x' },
      reference: PAYOUT_ID,
    });

    assert.equal(result.status, 'FAILED');
    assert.equal(result.raw.duplicate_reference, true);
    assert.equal(initiationOutcomeFor(result.status), 'FAIL');
    // Two calls: the rejected POST and the verify. Never a second transfer.
    assert.equal(fetchImpl.calls.length, 2);
  });
});
