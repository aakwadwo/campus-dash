// Pins the service-role client at the local stack BEFORE anything reads config.
import './helpers/local-supabase.js';

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools, resetTransactionalState } from './helpers/db.js';
import { submitOrder } from './helpers/flow.js';
import { notify, NOTIFICATION_EVENT, AUDIENCE } from '../lib/notifications/index.js';
import { processSmsWebhook } from '../lib/sms/webhook.js';
import { signArkeselWebhook } from '../lib/sms/arkesel-webhook.js';

/**
 * The notification runtime, end to end against the real database.
 *
 * These exist because the runtime path had never been executed by a test. Its
 * templates were covered and its wiring was checked at the source level, and
 * inside it were two ReferenceErrors — a call to a helper that did not exist,
 * and a variable read out of scope — so every order-scoped notification threw,
 * notifyOrderEvent() swallowed it, and the deduplication built in the database
 * had never once been reached. Source-level tests cannot catch that. These can.
 */

const SECRET = 'test-arkesel-webhook-secret';
process.env.ARKESEL_WEBHOOK_SECRET = SECRET;

/** A stub provider that records what it was asked to send. */
function stubProvider({ name = 'arkesel', behaviour = () => ({ ok: true }) } = {}) {
  const sent = [];
  return {
    name,
    sent,
    async send(phone, message, options) {
      sent.push({ phone, message, options });
      const outcome = behaviour(sent.length);
      if (outcome instanceof Error) throw outcome;
      return {
        providerMessageId: null,
        correlationId: options?.idempotencyKey ?? null,
        ...outcome,
      };
    },
  };
}

const CUSTOMER_PHONE = '+233200000021';

function recipients() {
  return [{ audience: AUDIENCE.CUSTOMER, phone: CUSTOMER_PHONE, userId: null }];
}

const CONTEXT = { orderNumber: 'CD-TEST', vendorName: 'Test Kitchen One', totalPesewas: 4350 };

async function notificationsFor(orderId) {
  return asService(
    async (c) =>
      (
        await c.query(
          `select event, audience, recipient, succeeded, provider, dedupe_key,
                correlation_id, provider_message_id, delivery_status, error
           from public.notification_events
          where order_id = $1 order by id`,
          [orderId]
        )
      ).rows
  );
}

describe('notification delivery, deduplication and retry', () => {
  let orderId;

  before(async () => {
    await resetTransactionalState();
  });

  beforeEach(async () => {
    // A real order, because notification_events has a foreign key to it — the
    // kind of thing a mocked database quietly lets you get away with.
    const submitted = await submitOrder({});
    orderId = submitted.order_id ?? submitted.orderId ?? submitted.id;
  });

  after(async () => {
    await resetTransactionalState();
  });

  test('a notification is sent and written to the log', async () => {
    const sms = stubProvider();
    const results = await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId,
      deps: { sms },
    });

    assert.equal(sms.sent.length, 1);
    assert.equal(results[0].ok, true);

    const rows = await notificationsFor(orderId);
    assert.equal(rows.length, 1, 'the send must be logged');
    assert.equal(rows[0].succeeded, true);
    assert.equal(rows[0].provider, 'arkesel');
    assert.equal(rows[0].recipient, CUSTOMER_PHONE);
    assert.equal(rows[0].dedupe_key, `ORDER_ACCEPTED:CUSTOMER:${orderId}:${CUSTOMER_PHONE}`);
    assert.ok(rows[0].correlation_id, 'a correlation reference must be recorded');
  });

  test('a duplicate successful notification does not send twice', async () => {
    // Server actions retry and pages revalidate. Without this the customer gets
    // the same SMS twice, which costs real money and reads as a broken system.
    const sms = stubProvider();
    const send = () =>
      notify({
        event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
        recipients: recipients(),
        context: CONTEXT,
        orderId,
        deps: { sms },
      });

    await send();
    const second = await send();

    assert.equal(sms.sent.length, 1, 'the provider must be called exactly once');
    assert.equal(second[0].skipped, true);
    assert.equal(second[0].reason, 'already_sent');
    assert.equal((await notificationsFor(orderId)).length, 1);
  });

  test('a FAILED notification is retried, and the retry is what succeeds', async () => {
    // Dedup keys on SUCCESS. A message that never went out must be sendable
    // again, or a transient provider blip permanently silences that event.
    const sms = stubProvider({
      behaviour: (attempt) =>
        attempt === 1
          ? { ok: false, error: 'Arkesel rejected the message (code 105)' }
          : { ok: true },
    });
    const send = () =>
      notify({
        event: NOTIFICATION_EVENT.ORDER_READY,
        recipients: recipients(),
        context: { ...CONTEXT, isPickup: true },
        orderId,
        deps: { sms },
      });

    const first = await send();
    assert.equal(first[0].ok, false);

    const second = await send();
    assert.equal(second[0].ok, true, 'the retry must actually be attempted');
    assert.equal(sms.sent.length, 2);

    const rows = await notificationsFor(orderId);
    assert.equal(rows.length, 2, 'both the failure and the success are on the record');
    assert.deepEqual(
      rows.map((r) => r.succeeded),
      [false, true]
    );
  });

  test('a provider that throws is recorded as a failure, not lost', async () => {
    const sms = stubProvider({ behaviour: () => new Error('socket hang up') });
    const results = await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId,
      deps: { sms },
    });

    assert.equal(results[0].ok, false);
    const rows = await notificationsFor(orderId);
    assert.equal(rows[0].succeeded, false);
    assert.match(rows[0].error, /socket hang up/);
  });

  test('the correlation reference is handed to the provider on the send', async () => {
    // It has to exist BEFORE the send: Arkesel's v1 response carries no message
    // id, so this is the only thing a later delivery report can be matched on.
    const sms = stubProvider();
    await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId,
      deps: { sms },
    });

    const handed = sms.sent[0].options.idempotencyKey;
    const rows = await notificationsFor(orderId);
    assert.ok(handed, 'the provider must be given a reference');
    assert.equal(rows[0].correlation_id, handed, 'and the same one must be recorded');
  });
});

describe('Arkesel delivery report, applied to the notification', () => {
  let orderId;
  let correlationId;

  before(async () => {
    await resetTransactionalState();
    const submitted = await submitOrder({});
    orderId = submitted.order_id ?? submitted.orderId ?? submitted.id;

    const sms = stubProvider();
    await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId,
      deps: { sms },
    });
    correlationId = sms.sent[0].options.idempotencyKey;
  });

  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  /** Builds a signed GET callback exactly as Arkesel would send it. */
  function signedReport({ status = 'DELIVRD', ref = correlationId, smsId = 'sms_live_1', id }) {
    const searchParams = new URLSearchParams({ sms_id: smsId, status, ref });
    const payload = searchParams.toString();
    return {
      provider: 'arkesel',
      rawBody: '',
      searchParams,
      headers: signArkeselWebhook({ payload, secret: SECRET, id }),
    };
  }

  test('a valid report marks the notification delivered', async () => {
    const result = await processSmsWebhook(signedReport({ id: 'wh_delivered_1' }));

    assert.equal(result.status, 200);
    assert.equal(result.body.matched, true);
    assert.equal(result.body.status, 'DELIVERED');

    const rows = await notificationsFor(orderId);
    assert.equal(rows[0].delivery_status, 'DELIVERED');
    assert.equal(rows[0].provider_message_id, 'sms_live_1', "Arkesel's own id is kept for support");
  });

  test('the same webhook id delivered again changes nothing', async () => {
    // Providers retry. Five deliveries of one report must be one write.
    const before = await notificationsFor(orderId);
    const result = await processSmsWebhook(signedReport({ id: 'wh_delivered_1' }));

    assert.equal(result.status, 200);
    assert.equal(result.body.duplicate, true);
    assert.deepEqual(await notificationsFor(orderId), before);
  });

  test('a later report with a new id updates the status', async () => {
    const result = await processSmsWebhook(
      signedReport({ status: 'UNDELIV', id: 'wh_undeliv_1', smsId: 'sms_live_1' })
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'FAILED');

    const rows = await notificationsFor(orderId);
    assert.equal(rows[0].delivery_status, 'FAILED');
  });

  test('an invalid signature is refused and never applied', async () => {
    const report = signedReport({ status: 'DELIVRD', id: 'wh_forged_1' });
    report.headers['x-arkesel-webhook-signature'] = 'deadbeef'.repeat(8);

    const before = await notificationsFor(orderId);
    const result = await processSmsWebhook(report);

    assert.equal(result.status, 401);
    assert.deepEqual(await notificationsFor(orderId), before, 'nothing may change');

    // Recorded and flagged, so a stream of forgeries is visible rather than
    // silently dropped.
    const stored = await asService(
      async (c) =>
        (
          await c.query(
            `select signature_valid, status from public.webhook_events
            where provider = 'arkesel' and event_id = 'wh_forged_1'`
          )
        ).rows
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].signature_valid, false);
    assert.equal(stored[0].status, 'INVALID_SIGNATURE');
  });

  test('a tampered status with a captured signature is refused', async () => {
    const report = signedReport({ status: 'DELIVRD', id: 'wh_tampered_1' });
    // Keep the signature, change the claim.
    report.searchParams.set('status', 'FAILED');

    const result = await processSmsWebhook(report);
    assert.equal(result.status, 401);
  });

  test('a report matches whichever provider recorded the send', async () => {
    // The correlation reference is a UUID we generated; it identifies the
    // message on its own. Filtering on provider name as well looked like a
    // sensible extra guard and was a bug — in development every send goes
    // through the fake provider, so an Arkesel report matched nothing and
    // reported success anyway.
    const submitted = await submitOrder({});
    const otherOrderId = submitted.order_id ?? submitted.orderId ?? submitted.id;

    const sms = stubProvider({ name: 'fake' });
    await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId: otherOrderId,
      deps: { sms },
    });
    const ref = sms.sent[0].options.idempotencyKey;

    const result = await processSmsWebhook(
      signedReport({ ref, id: 'wh_other_provider_1', smsId: 'sms_other' })
    );
    assert.equal(result.body.matched, true);

    const rows = await notificationsFor(otherOrderId);
    assert.equal(rows[0].delivery_status, 'DELIVERED');
  });

  test('an unmatched reference is accepted and ignored, not retried for ever', async () => {
    const result = await processSmsWebhook(
      signedReport({ ref: 'ref-that-never-existed', id: 'wh_unmatched_1' })
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.matched, false);
  });

  test('a report never overwrites a provider id the send already recorded', async () => {
    // The append-only guard makes provider_message_id write-once. A report that
    // tried to change it raised, and the raise surfaced as a 500 asking the
    // provider to retry for ever. Found by running the documented manual
    // procedure, not by the suite — hence this.
    const submitted = await submitOrder({});
    const someOrderId = submitted.order_id ?? submitted.orderId ?? submitted.id;

    const sms = {
      name: 'fake',
      async send(_phone, _message, options) {
        return {
          ok: true,
          providerMessageId: 'id-from-send',
          correlationId: options.idempotencyKey,
        };
      },
    };
    const [sent] = await notify({
      event: NOTIFICATION_EVENT.ORDER_ACCEPTED,
      recipients: recipients(),
      context: CONTEXT,
      orderId: someOrderId,
      deps: { sms },
    });

    const result = await processSmsWebhook(
      signedReport({ ref: sent.correlationId, id: 'wh_writeonce_1', smsId: 'id-from-report' })
    );

    assert.equal(result.status, 200, 'must not raise');
    assert.equal(result.body.matched, true);

    const rows = await notificationsFor(someOrderId);
    assert.equal(rows[0].provider_message_id, 'id-from-send', 'the first id recorded stands');
    assert.equal(rows[0].delivery_status, 'DELIVERED');
  });

  test('a malformed report is refused without throwing', async () => {
    const searchParams = new URLSearchParams({ nonsense: 'yes' });
    const result = await processSmsWebhook({
      provider: 'arkesel',
      rawBody: '{{{ not json',
      searchParams,
      headers: {},
    });
    // No signature at all: it cannot be trusted, and it has no id to dedupe on.
    assert.ok(result.status === 400 || result.status === 401, `got ${result.status}`);
  });

  test('an unknown provider is not served', async () => {
    const result = await processSmsWebhook({
      provider: 'not-a-provider',
      rawBody: '',
      searchParams: new URLSearchParams(),
      headers: {},
    });
    assert.equal(result.status, 404);
  });
});
