import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
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
 * The minimum-payout hold.
 *
 * Below the threshold a transfer costs more in fees than it moves, so the run
 * declines to move it. The question every test here asks is the same one:
 * WHERE IS THE MONEY while it is being declined. The answer has to be "in the
 * pool, owed, and reachable by the next run" — because the version of this that
 * left it claimed by a run and attached to a payout nothing would ever send
 * stranded it permanently.
 *
 * The threshold therefore lives in create_settlement_run, applied before a
 * payout row exists, and a run sweeps everything eligible up to its period end
 * rather than only what its own window opened on.
 */
describe('minimum payout threshold', () => {
  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await setMinimum(0);
  });
  after(async () => {
    await setMinimum(0);
    await resetTransactionalState();
    await closePools();
  });

  // Three periods over the same orders, so three DISTINCT runs can be made
  // against the same money. Only period_end bounds the claim; period_start is
  // what makes a run its own row.
  const RUN_1 = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  const RUN_2 = ['2019-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  const RUN_3 = ['2018-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

  const service = (sql, params) => asService(async (c) => (await c.query(sql, params)).rows);
  const one = async (sql, params) => (await service(sql, params))[0];

  const setMinimum = (pesewas) =>
    service('update public.pricing_config set min_payout_pesewas = $1 where id', [pesewas]);

  const run = (payeeType, period = RUN_1) =>
    one('select * from public.create_settlement_run($1, $2, $3)', [payeeType, ...period]);

  const payoutsFor = (runId) =>
    service(
      'select * from public.payouts where settlement_run_id = $1 order by amount_pesewas desc',
      [runId]
    );

  const payoutsOf = (payeeType, payeeId) =>
    service(
      'select * from public.payouts where payee_type = $1 and payee_id = $2 order by created_at',
      [payeeType, payeeId]
    );

  const allocationsOf = (payeeType, payeeId) =>
    service(
      'select * from public.allocations where payee_type = $1 and payee_id = $2 order by created_at',
      [payeeType, payeeId]
    );

  /** What admin_pending_settlement says is owed — the operator's own view. */
  const owedTo = async (payeeType, payeeId) => {
    const rows = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_pending_settlement($1)', [payeeType])).rows
    );
    return rows.find((r) => r.payee_id === payeeId) ?? null;
  };

  /** One delivered order: GH₵35 to the vendor, GH₵5 to the Partner who ran it. */
  async function deliveredOrder(partner = ACTORS.partnerYaw) {
    const order = await orderReadyForDispatch({
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
    });
    await partnerAccept(order.order_id, partner);
    await completeDelivery(order.order_id, partner);
    return order;
  }

  // =========================================================================
  // 1. Below the threshold, nothing is created
  // =========================================================================
  test('a payee under the minimum gets no payout at all', async () => {
    await setMinimum(1200);
    await deliveredOrder();

    const settlement = await run('PARTNER');

    assert.deepEqual(await payoutsFor(settlement.id), [], 'no payout below the threshold');
    assert.equal(settlement.total_pesewas, 0, 'the run moved nothing');
    assert.equal(settlement.deferred_payee_count, 1);
    assert.equal(settlement.deferred_pesewas, 500, 'and says so, rather than looking empty');
  });

  test('the threshold is per payee, not per run', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder(ACTORS.partnerYaw);
    await deliveredOrder(ACTORS.partnerAdjoa);

    const settlement = await run('PARTNER');
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 1, 'only the Partner who cleared the threshold');
    assert.equal(payouts[0].payee_id, ACTORS.partnerYaw);
    assert.equal(payouts[0].amount_pesewas, 1500);
    assert.equal(settlement.deferred_payee_count, 1);
    assert.equal(settlement.deferred_pesewas, 500, 'the other Partner is still owed');
  });

  // =========================================================================
  // 2. Deferred is not stranded
  // =========================================================================
  test('deferred liability goes back into the pool, not into the run', async () => {
    await setMinimum(1200);
    await deliveredOrder();
    const settlement = await run('PARTNER');

    const allocations = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].status, 'ELIGIBLE', 'never left at SETTLING');
    assert.equal(allocations[0].settlement_run_id, null, 'and not stamped with the run');
    assert.equal(allocations[0].settled_at, null);

    // The whole failure mode was that this stopped saying the money was owed.
    const owed = await owedTo('PARTNER', ACTORS.partnerYaw);
    assert.ok(owed, 'the operator can still see it as owed');
    assert.equal(owed.owed_pesewas, 500);

    assert.equal(settlement.total_pesewas, 0);
    assert.deepEqual(await payoutsOf('PARTNER', ACTORS.partnerYaw), []);
  });

  // =========================================================================
  // 3. It accumulates, and a later run can reach it
  // =========================================================================
  test('held money accumulates until a later run clears the threshold', async () => {
    await setMinimum(1200);

    await deliveredOrder();
    const first = await run('PARTNER', RUN_1);
    assert.equal(first.deferred_pesewas, 500);
    assert.deepEqual(await payoutsFor(first.id), []);

    await deliveredOrder();
    const second = await run('PARTNER', RUN_2);
    assert.equal(second.deferred_pesewas, 1000, 'both deliveries, still short');
    assert.deepEqual(await payoutsFor(second.id), []);

    await deliveredOrder();
    const third = await run('PARTNER', RUN_3);
    const payouts = await payoutsFor(third.id);

    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].amount_pesewas, 1500, 'ALL THREE deliveries, none lost');
    assert.equal(third.total_pesewas, 1500);
    assert.equal(third.deferred_pesewas, 0);

    const allocations = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.equal(allocations.length, 3);
    assert.ok(
      allocations.every((a) => a.status === 'SETTLING' && a.settlement_run_id === third.id),
      'every held allocation is now claimed by the run that will pay it'
    );

    // Nothing was double-counted on the way: what the payout is worth is
    // exactly what was ever allocated.
    const total = allocations.reduce((sum, a) => sum + a.amount_pesewas, 0);
    assert.equal(total, payouts[0].amount_pesewas);
  });

  // =========================================================================
  // 4. No duplicate payout
  // =========================================================================
  test('money settled by an accumulating run is not settled again', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    assert.equal((await payoutsFor(first.id))[0].amount_pesewas, 1500);

    // A later run over the same orders finds nothing: the allocations are
    // claimed, and a claimed allocation is not eligible.
    const second = await run('PARTNER', RUN_2);
    assert.deepEqual(await payoutsFor(second.id), []);
    assert.equal(second.total_pesewas, 0);
    assert.equal(second.deferred_pesewas, 0, 'nothing is owed, so nothing is held');

    assert.equal(
      (await payoutsOf('PARTNER', ACTORS.partnerYaw)).length,
      1,
      'one payout for this money, ever'
    );
  });

  // =========================================================================
  // 5. Idempotence
  // =========================================================================
  test('re-running a period that deferred everything changes nothing', async () => {
    await setMinimum(1200);
    await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    const second = await run('PARTNER', RUN_1);

    assert.equal(second.id, first.id, 'the same run, returned');
    assert.equal(second.deferred_pesewas, 500);
    assert.deepEqual(await payoutsFor(first.id), [], 'and still no payout');

    const allocations = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.equal(allocations.length, 1);
    assert.equal(allocations[0].status, 'ELIGIBLE');
    assert.equal(allocations[0].settlement_run_id, null);

    const runs = await service(
      "select count(*)::int as n from public.settlement_runs where payee_type = 'PARTNER'"
    );
    assert.equal(runs[0].n, 1, 'pressing the button twice made one run');
  });

  test('re-running a period that DID pay does not pay again', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    const [payout] = await payoutsFor(first.id);
    await service("select public.mark_payout_processing($1, 'fake', 'TRF_min_1')", [payout.id]);
    await service("select public.mark_payout_paid($1, 'fake', 'TRF_min_1', $2)", [
      payout.id,
      payout.amount_pesewas,
    ]);

    const again = await run('PARTNER', RUN_1);
    assert.equal(again.id, first.id);
    assert.equal((await payoutsFor(first.id)).length, 1);
    assert.equal((await payoutsOf('PARTNER', ACTORS.partnerYaw)).length, 1);
  });

  // =========================================================================
  // 6. A failed payout still recovers — over the widened window
  // =========================================================================
  test('a failed payout releases its allocations and a later run sweeps them up', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    const [payout] = await payoutsFor(first.id);
    await service('select public.fail_payout($1, $2)', [payout.id, 'provider said no']);

    const released = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.ok(
      released.every((a) => a.status === 'ELIGIBLE' && a.settlement_run_id === null),
      'the claim is released, not stranded behind a dead payout'
    );
    assert.equal((await owedTo('PARTNER', ACTORS.partnerYaw)).owed_pesewas, 1500);

    const second = await run('PARTNER', RUN_2);
    const recovered = await payoutsFor(second.id);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].amount_pesewas, 1500, 'the whole liability, in a new payout');
    assert.notEqual(recovered[0].id, payout.id);
    assert.equal(
      (await one('select status from public.payouts where id = $1', [payout.id])).status,
      'FAILED'
    );
  });

  test('a failed payout can still be retried in place', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    const [payout] = await payoutsFor(first.id);
    await service('select public.fail_payout($1, $2)', [payout.id, 'network']);

    const retried = await one('select * from public.retry_payout($1)', [payout.id]);
    assert.equal(retried.success, true, retried.reason ?? '');

    const after = await one('select * from public.payouts where id = $1', [payout.id]);
    assert.equal(after.status, 'PENDING');
    assert.equal(after.transfer_attempt, 1, 'a fresh provider reference');
    assert.equal(after.amount_pesewas, 1500, 'for exactly what it was worth');

    const reclaimed = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.ok(reclaimed.every((a) => a.status === 'SETTLING' && a.settlement_run_id === first.id));
  });

  // =========================================================================
  // 7. A reversal puts the liability back, and it re-settles
  // =========================================================================
  test('a reversed payout restores the liability and a later run pays it again', async () => {
    await setMinimum(1200);
    for (let i = 0; i < 3; i += 1) await deliveredOrder();

    const first = await run('PARTNER', RUN_1);
    const [payout] = await payoutsFor(first.id);
    await service("select public.mark_payout_processing($1, 'fake', 'TRF_rev')", [payout.id]);
    await service("select public.mark_payout_paid($1, 'fake', 'TRF_rev', $2)", [
      payout.id,
      payout.amount_pesewas,
    ]);

    const reversed = await one('select * from public.reverse_payout($1, $2)', [
      payout.id,
      'provider reversed it',
    ]);
    assert.equal(reversed.status, 'REVERSED');
    assert.equal(reversed.paid_at, null);

    const restored = await allocationsOf('PARTNER', ACTORS.partnerYaw);
    assert.ok(
      restored.every((a) => a.status === 'ELIGIBLE' && a.settlement_run_id === null),
      'money that came back is owed again'
    );
    assert.equal((await owedTo('PARTNER', ACTORS.partnerYaw)).owed_pesewas, 1500);

    const second = await run('PARTNER', RUN_2);
    const repaid = await payoutsFor(second.id);
    assert.equal(repaid.length, 1);
    assert.equal(repaid[0].amount_pesewas, 1500);
    assert.notEqual(repaid[0].id, payout.id, 'a new payout, never a re-sent transfer');
  });

  // =========================================================================
  // 8. Cadence is unchanged
  // =========================================================================
  test('a run never claims money from after its period ends', async () => {
    await setMinimum(0);
    await deliveredOrder();

    // Yesterday's vendor run, made today. The order is newer than the window.
    const closed = await run('VENDOR', ['2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z']);
    assert.deepEqual(await payoutsFor(closed.id), [], 'the upper bound still bounds');
    assert.equal(closed.deferred_pesewas, 0);

    const allocations = await allocationsOf('VENDOR', VENDORS.one);
    assert.ok(allocations.every((a) => a.status === 'ELIGIBLE' && a.settlement_run_id === null));

    const open = await run('VENDOR', RUN_1);
    assert.equal((await payoutsFor(open.id))[0].amount_pesewas, 3500);
  });

  test('vendors settle daily and Partners weekly, unchanged', async () => {
    await setMinimum(0);
    await deliveredOrder();

    const vendorRun = await run('VENDOR', RUN_1);
    const partnerRun = await run('PARTNER', RUN_1);

    assert.equal((await payoutsFor(vendorRun.id))[0].amount_pesewas, 3500, 'the food');
    assert.equal((await payoutsFor(partnerRun.id))[0].amount_pesewas, 500, 'the delivery fee');
    assert.equal(vendorRun.deferred_pesewas, 0);
    assert.equal(partnerRun.deferred_pesewas, 0);

    // Each run took only its own payee type's money.
    const vendorPayouts = await payoutsFor(vendorRun.id);
    assert.ok(vendorPayouts.every((p) => p.payee_type === 'VENDOR'));
  });

  test('a threshold of zero holds nothing back', async () => {
    await setMinimum(0);
    await deliveredOrder();

    const settlement = await run('PARTNER');
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 1);
    assert.equal(payouts[0].amount_pesewas, 500, 'GH₵5 goes out when the threshold is off');
    assert.equal(settlement.deferred_payee_count, 0);
  });

  // =========================================================================
  // PLATFORM is not a payee
  // =========================================================================
  test('a PLATFORM run is refused rather than claiming the platform ledger', async () => {
    await deliveredOrder();

    const error = await expectRejection(run('PLATFORM'));
    assert.match(error.message, /PLATFORM revenue is not settled/);

    // The point of refusing: a PLATFORM run would have moved these to SETTLING
    // and then created no payout, because a PLATFORM allocation has no payee.
    const platform = await service(
      "select * from public.allocations where payee_type = 'PLATFORM'"
    );
    assert.ok(platform.length > 0);
    assert.ok(platform.every((a) => a.status === 'ELIGIBLE' && a.settlement_run_id === null));

    const payouts = await service("select * from public.payouts where payee_type = 'PLATFORM'");
    assert.deepEqual(payouts, [], 'the platform is never paid out');
  });
});
