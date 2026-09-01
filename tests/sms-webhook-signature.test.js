import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyArkeselWebhook,
  signArkeselWebhook,
  parseArkeselDeliveryPayload,
  normaliseArkeselStatus,
  diagnoseArkeselSignature,
  SIGNATURE_SCHEMES,
  DEFAULT_SCHEME,
} from '../lib/sms/arkesel-webhook.js';

/**
 * Signature verification for the Arkesel delivery webhook.
 *
 * This is the only thing standing between our notification log — the record
 * support reads when a customer says a code never arrived — and anyone who
 * learns the URL.
 */

const SECRET = 'test-webhook-secret-value';
const PAYLOAD = JSON.stringify({ sms_id: 'sms_1', status: 'DELIVRD', ref: 'ref-1' });

describe('Arkesel webhook signature', () => {
  test('a correctly signed request is accepted', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, id: 'wh_1' });
    const result = verifyArkeselWebhook({ payload: PAYLOAD, headers, secret: SECRET });

    assert.equal(result.valid, true);
    assert.equal(result.webhookId, 'wh_1');
  });

  test('an unsigned request is rejected', () => {
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers: { 'x-arkesel-webhook-id': 'wh_1', 'x-arkesel-webhook-timestamp': '1' },
      secret: SECRET,
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /missing signature/);
  });

  test('a signature made with a different secret is rejected', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: 'some-other-secret' });
    const result = verifyArkeselWebhook({ payload: PAYLOAD, headers, secret: SECRET });

    assert.equal(result.valid, false);
    assert.match(result.reason, /signature mismatch/);
  });

  test('a modified payload invalidates the signature', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });
    // The one attack that matters: flip DELIVRD to FAILED, or somebody else's
    // reference to your own, and keep the captured signature.
    const tampered = PAYLOAD.replace('DELIVRD', 'FAILED');

    const result = verifyArkeselWebhook({ payload: tampered, headers, secret: SECRET });
    assert.equal(result.valid, false);
    assert.match(result.reason, /signature mismatch/);
  });

  test('an old request is rejected, so a captured one cannot be replayed', () => {
    const headers = signArkeselWebhook({
      payload: PAYLOAD,
      secret: SECRET,
      timestamp: 1_000_000,
    });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers,
      secret: SECRET,
      nowSeconds: 1_000_000 + 6 * 60,
    });

    assert.equal(result.valid, false);
    assert.match(result.reason, /replay window/);
  });

  test('a request from the future is rejected too', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, timestamp: 2_000_000 });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers,
      secret: SECRET,
      nowSeconds: 2_000_000 - 6 * 60,
    });
    assert.equal(result.valid, false);
  });

  test('a request inside the window is accepted', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, timestamp: 1_000_000 });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers,
      secret: SECRET,
      nowSeconds: 1_000_000 + 60,
    });
    assert.equal(result.valid, true);
  });

  test('a missing or malformed timestamp is rejected, never ignored', () => {
    const signed = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });

    const missing = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers: { ...signed, 'x-arkesel-webhook-timestamp': undefined },
      secret: SECRET,
    });
    assert.equal(missing.valid, false);
    assert.match(missing.reason, /missing timestamp/);

    const malformed = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers: { ...signed, 'x-arkesel-webhook-timestamp': 'not-a-time' },
      secret: SECRET,
    });
    assert.equal(malformed.valid, false);
    assert.match(malformed.reason, /malformed timestamp/);
  });

  test('a server with no secret configured rejects everything', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });
    const result = verifyArkeselWebhook({ payload: PAYLOAD, headers, secret: null });

    assert.equal(result.valid, false);
    assert.match(result.reason, /no webhook secret/);
  });

  test('a missing webhook id is rejected — it is what dedup keys on', () => {
    const signed = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers: { ...signed, 'x-arkesel-webhook-id': undefined },
      secret: SECRET,
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /missing webhook id/);
  });

  test('header casing does not matter', () => {
    const signed = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, id: 'wh_case' });
    const upper = {
      'X-Arkesel-Webhook-Id': signed['x-arkesel-webhook-id'],
      'X-Arkesel-Webhook-Timestamp': signed['x-arkesel-webhook-timestamp'],
      'X-Arkesel-Webhook-Signature': signed['x-arkesel-webhook-signature'],
    };
    assert.equal(
      verifyArkeselWebhook({ payload: PAYLOAD, headers: upper, secret: SECRET }).valid,
      true
    );

    // And through a real Headers object, which lower-cases on the way in.
    const asHeaders = new Headers(upper);
    assert.equal(
      verifyArkeselWebhook({ payload: PAYLOAD, headers: asHeaders, secret: SECRET }).valid,
      true
    );
  });

  test('a sha256= or v1= prefix on the signature is tolerated', () => {
    const signed = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });
    for (const prefix of ['sha256=', 'v1=']) {
      const result = verifyArkeselWebhook({
        payload: PAYLOAD,
        headers: {
          ...signed,
          'x-arkesel-webhook-signature': prefix + signed['x-arkesel-webhook-signature'],
        },
        secret: SECRET,
      });
      assert.equal(result.valid, true, prefix);
    }
  });

  test('only the CONFIGURED scheme is accepted', () => {
    // Accepting whichever scheme happens to match would be the accommodating
    // choice and a hole: the body-only variants bind no timestamp, so allowing
    // one as a fallback would silently discard replay protection.
    const signed = signArkeselWebhook({
      payload: PAYLOAD,
      secret: SECRET,
      scheme: 'body:hex',
    });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers: signed,
      secret: SECRET,
      scheme: DEFAULT_SCHEME,
    });
    assert.equal(result.valid, false, 'a different scheme must not be accepted');
  });

  test('every declared scheme round-trips with itself', () => {
    for (const scheme of Object.keys(SIGNATURE_SCHEMES)) {
      const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, scheme });
      const result = verifyArkeselWebhook({ payload: PAYLOAD, headers, secret: SECRET, scheme });
      assert.equal(result.valid, true, scheme);
    }
  });

  test('an unknown configured scheme fails closed', () => {
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET });
    const result = verifyArkeselWebhook({
      payload: PAYLOAD,
      headers,
      secret: SECRET,
      scheme: 'invented',
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /unknown signature scheme/);
  });

  test('the diagnostic names the scheme that would have matched', () => {
    // This is how an undocumented signing convention gets pinned down from one
    // real webhook instead of guessed at. Development only, and it never gates
    // a request.
    const headers = signArkeselWebhook({ payload: PAYLOAD, secret: SECRET, scheme: 'body:base64' });
    assert.equal(
      diagnoseArkeselSignature({ payload: PAYLOAD, headers, secret: SECRET }),
      'body:base64'
    );
    assert.equal(
      diagnoseArkeselSignature({ payload: 'something else', headers, secret: SECRET }),
      null
    );
  });
});

describe('Arkesel delivery payload', () => {
  test('a GET query string is read', () => {
    const params = new URLSearchParams({ sms_id: 'sms_9', status: 'DELIVRD', ref: 'ref-9' });
    const parsed = parseArkeselDeliveryPayload({ rawBody: '', searchParams: params });

    assert.deepEqual(parsed, {
      correlationId: 'ref-9',
      providerMessageId: 'sms_9',
      rawStatus: 'DELIVRD',
    });
  });

  test('a JSON POST body is read', () => {
    const parsed = parseArkeselDeliveryPayload({
      rawBody: JSON.stringify({ sms_id: 'sms_8', status: 'UNDELIV', ref: 'ref-8' }),
      searchParams: new URLSearchParams(),
    });
    assert.equal(parsed.providerMessageId, 'sms_8');
    assert.equal(parsed.rawStatus, 'UNDELIV');
    assert.equal(parsed.correlationId, 'ref-8');
  });

  test('a form-encoded POST body is read', () => {
    const parsed = parseArkeselDeliveryPayload({
      rawBody: 'sms_id=sms_7&status=EXPIRED&ref=ref-7',
      searchParams: new URLSearchParams(),
    });
    assert.equal(parsed.providerMessageId, 'sms_7');
    assert.equal(parsed.rawStatus, 'EXPIRED');
  });

  test('the query string wins for our own reference', () => {
    // `ref` is ours: we put it in the callback URL. A body claiming a different
    // one must not be able to redirect a delivery report onto another message.
    const parsed = parseArkeselDeliveryPayload({
      rawBody: JSON.stringify({ ref: 'ref-from-body' }),
      searchParams: new URLSearchParams({ ref: 'ref-from-url' }),
    });
    assert.equal(parsed.correlationId, 'ref-from-url');
  });

  test('garbage does not throw', () => {
    const parsed = parseArkeselDeliveryPayload({
      rawBody: '{not json at all',
      searchParams: new URLSearchParams(),
    });
    assert.equal(parsed.correlationId, null);
    assert.equal(parsed.rawStatus, null);
  });

  test("Arkesel's status vocabulary maps onto ours", () => {
    assert.equal(normaliseArkeselStatus('DELIVRD'), 'DELIVERED');
    assert.equal(normaliseArkeselStatus('delivrd'), 'DELIVERED');
    assert.equal(normaliseArkeselStatus('UNDELIV'), 'FAILED');
    assert.equal(normaliseArkeselStatus('FAILED'), 'FAILED');
    assert.equal(normaliseArkeselStatus('REJECTD'), 'REJECTED');
    assert.equal(normaliseArkeselStatus('EXPIRED'), 'EXPIRED');
    // An unrecognised status is UNKNOWN, never silently DELIVERED.
    assert.equal(normaliseArkeselStatus('SOMETHING_NEW'), 'UNKNOWN');
    assert.equal(normaliseArkeselStatus(null), null);
  });
});
