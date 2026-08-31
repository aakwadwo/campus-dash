import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
} from './helpers/db.js';
import {
  submitOrder,
  vendorAccept,
  payOrder,
  getOrder,
  expectRejection,
  tryTransition,
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
} from './helpers/flow.js';

/**
 * Pilot hardening.
 *
 * Everything here exists because of something found while auditing for states a
 * real user could get stuck in, or costs a real user could be made to bear.
 */
describe('pilot hardening', () => {
  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await asService((c) =>
      c.query(`
        update public.pricing_config
           set payment_pending_timeout_seconds = 900, min_payout_pesewas = 0,
               notification_retry_limit = 2, document_signed_url_seconds = 120,
               approved_document_retention_days = 90, rejected_document_retention_days = 30,
               vendor_poll_seconds = 8, partner_poll_seconds = 10, customer_poll_seconds = 6
         where id
      `)
    );
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const config = () =>
    asService(async (c) => (await c.query('select * from public.platform_config()')).rows[0]);

  // =========================================================================
  // THE STUCK PAYMENT — the reason this milestone exists
  // =========================================================================
  async function pendingPayment() {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    const payment = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            `order:${order.order_id}:attempt:1`,
          ])
        ).rows[0]
    );
    return { order, payment };
  }

  test('a payment the provider never confirms leaves the order genuinely stuck', async () => {
    const { order } = await pendingPayment();

    // This is the trap: only one live intent is allowed, so the customer cannot
    // simply try again.
    const retry = await expectRejection(
      asService((c) =>
        c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
          order.order_id,
          `order:${order.order_id}:attempt:2`,
        ])
      )
    );
    assert.match(retry.message, /already PENDING/);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.payment_status, 'PENDING');
    assert.equal(stored.order_status, 'ACCEPTED', 'and the vendor cannot cook');
  });

  test('the sweep releases it, and the customer can pay again', async () => {
    const { order, payment } = await pendingPayment();

    await asService((c) =>
      c.query("update public.payments set created_at = now() - interval '2 hours' where id = $1", [
        payment.id,
      ])
    );

    const swept = await asService(
      async (c) => (await c.query('select public.expire_stale_payments() as n')).rows[0].n
    );
    assert.equal(swept, 1);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.payment_status, 'FAILED');
    assert.equal(stored.order_status, 'ACCEPTED', 'the vendor acceptance still stands');

    // And a retry now works, as a NEW attempt.
    const retry = await asService(
      async (c) =>
        (
          await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
            order.order_id,
            `order:${order.order_id}:attempt:2`,
          ])
        ).rows[0]
    );
    assert.notEqual(retry.id, payment.id);
  });

  test('the sweep leaves a payment that is merely young alone', async () => {
    const { order } = await pendingPayment();
    const swept = await asService(
      async (c) => (await c.query('select public.expire_stale_payments() as n')).rows[0].n
    );
    assert.equal(swept, 0);
    assert.equal((await getOrder(order.order_id)).payment_status, 'PENDING');
  });

  test('a customer can abandon a stuck payment, but not a young one', async () => {
    const { order, payment } = await pendingPayment();

    const tooSoon = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_abandon_stuck_payment($1)',
      [order.order_id]
    );
    assert.equal(tooSoon.success, false);
    assert.match(tooSoon.reason, /still waiting to hear from the payment provider/);

    await asService((c) =>
      c.query("update public.payments set created_at = now() - interval '2 hours' where id = $1", [
        payment.id,
      ])
    );

    const abandoned = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_abandon_stuck_payment($1)',
      [order.order_id]
    );
    assert.equal(abandoned.success, true);
    assert.equal((await getOrder(order.order_id)).payment_status, 'FAILED');
  });

  test("one customer cannot abandon another customer's payment", async () => {
    const { order, payment } = await pendingPayment();
    await asService((c) =>
      c.query("update public.payments set created_at = now() - interval '2 hours' where id = $1", [
        payment.id,
      ])
    );

    const result = await tryTransition(
      ACTORS.customerKwesi,
      'select public.customer_abandon_stuck_payment($1)',
      [order.order_id]
    );
    assert.equal(result.success, false);
    assert.equal((await getOrder(order.order_id)).payment_status, 'PENDING', 'untouched');
  });

  test('a payment that DID succeed is never swept', async () => {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    await payOrder(order.order_id);

    await asService((c) =>
      c.query("update public.payments set created_at = now() - interval '2 hours'")
    );
    const swept = await asService(
      async (c) => (await c.query('select public.expire_stale_payments() as n')).rows[0].n
    );
    assert.equal(swept, 0);
    assert.equal((await getOrder(order.order_id)).payment_status, 'PAID');
  });

  test('nobody but the server may sweep payments', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.admin, ACTORS.vendor1Staff]) {
      const error = await expectRejection(
        asUser(actor, (c) => c.query('select public.expire_stale_payments()'))
      );
      assert.match(error.message, /permission denied/i);
    }
  });

  // =========================================================================
  // NOTIFICATION DEDUPLICATION
  // =========================================================================
  const recordNotification = (dedupeKey, succeeded = true) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select public.record_notification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as id',
            [
              'ORDER_ACCEPTED',
              'CUSTOMER',
              'SMS',
              '+233200000021',
              succeeded,
              'fake',
              'msg_1',
              null,
              null,
              null,
              dedupeKey,
            ]
          )
        ).rows[0].id
    );

  test('the same notification is recorded once, however many times it is sent', async () => {
    const first = await recordNotification('ORDER_ACCEPTED:CUSTOMER:abc:+233200000021');
    const second = await recordNotification('ORDER_ACCEPTED:CUSTOMER:abc:+233200000021');

    assert.ok(first, 'the first is recorded');
    assert.equal(second, null, 'the duplicate is silently dropped');

    const count = await asService(async (c) =>
      Number((await c.query('select count(*)::int as n from public.notification_events')).rows[0].n)
    );
    assert.equal(count, 1);
  });

  test('the sender asks before spending money, not after', async () => {
    const key = 'ORDER_READY:CUSTOMER:xyz:+233200000021';
    assert.equal(
      await asService(
        async (c) =>
          (await c.query('select public.notification_already_sent($1) as sent', [key])).rows[0].sent
      ),
      false
    );

    await recordNotification(key);

    assert.equal(
      await asService(
        async (c) =>
          (await c.query('select public.notification_already_sent($1) as sent', [key])).rows[0].sent
      ),
      true
    );
  });

  test('a FAILED send stays retryable — only successes are deduplicated', async () => {
    const key = 'ORDER_READY:CUSTOMER:fail:+233200000021';
    await recordNotification(key, false);
    await recordNotification(key, false);

    const attempts = await asService(async (c) =>
      Number(
        (
          await c.query(
            'select count(*)::int as n from public.notification_events where dedupe_key = $1',
            [key]
          )
        ).rows[0].n
      )
    );
    assert.equal(attempts, 2, 'every attempt is worth recording');
    assert.equal(
      await asService(
        async (c) =>
          (await c.query('select public.notification_already_sent($1) as sent', [key])).rows[0].sent
      ),
      false,
      'and it has still not been delivered'
    );

    // Once one succeeds, it stops being retryable.
    await recordNotification(key, true);
    assert.equal(
      await asService(
        async (c) =>
          (await c.query('select public.notification_already_sent($1) as sent', [key])).rows[0].sent
      ),
      true
    );
  });

  test('failed notifications surface for an operator, and drop off once delivered', async () => {
    const key = 'ORDER_ACCEPTED:CUSTOMER:chase:+233200000021';
    await recordNotification(key, false);

    let failures = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_failed_notifications()')).rows
    );
    assert.equal(failures.length, 1);

    await recordNotification(key, true);
    failures = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_failed_notifications()')).rows
    );
    assert.equal(failures.length, 0, 'nothing left to chase');
  });

  test('the notification log is unreadable by anyone but an admin', async () => {
    await recordNotification('ORDER_ACCEPTED:CUSTOMER:priv:+233200000021');

    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.partnerYaw]) {
      const error = await expectRejection(
        asUser(actor, (c) => c.query('select * from public.notification_events'))
      );
      assert.match(error.message, /permission denied/i);

      const viaFunction = await asUser(
        actor,
        async (c) => (await c.query('select * from public.admin_failed_notifications()')).rows
      );
      assert.deepEqual(viaFunction, []);
    }
  });

  // =========================================================================
  // PILOT CONFIGURATION
  // =========================================================================
  test('the configuration is readable, including before signing in', async () => {
    const rows = await asAnon(
      async (c) => (await c.query('select * from public.platform_config()')).rows
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].service_fee_bps, 1000, 'fees are not secret');
    assert.equal(rows[0].vendor_response_seconds, 60);
  });

  test('an admin changes a fee, and it is audited with a reason', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_update_config($1, $2, $3)', [
          'students said 10% was too low',
          1500,
          700,
        ]),
      { commit: true }
    );

    const updated = await config();
    assert.equal(updated.service_fee_bps, 1500);
    assert.equal(updated.delivery_fee_pesewas, 700);
    assert.equal(updated.vendor_response_seconds, 60, 'omitted fields are left alone');

    const audit = await asService(
      async (c) =>
        (await c.query("select * from public.admin_actions where action = 'CONFIG_UPDATE'")).rows
    );
    assert.equal(audit.length, 1);
    assert.match(audit[0].reason, /too low/);
    assert.equal(audit[0].before_state.service_fee_bps, 1000);
    assert.equal(audit[0].after_state.service_fee_bps, 1500);
  });

  test('a changed fee applies to the NEXT order and never to a placed one', async () => {
    const before = await submitOrder();
    // GH₵35 food + 10% (GH₵3.50) + GH₵5 delivery
    assert.equal(before.total_pesewas, 4350);

    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_update_config($1, $2)', ['fee review', 500]),
      { commit: true }
    );

    assert.equal((await getOrder(before.order_id)).total_pesewas, 4350, 'the snapshot holds');
    const after = await submitOrder();
    assert.equal(after.total_pesewas, 4175, 'GH₵35 + 5% (GH₵1.75) + GH₵5 delivery');
  });

  test('a changed timeout takes effect immediately', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_update_config($1, null, null, null, $2)', [
          'vendors say 60s is too short',
          180,
        ]),
      { commit: true }
    );

    const order = await submitOrder();
    const stored = await getOrder(order.order_id);
    const window = Math.round(
      (new Date(stored.accept_deadline_at) - new Date(stored.submitted_at)) / 1000
    );
    assert.equal(window, 180);
  });

  test('nobody but an admin can change configuration', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.partnerYaw]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('select public.admin_update_config($1, $2)', ['free food please', 0])
        )
      );
      assert.match(error.message, /admin privileges required/);
    }

    const direct = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('update public.pricing_config set service_fee_bps = 0 where id')
      )
    );
    assert.match(direct.message, /permission denied/i);
    assert.equal((await config()).service_fee_bps, 1000);
  });

  test('nonsense configuration is refused by the database', async () => {
    for (const [sql, params] of [
      ['select public.admin_update_config($1, null, null, null, $2)', ['bad', 0]],
      ['select public.admin_update_config($1, null, null, $2)', ['bad', 20000]],
      ['select public.admin_update_config($1, $2)', ['bad', -100]],
    ]) {
      await expectRejection(asUser(ACTORS.admin, (c) => c.query(sql, params)));
    }
    assert.equal((await config()).vendor_response_seconds, 60, 'unchanged');
  });

  test('document retention follows the configured period', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [
          ACTORS.applicantKofi,
          'APPROVED',
          'ID matches',
        ]),
      { commit: true }
    );

    const profile = await asService(
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.applicantKofi,
          ])
        ).rows[0]
    );
    const days = Math.round(
      (new Date(profile.documents_purge_after) - new Date(profile.reviewed_at)) / 86400000
    );
    assert.equal(days, 90, 'the approved retention period');
  });

  // =========================================================================
  // OBSERVABILITY
  // =========================================================================
  test('the pilot metrics answer the questions the pilot is for', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);
    await submitOrder({ customer: ACTORS.customerKwesi });

    const metrics = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query("select * from public.admin_pilot_metrics(now() - interval '1 day')")).rows
    );
    const by = Object.fromEntries(metrics.map((m) => [m.metric, Number(m.value)]));

    assert.equal(by.orders_placed, 2);
    assert.equal(by.orders_completed, 1);
    assert.equal(by.deliveries_requested, 2);
    assert.equal(by.partners_approved, 3);
    assert.equal(by.collected_pesewas, 4350);
    assert.equal(by.unsettled_pesewas, 4350, 'nothing paid out yet');
    assert.equal(by.reconciliation_issues, 0);
    assert.ok('median_vendor_response_seconds' in by);
    assert.ok('median_partner_match_seconds' in by);
    assert.ok('notifications_per_order' in by, 'SMS volume is measurable from day one');
  });

  test('metrics are admin-only', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.partnerYaw]) {
      const rows = await asUser(
        actor,
        async (c) => (await c.query('select * from public.admin_pilot_metrics()')).rows
      );
      assert.deepEqual(rows, []);
    }
  });

  // =========================================================================
  // PROVIDER RECONCILIATION
  // =========================================================================
  async function paidOrderWithTxn() {
    const order = await submitOrder();
    await vendorAccept(order.order_id);
    const payment = await payOrder(order.order_id);
    return { order, payment };
  }

  const reconcile = (rows) =>
    asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query('select * from public.admin_reconcile_against_provider($1, $2::jsonb)', [
            'fake',
            JSON.stringify(rows),
          ])
        ).rows
    );

  test('a matching provider statement reconciles to nothing', async () => {
    const { payment } = await paidOrderWithTxn();
    const issues = await reconcile([
      {
        provider_transaction_id: `fake_txn_${payment.id}`,
        status: 'SUCCEEDED',
        amount_pesewas: payment.amount_pesewas,
        kind: 'collection',
      },
    ]);
    assert.deepEqual(issues, []);
  });

  test('a charge the provider made that we never recorded is flagged', async () => {
    const { payment } = await paidOrderWithTxn();
    const issues = await reconcile([
      {
        provider_transaction_id: `fake_txn_${payment.id}`,
        status: 'SUCCEEDED',
        amount_pesewas: payment.amount_pesewas,
        kind: 'collection',
      },
      {
        provider_transaction_id: 'txn_we_never_saw',
        status: 'SUCCEEDED',
        amount_pesewas: 5000,
        kind: 'collection',
      },
    ]);
    const issue = issues.find((i) => i.provider_transaction_id === 'txn_we_never_saw');
    assert.ok(issue, 'the worst case: somebody was charged and we credited nobody');
    assert.equal(issue.issue, 'PROVIDER_ONLY');
  });

  test('a payment we recorded that the provider does not report is flagged', async () => {
    await paidOrderWithTxn();
    const issues = await reconcile([]);
    assert.ok(issues.some((i) => i.issue === 'MISSING_AT_PROVIDER'));
  });

  test('an amount or status disagreement is flagged', async () => {
    const { payment } = await paidOrderWithTxn();

    const amount = await reconcile([
      {
        provider_transaction_id: `fake_txn_${payment.id}`,
        status: 'SUCCEEDED',
        amount_pesewas: 9999,
        kind: 'collection',
      },
    ]);
    const mismatch = amount.find((i) => i.issue === 'AMOUNT_MISMATCH');
    assert.ok(mismatch);
    assert.equal(mismatch.provider_amount_pesewas, 9999);
    assert.equal(mismatch.our_amount_pesewas, payment.amount_pesewas);

    const status = await reconcile([
      {
        provider_transaction_id: `fake_txn_${payment.id}`,
        status: 'FAILED',
        amount_pesewas: payment.amount_pesewas,
        kind: 'collection',
      },
    ]);
    assert.ok(status.some((i) => i.issue === 'STATUS_MISMATCH'));
  });

  test('a webhook received but never processed is flagged', async () => {
    await asService((c) =>
      c.query(
        `insert into public.webhook_events (provider, event_id, payload, signature_valid, status, received_at)
         values ('fake', 'evt_stranded', '{}'::jsonb, true, 'RECEIVED', now() - interval '1 hour')`
      )
    );
    const issues = await reconcile([]);
    assert.ok(issues.some((i) => i.issue === 'WEBHOOK_UNPROCESSED'));
  });

  test('reconciliation writes nothing and is safe to repeat', async () => {
    const { payment } = await paidOrderWithTxn();
    const statement = [
      {
        provider_transaction_id: `fake_txn_${payment.id}`,
        status: 'SUCCEEDED',
        amount_pesewas: payment.amount_pesewas,
        kind: 'collection',
      },
    ];
    const first = await reconcile(statement);
    const second = await reconcile(statement);
    assert.deepEqual(first, second);

    const stored = await getOrder(payment.order_id);
    assert.equal(stored.payment_status, 'PAID', 'nothing changed');
  });

  test('provider reconciliation is admin-only', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff]) {
      const rows = await asUser(
        actor,
        async (c) =>
          (
            await c.query('select * from public.admin_reconcile_against_provider($1, $2::jsonb)', [
              'fake',
              '[]',
            ])
          ).rows
      );
      assert.deepEqual(rows, []);
    }
  });
});
