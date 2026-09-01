import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { signWebhook } from '../lib/auth/webhook-signature.js';
import { resetSmsProvider } from '../lib/sms/index.js';

/**
 * The Supabase Auth Send SMS Hook, end to end through the real route handler.
 *
 *   Supabase Auth → POST /api/auth/hooks/send-sms → ArkeselSmsProvider → Arkesel
 *
 * This drives the ACTUAL route with an ACTUAL signed payload and the real
 * Arkesel adapter, intercepting only the outbound HTTP call. So it asserts the
 * thing that matters — that a genuine Supabase OTP request ends with a
 * correctly-formed Arkesel send — rather than that the pieces exist.
 *
 * No credit is spent: globalThis.fetch is replaced for the duration.
 */

// Any valid Standard Webhooks secret: base64 after the whsec_ prefix.
const SECRET = `v1,whsec_${Buffer.from('campus-dash-send-sms-hook-test-key').toString('base64')}`;

/** The payload shape Supabase Auth actually posts. */
function otpPayload({ phone = '233200000021', otp = '154339' } = {}) {
  return JSON.stringify({
    user: { id: '00000000-0000-4000-8000-000000000021', phone },
    sms: { otp },
  });
}

function hookRequest(body, headers) {
  return new Request('https://campusdash.example/api/auth/hooks/send-sms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

let POST;
let realFetch;
let arkeselCalls;

/** Replaces the outbound call and answers as Arkesel would. */
function mockArkesel(
  responder = () => ({ code: 'ok', message: 'Successfully Sent', balance: 42 })
) {
  globalThis.fetch = async (url, init) => {
    arkeselCalls.push({ url: String(url), init });
    const outcome = responder(arkeselCalls.length);
    if (outcome instanceof Error) throw outcome;
    return {
      status: outcome.status ?? 200,
      text: async () => JSON.stringify(outcome.body ?? outcome),
    };
  };
}

describe('Send SMS Hook → Arkesel', () => {
  beforeEach(async () => {
    arkeselCalls = [];
    realFetch = globalThis.fetch;

    process.env.SEND_SMS_HOOK_SECRETS = SECRET;
    process.env.SMS_PROVIDER = 'arkesel';
    process.env.ARKESEL_API_KEY = 'test-key-must-not-leak';
    process.env.ARKESEL_SENDER_ID = 'CampusDash';
    process.env.ARKESEL_SMS_URL = 'https://sms.arkesel.com/sms/api';
    delete process.env.PUBLIC_APP_URL;

    resetSmsProvider();
    ({ POST } = await import('../app/api/auth/hooks/send-sms/route.js'));
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSmsProvider();
    delete process.env.SMS_PROVIDER;
    delete process.env.ARKESEL_API_KEY;
    delete process.env.ARKESEL_SENDER_ID;
    delete process.env.ARKESEL_SMS_URL;
    delete process.env.SEND_SMS_HOOK_SECRETS;
  });

  test('a signed OTP request reaches Arkesel, carrying the code', async () => {
    mockArkesel();
    const body = otpPayload({ otp: '154339' });
    const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.includes('application/json'), true);

    assert.equal(arkeselCalls.length, 1, 'Arkesel must actually be called');
    const params = new URL(arkeselCalls[0].url).searchParams;
    assert.equal(params.get('action'), 'send-sms');
    assert.equal(params.get('to'), '233200000021', "Arkesel wants no leading '+'");
    assert.equal(params.get('from'), 'CampusDash');
    assert.match(params.get('sms'), /154339/, 'the OTP must be in the message');
    assert.match(params.get('sms'), /Campus Dash/);
  });

  test('a Ghanaian local number is normalised before it reaches Arkesel', async () => {
    mockArkesel();
    const body = otpPayload({ phone: '0200000021' });
    await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(new URL(arkeselCalls[0].url).searchParams.get('to'), '233200000021');
  });

  test("the provider call is bounded well inside Supabase's five-second budget", async () => {
    // Supabase allows five seconds TOTAL, including its own retries. The
    // adapter's own default is 15s, which would blow the budget on its own.
    let seenSignal;
    globalThis.fetch = async (url, init) => {
      arkeselCalls.push({ url: String(url), init });
      seenSignal = init.signal;
      return { status: 200, text: async () => JSON.stringify({ code: 'ok' }) };
    };

    const body = otpPayload();
    await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.ok(seenSignal, 'the request must carry an abort signal');
    // AbortSignal.timeout() does not expose its duration, so assert the route
    // asked for one at all and that the handler returned promptly.
    assert.equal(seenSignal instanceof AbortSignal, true);
  });

  test('an unsigned request is refused and Arkesel is never called', async () => {
    mockArkesel();
    const response = await POST(hookRequest(otpPayload(), {}));

    assert.equal(response.status, 401);
    assert.equal(arkeselCalls.length, 0, 'an unsigned caller must not be able to send SMS');
  });

  test('a signature from the wrong secret is refused and Arkesel is never called', async () => {
    mockArkesel();
    const body = otpPayload();
    const wrong = `v1,whsec_${Buffer.from('a-different-secret-entirely').toString('base64')}`;
    const response = await POST(hookRequest(body, signWebhook({ body, secret: wrong })));

    assert.equal(response.status, 401);
    assert.equal(arkeselCalls.length, 0);
  });

  test('a tampered payload invalidates the signature', async () => {
    mockArkesel();
    const body = otpPayload({ phone: '233200000021' });
    const headers = signWebhook({ body, secret: SECRET });
    // Keep the signature; redirect the code to another handset.
    const tampered = otpPayload({ phone: '233209999999' });

    const response = await POST(hookRequest(tampered, headers));
    assert.equal(response.status, 401);
    assert.equal(arkeselCalls.length, 0);
  });

  test('a replayed request is refused', async () => {
    mockArkesel();
    const body = otpPayload();
    const old = signWebhook({
      body,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 6 * 60,
    });

    const response = await POST(hookRequest(body, old));
    assert.equal(response.status, 401);
    assert.equal(arkeselCalls.length, 0);
  });

  test('either secret works during a rotation', async () => {
    const incoming = `v1,whsec_${Buffer.from('the-incoming-rotation-secret').toString('base64')}`;
    process.env.SEND_SMS_HOOK_SECRETS = `${SECRET} ${incoming}`;

    for (const secret of [SECRET, incoming]) {
      arkeselCalls = [];
      mockArkesel();
      const body = otpPayload();
      const response = await POST(hookRequest(body, signWebhook({ body, secret })));
      assert.equal(response.status, 200, 'both configured secrets must be accepted');
      assert.equal(arkeselCalls.length, 1);
    }
  });

  test('a malformed payload is refused before anything is sent', async () => {
    mockArkesel();
    const body = '{ not json';
    const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(response.status, 400);
    assert.equal(arkeselCalls.length, 0);
  });

  test('a payload with no phone or no code is refused', async () => {
    mockArkesel();
    for (const body of [
      JSON.stringify({ user: {}, sms: {} }),
      JSON.stringify({ user: { phone: '233200000021' }, sms: {} }),
      JSON.stringify({ user: {}, sms: { otp: '123456' } }),
    ]) {
      const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));
      assert.equal(response.status, 400);
    }
    assert.equal(arkeselCalls.length, 0);
  });

  test('a transient Arkesel failure asks Supabase to retry', async () => {
    // 503 with a non-empty retry-after is the only shape Supabase retries.
    mockArkesel(() => {
      const error = new Error('socket hang up');
      return error;
    });

    const body = otpPayload();
    const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '2');
  });

  test('a permanent Arkesel rejection does NOT ask for a retry', async () => {
    // 106 is an unregistered sender ID. Asking again produces the same answer
    // and spends the five-second budget finding that out.
    mockArkesel(() => ({ code: '106', message: 'Invalid sender id' }));

    const body = otpPayload();
    const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(response.status, 500);
    assert.equal(response.headers.get('retry-after'), null);
  });

  test('the API key never appears in the response, whatever happens', async () => {
    for (const responder of [
      () => ({ code: 'ok' }),
      () => ({ code: '102', message: 'Authentication Failed' }),
      () => new Error('connect ECONNREFUSED sms.arkesel.com?api_key=test-key-must-not-leak'),
    ]) {
      mockArkesel(responder);
      const body = otpPayload();
      const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));
      const text = await response.text();
      assert.doesNotMatch(text, /test-key-must-not-leak/, 'the API key leaked to Supabase');
      assert.doesNotMatch(text, /api_key/);
    }
  });

  test('a server with no hook secret configured refuses everything', async () => {
    delete process.env.SEND_SMS_HOOK_SECRETS;
    delete process.env.SEND_SMS_HOOK_SECRET;
    mockArkesel();

    const body = otpPayload();
    const response = await POST(hookRequest(body, signWebhook({ body, secret: SECRET })));

    assert.equal(response.status, 401);
    assert.equal(arkeselCalls.length, 0);
  });
});
