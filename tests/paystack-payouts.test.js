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
  MENU,
} from './helpers/db.js';
import {
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
  expectRejection,
} from './helpers/flow.js';

/**
 * The payout lifecycle a real provider forces on us, and the customer email a
 * hosted checkout requires.
 *
 * The fake provider let a payout go straight to PAID because it settled in
 * memory. Paystack does not: it ACCEPTS a transfer and tells us later whether
 * the money arrived. Everything below is about that gap — what a payout is
 * during it, and what happens to the money if the answer is "no".
 *
 * These run against the database directly, like the rest of the money tests,
 * because that is where the guarantees actually live.
 */
describe('paystack payout lifecycle', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(resetTransactionalState);

  const PERIOD = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  // A different period covering the same orders, so a SECOND run can be made.
  const WIDER_PERIOD = ['2019-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

  const service = (sql, params) => asService(async (c) => (await c.query(sql, params)).rows);
  const one = async (sql, params) => (await service(sql, params))[0];

  const run = (payeeType, period = PERIOD) =>
    one('select * from public.create_settlement_run($1, $2, $3)', [payeeType, ...period]);

  const payoutsFor = (runId) =>
    service(
      'select * from public.payouts where settlement_run_id = $1 order by amount_pesewas desc',
      [runId]
    );

  const allocationsFor = (payeeType, payeeId) =>
    service(
      'select * from public.allocations where payee_type = $1 and payee_id = $2 order by created_at',
      [payeeType, payeeId]
    );

  const payout = (id) => one('select * from public.payouts where id = $1', [id]);

  /** A delivered order, so there is money for all three payees. */
  async function deliveredOrder(options = {}) {
    const order = await orderReadyForDispatch(options);
    await partnerAccept(order.order_id, options.partner ?? ACTORS.partnerYaw);
    await completeDelivery(order.order_id, options.partner ?? ACTORS.partnerYaw);
    return order;
  }

  /** One vendor payout, sitting at PENDING, ready to be transferred. */
  async function pendingVendorPayout() {
    await deliveredOrder({ items: [{ menu_item_id: MENU.jollof, quantity: 1 }] });
    const settlement = await run('VENDOR');
    const [row] = await payoutsFor(settlement.id);
    return { run: settlement, payout: row };
  }

  // =========================================================================
  // Acceptance is not delivery
  // =========================================================================
  test('a payout the provider accepted is PROCESSING, not PAID', async () => {
    const { payout: row } = await pendingVendorPayout();
    assert.equal(row.status, 'PENDING');

    const processing = await one(
      "select * from public.mark_payout_processing($1, 'paystack', $2)",
      [row.id, 'TRF_accepted']
    );

    assert.equal(processing.status, 'PROCESSING');
    assert.equal(processing.provider, 'paystack');
    assert.equal(processing.provider_transfer_id, 'TRF_accepted');
    assert.equal(processing.paid_at, null, 'nothing has arrived yet');
  });

  test('a payout stays PROCESSING until the success event arrives', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_1')", [row.id]);

    // The allocations are claimed by the run, but not settled: the money is
    // committed to this payout and has not landed.
    const claimed = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(claimed.every((a) => a.status === 'SETTLING'));
    assert.ok(claimed.every((a) => a.settled_at === null));
    assert.equal((await payout(row.id)).status, 'PROCESSING');

    // transfer.success — and only now.
    const paid = await one("select * from public.mark_payout_paid($1, 'paystack', 'TRF_1')", [
      row.id,
    ]);
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.paid_at);

    const settled = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(settled.every((a) => a.status === 'SETTLED'));
  });

  test('a duplicate transfer.success pays nobody twice', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_dup')", [row.id]);

    const first = await one("select * from public.mark_payout_paid($1, 'paystack', 'TRF_dup')", [
      row.id,
    ]);
    const second = await one("select * from public.mark_payout_paid($1, 'paystack', 'TRF_dup')", [
      row.id,
    ]);

    assert.equal(first.status, 'PAID');
    assert.equal(second.status, 'PAID');
    assert.equal(second.paid_at.getTime(), first.paid_at.getTime(), 'the same payment, replayed');
  });

  test('the transfer webhook itself deduplicates on the provider event id', async () => {
    // Paystack sends no event id, so the adapter derives one from the event
    // name and the transfer id. This is what that anchor buys.
    const deliveries = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        one('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
          'paystack',
          'transfer.success:7001',
          JSON.stringify({ event: 'transfer.success', data: { id: 7001 } }),
          true,
        ])
      )
    );

    assert.equal(deliveries.filter((d) => d.is_new).length, 1);
    assert.equal(new Set(deliveries.map((d) => d.webhook_id)).size, 1);
  });

  test('a collection and a transfer with the same numeric id are different events', async () => {
    const charge = await one('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
      'paystack',
      'charge.success:4001',
      '{}',
      true,
    ]);
    const transfer = await one('select * from public.record_webhook_event($1, $2, $3::jsonb, $4)', [
      'paystack',
      'transfer.success:4001',
      '{}',
      true,
    ]);

    assert.equal(charge.is_new, true);
    assert.equal(transfer.is_new, true, 'the kind is part of the anchor');
  });

  // =========================================================================
  // A failed transfer must not strand the money
  // =========================================================================
  test('a failed transfer marks the payout FAILED and releases the allocation claim', async () => {
    const { run: settlement, payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_bad')", [row.id]);

    const failed = await one('select * from public.fail_payout($1, $2)', [
      row.id,
      'provider reported FAILED',
    ]);

    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.failure_reason, 'provider reported FAILED');

    const released = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(
      released.every((a) => a.status === 'ELIGIBLE'),
      'back in the pool'
    );
    assert.ok(
      released.every((a) => a.settlement_run_id === null),
      'and no longer claimed by the failed run'
    );
    assert.equal(settlement.total_pesewas, 3500);
  });

  test('money from a failed payout is swept into the next run', async () => {
    // The whole point of releasing the claim. Without it the vendor would
    // simply never be paid for those orders again.
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_bad')", [row.id]);
    await service('select public.fail_payout($1, $2)', [row.id, 'transfer failed']);

    const next = await run('VENDOR', WIDER_PERIOD);
    const [swept] = await payoutsFor(next.id);

    assert.ok(swept, 'the next run picked the money up');
    assert.equal(swept.amount_pesewas, 3500);
    assert.equal(swept.status, 'PENDING');
  });

  test('a late failure does not un-send money that already left', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_x')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_x')", [row.id]);

    const after = await one('select * from public.fail_payout($1, $2)', [row.id, 'too late']);
    assert.equal(after.status, 'PAID', 'a PAID payout is not reopened by a stray event');

    const settled = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(
      settled.every((a) => a.status === 'SETTLED'),
      'and the claim is not released'
    );
  });

  test('a duplicate transfer.failed is idempotent', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_y')", [row.id]);

    const first = await one('select * from public.fail_payout($1, $2)', [row.id, 'failed once']);
    const second = await one('select * from public.fail_payout($1, $2)', [row.id, 'failed again']);

    assert.equal(first.status, 'FAILED');
    assert.equal(second.status, 'FAILED');
    assert.equal(second.failure_reason, 'failed once', 'the first reason stands');
  });

  test('a webhook that arrives before the transfer response does not go backwards', async () => {
    const { payout: row } = await pendingVendorPayout();
    // transfer.success wins the race against our own HTTP response.
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_fast')", [row.id]);

    const late = await one("select * from public.mark_payout_processing($1, 'paystack', $2)", [
      row.id,
      'TRF_fast',
    ]);
    assert.equal(late.status, 'PAID', 'PROCESSING never drags a PAID payout back');
  });

  // =========================================================================
  // Matching an event to a payout
  // =========================================================================
  test('a transfer event finds its payout by the provider transfer id', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_find')", [row.id]);

    const found = await one('select * from public.payout_for_transfer($1, $2, $3)', [
      'paystack',
      'TRF_find',
      null,
    ]);
    assert.equal(found.id, row.id);
  });

  test('a transfer event finds its payout by the reference we handed over', async () => {
    // Paystack echoes our payout id back as the transfer reference, which is
    // what matches an event that arrives before we stored the transfer code.
    const { payout: row } = await pendingVendorPayout();

    const found = await one('select * from public.payout_for_transfer($1, $2, $3)', [
      'paystack',
      null,
      row.id,
    ]);
    assert.equal(found.id, row.id);
  });

  test('an unrecognised reference matches nothing rather than raising', async () => {
    const found = await one('select * from public.payout_for_transfer($1, $2, $3)', [
      'paystack',
      'TRF_unknown',
      'not-a-uuid-at-all',
    ]);
    assert.equal(found.id, null);
  });

  // =========================================================================
  // Retry is manual, and it re-claims what the failure released
  // =========================================================================
  test('retrying a failed payout re-claims its allocations and returns it to PENDING', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_r')", [row.id]);
    await service('select public.fail_payout($1, $2)', [row.id, 'transfer failed']);

    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, true);

    const reset = await payout(row.id);
    assert.equal(reset.status, 'PENDING');
    assert.equal(reset.failure_reason, null);
    assert.equal(reset.provider_transfer_id, null, 'a new attempt gets a new transfer');

    const reclaimed = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(reclaimed.every((a) => a.status === 'SETTLING'));
    assert.ok(reclaimed.every((a) => a.settlement_run_id === reset.settlement_run_id));
  });

  test('a retry is refused when a later run already swept the money', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service('select public.fail_payout($1, $2)', [row.id, 'transfer failed']);

    // The money moved on into a second run rather than sitting still.
    const next = await run('VENDOR', WIDER_PERIOD);
    assert.equal((await payoutsFor(next.id))[0].amount_pesewas, 3500);

    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, false);
    assert.match(retry.reason, /moved to another run/);

    // And the refusal changed nothing: the later run still holds the claim.
    assert.equal((await payout(row.id)).status, 'FAILED');
    const allocations = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(allocations.every((a) => a.settlement_run_id === next.id));
    assert.ok(allocations.every((a) => a.status === 'SETTLING'));
  });

  test('a paid payout is never retried', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_p')", [row.id]);

    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, false);
    assert.match(retry.reason, /already paid/);
  });

  test('a payout that never failed is not retried either', async () => {
    const { payout: row } = await pendingVendorPayout();
    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, false);
    assert.match(retry.reason, /only a failed payout/);
  });

  // =========================================================================
  // Transfer hardening: retry references, amount checks, reversals
  // =========================================================================
  test('a retry bumps the attempt counter, so the next reference is new', async () => {
    // D1. Paystack refuses a transfer reference it has seen, and manual retry
    // is the only recovery we have — so a retry must not reuse the payout id.
    const { payout: row } = await pendingVendorPayout();
    assert.equal(row.transfer_attempt, 0, 'first attempt uses the payout id as-is');

    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_1')", [row.id]);
    await service('select public.fail_payout($1, $2)', [row.id, 'transfer failed']);

    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, true);

    const after = await payout(row.id);
    assert.equal(after.transfer_attempt, 1, 'attempt incremented');
    assert.equal(after.status, 'PENDING');
    assert.equal(after.provider_transfer_id, null, 'the old transfer is not carried forward');

    // A second failure and retry keeps climbing, so every attempt differs.
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_2')", [row.id]);
    await service('select public.fail_payout($1, $2)', [row.id, 'again']);
    await service('select public.retry_payout($1)', [row.id]);
    assert.equal((await payout(row.id)).transfer_attempt, 2);
  });

  test('a transfer event still finds its payout through a retry reference', async () => {
    // The suffix keeps the payout id at the front precisely so this works.
    const { payout: row } = await pendingVendorPayout();

    for (const reference of [row.id, `${row.id}-r1`, `${row.id}-r17`]) {
      const found = await one('select * from public.payout_for_transfer($1, $2, $3)', [
        'paystack',
        null,
        reference,
      ]);
      assert.equal(found.id, row.id, reference);
    }
  });

  test('a transfer.success for the wrong amount does not pay the payout', async () => {
    // D2. The same guard confirm_payment applies to money coming in.
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_amt')", [row.id]);

    for (const wrong of [row.amount_pesewas - 1, row.amount_pesewas + 1, 1]) {
      const error = await expectRejection(
        service("select public.mark_payout_paid($1, 'paystack', 'TRF_amt', $2)", [row.id, wrong])
      );
      assert.match(error.message, /payout amount mismatch/i, String(wrong));
    }

    const after = await payout(row.id);
    assert.equal(after.status, 'PROCESSING', 'left for a person to look at, never PAID');
    assert.equal(after.paid_at, null);
    const allocations = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(
      allocations.every((a) => a.status === 'SETTLING'),
      'nothing was settled'
    );
  });

  test('the exact amount pays it, and a null amount skips the check', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_ok')", [row.id]);

    const paid = await one("select * from public.mark_payout_paid($1, 'paystack', 'TRF_ok', $2)", [
      row.id,
      row.amount_pesewas,
    ]);
    assert.equal(paid.status, 'PAID');

    // A synchronous provider reports no independent figure; null means "no
    // check possible", not "check passed".
    const replay = await one(
      "select * from public.mark_payout_paid($1, 'paystack', 'TRF_ok', $2)",
      [row.id, null]
    );
    assert.equal(replay.status, 'PAID', 'still idempotent');
  });

  test('a reversal after PAID restores the liability', async () => {
    // D3. The transfer completed and the money came back.
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_rev')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_rev', $2)", [
      row.id,
      row.amount_pesewas,
    ]);
    assert.ok(
      (await allocationsFor('VENDOR', VENDORS.one)).every((a) => a.status === 'SETTLED'),
      'settled first'
    );

    const reversed = await one('select * from public.reverse_payout($1, $2)', [
      row.id,
      'provider reversed this transfer',
    ]);

    assert.equal(reversed.status, 'REVERSED', 'not FAILED — it really did complete first');
    assert.equal(reversed.paid_at, null, 'no longer stands as paid');
    assert.equal(reversed.provider_transfer_id, 'TRF_rev', 'the transfer that happened is kept');

    const released = await allocationsFor('VENDOR', VENDORS.one);
    assert.ok(
      released.every((a) => a.status === 'ELIGIBLE'),
      'owed again'
    );
    assert.ok(
      released.every((a) => a.settlement_run_id === null),
      'and unclaimed'
    );
    assert.ok(released.every((a) => a.settled_at === null));
  });

  test('a duplicate reversal reverses once', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_d')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_d', $2)", [
      row.id,
      row.amount_pesewas,
    ]);

    const first = await one('select * from public.reverse_payout($1, $2)', [row.id, 'once']);
    const second = await one('select * from public.reverse_payout($1, $2)', [row.id, 'twice']);

    assert.equal(first.status, 'REVERSED');
    assert.equal(second.status, 'REVERSED');
    assert.equal(second.failure_reason, 'once', 'the first reason stands');

    const allocations = await allocationsFor('VENDOR', VENDORS.one);
    assert.equal(allocations.length, 1, 'no allocation was duplicated');
    assert.ok(allocations.every((a) => a.status === 'ELIGIBLE'));
  });

  test('a LATE transfer.failed after PAID is still ignored', async () => {
    // The distinction that matters: an out-of-order failure is not a reversal.
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_late')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_late', $2)", [
      row.id,
      row.amount_pesewas,
    ]);

    const after = await one('select * from public.fail_payout($1, $2)', [row.id, 'late failure']);
    assert.equal(after.status, 'PAID', 'money that left is not un-sent by a stray event');
    assert.ok(
      (await allocationsFor('VENDOR', VENDORS.one)).every((a) => a.status === 'SETTLED'),
      'and the allocations stay settled'
    );
  });

  test('a reversal before PAID is recorded as an ordinary failure', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_early')", [row.id]);

    const result = await one('select * from public.reverse_payout($1, $2)', [row.id, 'reversed']);
    assert.equal(result.status, 'FAILED', 'nothing was settled, so there is nothing to reverse');
    assert.ok(
      (await allocationsFor('VENDOR', VENDORS.one)).every(
        (a) => a.status === 'ELIGIBLE' && a.settlement_run_id === null
      ),
      'claim released either way'
    );
  });

  test('a reversed payout is not retried; the next run settles it instead', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_nr')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_nr', $2)", [
      row.id,
      row.amount_pesewas,
    ]);
    await service('select public.reverse_payout($1, $2)', [row.id, 'reversed']);

    const retry = await one('select * from public.retry_payout($1)', [row.id]);
    assert.equal(retry.success, false);
    assert.match(retry.reason, /reversed/i);

    // The money is genuinely owed again, so a later run picks it up.
    const next = await run('VENDOR', WIDER_PERIOD);
    const [swept] = await payoutsFor(next.id);
    assert.ok(swept, 'the next run settles it under a NEW payout');
    assert.equal(swept.amount_pesewas, row.amount_pesewas);
    assert.notEqual(swept.id, row.id);
  });

  test('a transfer.failed arriving after a reversal is a no-op, not a loop', async () => {
    // Raising here would 500 the webhook, which asks the provider to redeliver
    // the same event for ever.
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_l')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_l', $2)", [
      row.id,
      row.amount_pesewas,
    ]);
    await service('select public.reverse_payout($1, $2)', [row.id, 'reversed']);

    const after = await one('select * from public.fail_payout($1, $2)', [row.id, 'late failure']);
    assert.equal(after.status, 'REVERSED', 'stays reversed, and does not raise');
    assert.equal(after.failure_reason, 'reversed', 'the reversal reason stands');
  });

  test('a reversed payout cannot be quietly paid again', async () => {
    const { payout: row } = await pendingVendorPayout();
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_x')", [row.id]);
    await service("select public.mark_payout_paid($1, 'paystack', 'TRF_x', $2)", [
      row.id,
      row.amount_pesewas,
    ]);
    await service('select public.reverse_payout($1, $2)', [row.id, 'reversed']);

    const error = await expectRejection(
      service("select public.mark_payout_paid($1, 'paystack', 'TRF_x', $2)", [
        row.id,
        row.amount_pesewas,
      ])
    );
    assert.match(error.message, /was not payable/i);
    assert.equal((await payout(row.id)).status, 'REVERSED');
  });

  // =========================================================================
  // Partner weekly settlement is untouched by any of this
  // =========================================================================
  test('Partner payouts still settle weekly, one per Partner', async () => {
    await deliveredOrder({ partner: ACTORS.partnerYaw });
    await deliveredOrder({ partner: ACTORS.partnerAdjoa });

    const settlement = await run('PARTNER');
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 2);
    assert.ok(payouts.every((p) => p.amount_pesewas === 500));

    // And the same lifecycle applies to them.
    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_partner')", [
      payouts[0].id,
    ]);
    assert.equal((await payout(payouts[0].id)).status, 'PROCESSING');
  });

  // =========================================================================
  // None of this is reachable from a browser
  // =========================================================================
  test('no client role can drive the payout lifecycle', async () => {
    const { payout: row } = await pendingVendorPayout();

    for (const [sql, params] of [
      ["select public.mark_payout_processing($1, 'paystack', 'x')", [row.id]],
      ['select public.fail_payout($1, $2)', [row.id, 'let me out of this']],
      ['select public.retry_payout($1)', [row.id]],
      ["select public.payout_for_transfer('paystack', 'x', null)", []],
    ]) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql, params)));
      assert.match(error.message, /permission denied/i, sql);
    }
  });
});

describe('customer email for hosted checkout', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(resetTransactionalState);

  const emailOf = (userId) =>
    asService(
      async (c) =>
        (await c.query('select email from public.users where id = $1', [userId])).rows[0].email
    );

  test('a customer can give a real email address, and it is stored as given', async () => {
    await asUser(
      ACTORS.customerAma,
      (c) => c.query("select public.set_my_email('ama.mensah@example.com')"),
      { commit: true }
    );
    assert.equal(await emailOf(ACTORS.customerAma), 'ama.mensah@example.com');
  });

  test('the address is normalised to lower case, so a receipt is not lost to a capital', async () => {
    await asUser(
      ACTORS.customerAma,
      (c) => c.query("select public.set_my_email('  AMA@Example.COM ')"),
      {
        commit: true,
      }
    );
    assert.equal(await emailOf(ACTORS.customerAma), 'ama@example.com');
  });

  test('an address that is not an address is refused', async () => {
    for (const bad of ['', '   ', 'ama', 'ama@', '@example.com', 'ama @example.com']) {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) => c.query('select public.set_my_email($1)', [bad]))
      );
      assert.match(error.message, /email address/i, `"${bad}" should be refused`);
    }
  });

  test("it sets the CALLER's address and there is no argument for anyone else", async () => {
    await asUser(
      ACTORS.customerAma,
      (c) => c.query("select public.set_my_email('ama@example.com')"),
      {
        commit: true,
      }
    );
    await asUser(
      ACTORS.customerKwesi,
      (c) => c.query("select public.set_my_email('kwesi@example.com')"),
      {
        commit: true,
      }
    );

    assert.equal(await emailOf(ACTORS.customerAma), 'ama@example.com');
    assert.equal(await emailOf(ACTORS.customerKwesi), 'kwesi@example.com');
  });

  test('a signed-out visitor cannot set one', async () => {
    const error = await expectRejection(
      asAnon((c) => c.query("select public.set_my_email('anon@example.com')"))
    );
    assert.match(error.message, /permission denied|authentication required/i);
  });

  test('capabilities report the address, so the pay button knows whether to ask', async () => {
    const before = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select public.my_capabilities() as caps')).rows[0].caps
    );
    assert.equal(before.email, null);

    const after = await asUser(ACTORS.customerAma, async (c) => {
      await c.query("select public.set_my_email('ama@example.com')");
      return (await c.query('select public.my_capabilities() as caps')).rows[0].caps;
    });
    assert.equal(after.email, 'ama@example.com');
  });

  test('no email is ever generated for an account that has not given one', async () => {
    // The whole point. A synthesised address would send a receipt into a hole
    // and put a fiction in our own records.
    const emails = await asService(
      async (c) =>
        (await c.query('select count(*)::int as n from public.users where email is not null'))
          .rows[0]
    );
    assert.equal(emails.n, 0);
  });
});

describe('mobile money payout destinations', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const service = (sql, params) => asService(async (c) => (await c.query(sql, params)).rows);
  const one = async (sql, params) => (await service(sql, params))[0];

  const setVendorDestination = (network, number, name = 'Test Kitchen One') =>
    asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query(
            'select * from public.admin_set_payout_destination($1, $2, $3, $4, $5, $6)',
            ['VENDOR', VENDORS.one, network, number, name, 'pilot setup']
          )
        ).rows[0],
      { commit: true }
    );

  test('an admin sets where a vendor is paid', async () => {
    const row = await setVendorDestination('MTN', '0551234567');
    assert.equal(row.momo_network, 'MTN');
    assert.equal(row.account_number, '0551234567');
    assert.equal(row.provider_recipient_code, null, 'not registered with a provider yet');
  });

  test('an E.164 number is stored in the local form the provider wants', async () => {
    for (const given of ['+233551234567', '233551234567', '055 123 4567']) {
      const row = await setVendorDestination('MTN', given);
      assert.equal(row.account_number, '0551234567', given);
    }
  });

  test('a number that is not a Ghanaian mobile number is refused', async () => {
    for (const bad of ['12345', '0551234', '+44 7700 900123']) {
      const error = await expectRejection(setVendorDestination('MTN', bad));
      assert.match(error.message, /Ghanaian mobile money number/i, bad);
    }
  });

  test('only the three networks Paystack Ghana supports are accepted', async () => {
    for (const network of ['MTN', 'VODAFONE', 'AIRTELTIGO']) {
      const row = await setVendorDestination(network, '0551234567');
      assert.equal(row.momo_network, network);
    }
    const error = await expectRejection(setVendorDestination('GLO', '0551234567'));
    assert.match(error.message, /violates check constraint|momo_network/i);
  });

  test('changing the number clears the provider recipient, so the old one cannot be paid', async () => {
    await setVendorDestination('MTN', '0551234567');
    await service("select public.attach_payout_recipient('VENDOR', $1, 'paystack', 'RCP_first')", [
      VENDORS.one,
    ]);

    const beforeChange = await one("select * from public.payout_destination_for('VENDOR', $1)", [
      VENDORS.one,
    ]);
    assert.equal(beforeChange.provider_recipient_code, 'RCP_first');

    const changed = await setVendorDestination('MTN', '0209876543');
    assert.equal(changed.provider_recipient_code, null, 'a stale code would pay the old number');
    assert.equal(changed.provider, null);
  });

  test('correcting only the account NAME keeps the registered recipient', async () => {
    await setVendorDestination('MTN', '0551234567', 'Test Kitchn One');
    await service("select public.attach_payout_recipient('VENDOR', $1, 'paystack', 'RCP_keep')", [
      VENDORS.one,
    ]);

    const fixed = await setVendorDestination('MTN', '0551234567', 'Test Kitchen One');
    assert.equal(fixed.account_name, 'Test Kitchen One');
    assert.equal(fixed.provider_recipient_code, 'RCP_keep', 'the account did not move');
  });

  test('setting a destination writes an audit row', async () => {
    await setVendorDestination('MTN', '0551234567');
    const actions = await service(
      "select * from public.admin_actions where action = 'PAYOUT_DESTINATION_SET'"
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].target_id, VENDORS.one);
    assert.equal(actions[0].reason, 'pilot setup');
  });

  test('a Partner keeps their own destination, and only their own', async () => {
    const row = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (
          await c.query(
            "select * from public.partner_set_payout_destination('VODAFONE', '0201112222', 'Yaw Test-Partner')"
          )
        ).rows[0],
      { commit: true }
    );

    assert.equal(row.payee_id, ACTORS.partnerYaw, 'the payee is auth.uid(), never an argument');
    assert.equal(row.momo_network, 'VODAFONE');

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_payout_destination()')).rows[0]
    );
    assert.equal(mine.account_number, '0201112222');
    assert.equal(mine.is_ready, false, 'not registered with the provider yet');
  });

  test('somebody who is not an approved Partner has no destination to set', async () => {
    const error = await expectRejection(
      asUser(ACTORS.applicantKofi, (c) =>
        c.query(
          "select public.partner_set_payout_destination('MTN', '0551234567', 'Kofi Test-Applicant')"
        )
      )
    );
    assert.match(error.message, /approved Partner/i);
  });

  test('no client role can read the destinations table or the service functions', async () => {
    await setVendorDestination('MTN', '0551234567');

    // An account number is the one field that lets somebody redirect a
    // settlement. It is not on `vendors`, where anon can read every column.
    for (const runAs of [
      (fn) => asUser(ACTORS.customerAma, fn),
      (fn) => asUser(ACTORS.vendor1Staff, fn),
      asAnon,
    ]) {
      const error = await expectRejection(
        runAs((c) => c.query('select * from public.payout_destinations'))
      );
      assert.match(error.message, /permission denied/i);
    }

    for (const sql of [
      "select public.payout_destination_for('VENDOR', '20000000-0000-4000-8000-000000000001')",
      "select public.attach_payout_recipient('VENDOR', '20000000-0000-4000-8000-000000000001', 'paystack', 'RCP_x')",
    ]) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql)));
      assert.match(error.message, /permission denied/i, sql);
    }
  });

  test('a non-admin cannot set anybody else’s destination', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query(
          "select public.admin_set_payout_destination('VENDOR', $1, 'MTN', '0551234567', 'Someone Else', 'nope')",
          [VENDORS.one]
        )
      )
    );
    assert.match(error.message, /admin privileges required/i);
  });

  test('the platform is never a payout destination', async () => {
    const error = await expectRejection(
      asUser(ACTORS.admin, (c) =>
        c.query(
          "select public.admin_set_payout_destination('PLATFORM', $1, 'MTN', '0551234567', 'Campus Dash', 'nope')",
          [VENDORS.one]
        )
      )
    );
    assert.match(error.message, /payout_destinations_not_platform|check constraint/i);
  });
});
