import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ArkeselSmsProvider } from '../lib/sms/arkesel.js';

/**
 * The Arkesel adapter, against a mocked fetch.
 *
 * Nothing here touches the network. The suite must never spend SMS credit —
 * a test that costs money per run is a test people stop running.
 */

const OK_BODY = JSON.stringify({
  code: 'ok',
  message: 'Successfully Sent',
  balance: 6,
  main_balance: 0.165,
  user: 'Test Account',
});

/** Records the calls so the request itself can be asserted. */
function mockFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, status = 200) {
  return { status, text: async () => body };
}

function provider(fetchImpl, extra = {}) {
  return new ArkeselSmsProvider({
    apiKey: 'test-api-key-do-not-log',
    senderId: 'CampusDash',
    fetchImpl,
    ...extra,
  });
}

describe('Arkesel SMS adapter', () => {
  test('a successful send is accepted and reports the balance', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    const result = await provider(fetchImpl).send('+233201234567', 'Campus Dash: hello');

    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(result.providerCode, 'ok');
    assert.equal(result.balance, 6);
  });

  test('the request is built and encoded the way Arkesel expects', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    // A message with a space, a '+', a '#' and an '&' — every one of which
    // changes meaning if it is pasted into a URL unencoded.
    await provider(fetchImpl).send('+233201234567', 'Order #12 costs GH¢5 + fee & more');

    const url = new URL(fetchImpl.calls[0].url);
    const params = url.searchParams;

    assert.equal(url.origin + url.pathname, 'https://sms.arkesel.com/sms/api');
    assert.equal(params.get('action'), 'send-sms');
    assert.equal(params.get('from'), 'CampusDash');
    // Arkesel wants the international form with no '+'.
    assert.equal(params.get('to'), '233201234567');
    assert.equal(params.get('sms'), 'Order #12 costs GH¢5 + fee & more');
  });

  test('a delivery callback is requested, carrying our correlation reference', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    await provider(fetchImpl, { callbackBaseUrl: 'https://campusdash.example' }).send(
      '+233201234567',
      'hello',
      { idempotencyKey: 'ref-abc-123' }
    );

    const callback = new URL(new URL(fetchImpl.calls[0].url).searchParams.get('callback_url'));
    assert.equal(callback.pathname, '/api/sms/webhook/arkesel');
    assert.equal(callback.searchParams.get('ref'), 'ref-abc-123');
  });

  test('no callback is requested when no public origin is configured', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    await provider(fetchImpl).send('+233201234567', 'hello', { idempotencyKey: 'ref-1' });
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.has('callback_url'), false);
  });

  test('a provider rejection is reported, not thrown', async () => {
    // 102 is Arkesel's authentication failure, confirmed against the live
    // endpoint with a deliberately invalid key.
    const fetchImpl = mockFetch(() =>
      jsonResponse(JSON.stringify({ code: '102', message: 'Authentication Failed' }))
    );
    const result = await provider(fetchImpl).send('+233201234567', 'hello');

    assert.equal(result.ok, false);
    assert.equal(result.accepted, false);
    assert.equal(result.providerCode, '102');
    assert.match(result.error, /API key/i);
  });

  test('each documented rejection code gets a sentence a human can act on', async () => {
    for (const [code, expected] of [
      ['105', /balance/i],
      ['106', /sender ID/i],
      ['103', /phone number/i],
      ['111', /spam/i],
    ]) {
      const fetchImpl = mockFetch(() => jsonResponse(JSON.stringify({ code, message: 'nope' })));
      const result = await provider(fetchImpl).send('+233201234567', 'hello');
      assert.equal(result.ok, false);
      assert.match(result.error, expected, `code ${code}`);
    }
  });

  test('an unrecognised code still fails closed', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(JSON.stringify({ code: '999' })));
    const result = await provider(fetchImpl).send('+233201234567', 'hello');
    assert.equal(result.ok, false);
    assert.match(result.error, /999/);
  });

  test('a network failure is reported, not thrown', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND sms.arkesel.com');
    });
    const result = await provider(fetchImpl).send('+233201234567', 'hello');

    assert.equal(result.ok, false);
    assert.match(result.error, /could not reach Arkesel/);
  });

  test('a timeout is reported as a timeout', async () => {
    const fetchImpl = mockFetch(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await provider(fetchImpl, { timeoutMs: 1234 }).send('+233201234567', 'hi');

    assert.equal(result.ok, false);
    assert.match(result.error, /did not respond within 1234ms/);
  });

  test('an HTML error page does not crash the adapter', async () => {
    const fetchImpl = mockFetch(() => jsonResponse('<html>502 Bad Gateway</html>', 502));
    const result = await provider(fetchImpl).send('+233201234567', 'hello');

    assert.equal(result.ok, false);
    assert.match(result.error, /non-JSON response \(HTTP 502\)/);
  });

  test('the API key never appears in anything the adapter returns', async () => {
    // The key rides in the query string — Arkesel's v1 design, not a choice —
    // which makes the request URL itself a secret. Every failure path is
    // checked, because it only takes one to put a live key into a log.
    const responders = [
      () => jsonResponse(JSON.stringify({ code: '102' })),
      () => jsonResponse('<html>nope</html>', 500),
      () => {
        throw new Error('connect ECONNREFUSED https://sms.arkesel.com/sms/api?api_key=leaky');
      },
      () => {
        const e = new Error('aborted');
        e.name = 'TimeoutError';
        throw e;
      },
    ];

    for (const responder of responders) {
      const result = await provider(mockFetch(responder)).send('+233201234567', 'hello');
      const serialised = JSON.stringify(result);
      assert.doesNotMatch(serialised, /test-api-key-do-not-log/, 'the key leaked');
      assert.doesNotMatch(serialised, /api_key/, 'the request URL leaked');
    }
  });

  test('an unsendable number is refused before any request is made', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    for (const bad of ['', 'not-a-number', '+233', null]) {
      const result = await provider(fetchImpl).send(bad, 'hello');
      assert.equal(result.ok, false);
    }
    assert.equal(fetchImpl.calls.length, 0, 'nothing should have been sent');
  });

  test('an empty message is refused before any request is made', async () => {
    const fetchImpl = mockFetch(() => jsonResponse(OK_BODY));
    const result = await provider(fetchImpl).send('+233201234567', '');
    assert.equal(result.ok, false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('it refuses to construct without credentials', () => {
    assert.throws(() => new ArkeselSmsProvider({ senderId: 'X' }), /API key/);
    assert.throws(() => new ArkeselSmsProvider({ apiKey: 'X' }), /sender ID/);
  });
});
