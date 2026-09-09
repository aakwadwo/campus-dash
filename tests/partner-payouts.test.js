import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  LOCATIONS,
} from './helpers/db.js';
import {
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
  setPartnerPayoutThreshold,
  expectRejection,
} from './helpers/flow.js';

/**
 * The Partner weekly payout policy.
 *
 * A Partner earns GH₵5 per completed delivery and is paid WEEKLY once their
 * available earnings reach GH₵20. Below that the balance carries forward.
 *
 * WHAT "CARRIES FORWARD" HAS TO MEAN, and it is the only interesting part: the
 * money must still be OWED and REACHABLE by the next run. The failure mode this
 * suite exists to prevent is the one where a run claims an allocation, declines
 * to pay it, and leaves it claimed — owed to nobody, attached to a payout that
 * will never be sent, and invisible to every later run. So every test below
 * asks the same question in a different way: where is the money now.
 *
 * The ledger is `allocations`, one row per completed delivery. There is no
 * second balance table to drift from it.
 */
describe('partner weekly payouts', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  const EARNING = 500; // GH₵5 per completed delivery
  const THRESHOLD = 2000; // GH₵20 weekly floor

  // Three periods over the same money, so distinct runs can be made against it.
  // Only period_end bounds the claim; period_start is what makes a run its own row.
  const WEEK_1 = ['2020-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  const WEEK_2 = ['2019-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  const WEEK_3 = ['2018-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];

  const service = (sql, params) => asService(async (c) => (await c.query(sql, params)).rows);
  const one = async (sql, params) => (await service(sql, params))[0];

  const run = (period = WEEK_1) =>
    one('select * from public.create_settlement_run($1, $2, $3)', ['PARTNER', ...period]);

  const payoutsFor = (runId) =>
    service('select * from public.payouts where settlement_run_id = $1', [runId]);

  const allPayouts = (partner = ACTORS.partnerYaw) =>
    service(
      "select * from public.payouts where payee_type = 'PARTNER' and payee_id = $1 order by created_at",
      [partner]
    );

  /** Completes `n` deliveries for a Partner through the real state machine. */
  async function earn(n, partner = ACTORS.partnerYaw) {
    for (let i = 0; i < n; i += 1) {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, partner);
      await completeDelivery(order.order_id, partner);
    }
  }

  const summaryFor = (partner = ACTORS.partnerYaw) =>
    asUser(
      partner,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );

  const owed = (partner = ACTORS.partnerYaw) =>
    asService(
      async (c) =>
        (
          await c.query(
            `select coalesce(sum(amount_pesewas),0)::bigint as n
               from public.allocations
              where payee_type='PARTNER' and payee_id=$1
                and status in ('PENDING','ELIGIBLE') and settlement_run_id is null`,
            [partner]
          )
        ).rows[0].n
    );

  // =========================================================================
  // Earning
  // =========================================================================

  test('each completed delivery adds GH₵5, and nothing else does', async () => {
    await earn(1);
    let s = await summaryFor();
    assert.equal(Number(s.delivered_count), 1);
    assert.equal(Number(s.earned_pesewas), EARNING);
    assert.equal(Number(s.available_pesewas), EARNING);

    await earn(2);
    s = await summaryFor();
    assert.equal(Number(s.delivered_count), 3);
    assert.equal(Number(s.available_pesewas), 3 * EARNING, 'GH₵15');
  });

  test('an accepted but unfinished delivery earns nothing', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const s = await summaryFor();
    assert.equal(Number(s.earned_pesewas), 0, 'the allocation is carved out at COMPLETION');
    assert.equal(Number(s.available_pesewas), 0);
  });

  test("one Partner's earnings never appear in another's balance", async () => {
    await earn(2, ACTORS.partnerYaw);
    assert.equal(Number((await summaryFor(ACTORS.partnerYaw)).available_pesewas), 2 * EARNING);
    assert.equal(Number((await summaryFor(ACTORS.partnerAdjoa)).available_pesewas), 0);
  });

  // =========================================================================
  // The threshold, at each amount the policy cares about
  // =========================================================================

  test('GH₵5, GH₵10 and GH₵15 are all below the floor and none is paid', async () => {
    for (const [count, expected] of [
      [1, 500],
      [2, 1000],
      [3, 1500],
    ]) {
      await resetTransactionalState();
      await earn(count);

      const s = await summaryFor();
      assert.equal(Number(s.available_pesewas), expected);
      assert.equal(Number(s.payout_threshold_pesewas), THRESHOLD);
      assert.equal(s.eligible_for_payout, false, `${expected} is under the floor`);
      assert.equal(Number(s.pesewas_to_threshold), THRESHOLD - expected);

      const settlement = await run();
      assert.equal(Number(settlement.total_pesewas), 0, 'nothing paid');
      assert.equal((await payoutsFor(settlement.id)).length, 0, 'no payout row at all');
      assert.equal(Number(settlement.deferred_payee_count), 1);
      assert.equal(Number(settlement.deferred_pesewas), expected);

      // AND THE MONEY IS STILL THERE, unclaimed and owed.
      assert.equal(Number(await owed()), expected, 'carried forward, not lost');
      assert.equal(Number((await summaryFor()).available_pesewas), expected);
    }
  });

  test('the fourth delivery reaches GH₵20 and the run pays it', async () => {
    await earn(4);

    const s = await summaryFor();
    assert.equal(Number(s.available_pesewas), 2000);
    assert.equal(s.eligible_for_payout, true);
    assert.equal(Number(s.pesewas_to_threshold), 0);

    const settlement = await run();
    const payouts = await payoutsFor(settlement.id);
    assert.equal(payouts.length, 1);
    assert.equal(Number(payouts[0].amount_pesewas), 2000);
    assert.equal(Number(settlement.deferred_payee_count), 0);
    assert.equal(Number(await owed()), 0, 'the balance moved into the payout');
  });

  test('above the floor the WHOLE balance goes, not just the threshold', async () => {
    await earn(7); // GH₵35
    const settlement = await run();
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 1);
    assert.equal(Number(payouts[0].amount_pesewas), 3500, 'GH₵35, not GH₵20');
    assert.equal(Number(await owed()), 0, 'and no remainder is stranded');
  });

  // =========================================================================
  // Rollover
  // =========================================================================

  test('a held balance accumulates across weeks and a later run clears it', async () => {
    await earn(2); // GH₵10
    const week1 = await run(WEEK_1);
    assert.equal(Number(week1.total_pesewas), 0);
    assert.equal(Number(week1.deferred_pesewas), 1000);
    assert.equal(Number(await owed()), 1000, 'still owed after week 1');

    await earn(1); // GH₵15
    const week2 = await run(WEEK_2);
    assert.equal(Number(week2.total_pesewas), 0, 'still short');
    assert.equal(Number(await owed()), 1500);

    await earn(1); // GH₵20
    const week3 = await run(WEEK_3);
    const payouts = await payoutsFor(week3.id);
    assert.equal(payouts.length, 1);
    assert.equal(
      Number(payouts[0].amount_pesewas),
      2000,
      'every carried-forward pesewa is in the payout'
    );
    assert.equal(Number(await owed()), 0);
  });

  test('a run that held money leaves it claimable, not attached to a dead payout', async () => {
    await earn(2);
    const held = await run(WEEK_1);

    const claimed = await service(
      `select count(*)::int as n from public.allocations
        where payee_type='PARTNER' and settlement_run_id = $1`,
      [held.id]
    );
    assert.equal(claimed[0].n, 0, 'the claim was released in the same transaction that took it');

    const stillEligible = await service(
      `select count(*)::int as n from public.allocations
        where payee_type='PARTNER' and status='ELIGIBLE' and settlement_run_id is null`
    );
    assert.equal(stillEligible[0].n, 2, 'both earnings are eligible again');
  });

  test('money paid by one run is never swept up by the next', async () => {
    await earn(4);
    const first = await run(WEEK_1);
    assert.equal(Number(first.total_pesewas), 2000);

    const second = await run(WEEK_2);
    assert.equal(Number(second.total_pesewas), 0, 'nothing left to pay');
    assert.equal((await payoutsFor(second.id)).length, 0);
    assert.equal((await allPayouts()).length, 1, 'one payout, ever');
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  test('re-running the same week returns the same run and pays nobody twice', async () => {
    await earn(4);
    const first = await run(WEEK_1);
    const again = await run(WEEK_1);

    assert.equal(again.id, first.id, 'the same run comes back');
    assert.equal((await payoutsFor(first.id)).length, 1);
    assert.equal((await allPayouts()).length, 1);
  });

  test('two Partners each get their own payout, judged separately', async () => {
    await earn(4, ACTORS.partnerYaw); // GH₵20, eligible
    await earn(2, ACTORS.partnerAdjoa); // GH₵10, held

    const settlement = await run();
    const payouts = await payoutsFor(settlement.id);

    assert.equal(payouts.length, 1, 'only the eligible Partner is paid');
    assert.equal(payouts[0].payee_id, ACTORS.partnerYaw);
    assert.equal(Number(settlement.deferred_payee_count), 1);
    assert.equal(Number(settlement.deferred_pesewas), 1000);
    assert.equal(Number(await owed(ACTORS.partnerAdjoa)), 1000, 'the other carries forward');
  });

  test('a duplicate payout for one Partner in one run is impossible', async () => {
    await earn(4);
    const settlement = await run();
    const [payout] = await payoutsFor(settlement.id);

    const error = await expectRejection(
      service(
        `insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
         values ($1, 'PARTNER', $2, 2000, 'forced-duplicate')`,
        [settlement.id, ACTORS.partnerYaw]
      )
    );
    assert.match(error.message, /payouts_run_payee_unique/);
    assert.equal(Number(payout.amount_pesewas), 2000);
  });

  // =========================================================================
  // The transfer lifecycle
  // =========================================================================

  test('a payout is PENDING until the provider says otherwise, and only its event pays it', async () => {
    await earn(4);
    const settlement = await run();
    const [payout] = await payoutsFor(settlement.id);
    assert.equal(payout.status, 'PENDING');

    await service("select public.mark_payout_processing($1, 'paystack', 'TRF_week1')", [payout.id]);
    let after = await one('select * from public.payouts where id = $1', [payout.id]);
    assert.equal(after.status, 'PROCESSING', 'acceptance is not delivery');
    assert.equal(after.paid_at, null);

    // The allocations stay claimed while it is in flight, so a second run
    // cannot pay the same money.
    const second = await run(WEEK_2);
    assert.equal(Number(second.total_pesewas), 0);

    await service('select public.mark_payout_paid($1, $2, $3)', [payout.id, 'TRF_week1', 2000]);
    after = await one('select * from public.payouts where id = $1', [payout.id]);
    assert.equal(after.status, 'PAID');
    assert.ok(after.paid_at);

    const settled = await service(
      `select count(*)::int as n from public.allocations
        where payee_type='PARTNER' and status='SETTLED'`
    );
    assert.equal(settled[0].n, 4, 'the ledger records the money as gone');
  });

  test('a failed transfer returns the balance to the Partner, and a later run pays it', async () => {
    await earn(4);
    const settlement = await run(WEEK_1);
    const [payout] = await payoutsFor(settlement.id);

    await service('select public.fail_payout($1, $2)', [payout.id, 'provider declined']);
    const failed = await one('select * from public.payouts where id = $1', [payout.id]);
    assert.equal(failed.status, 'FAILED');

    assert.equal(Number(await owed()), 2000, 'the money is owed again, not lost');
    assert.equal(
      Number((await summaryFor()).available_pesewas),
      2000,
      'and the Partner sees it as available'
    );

    const retry = await run(WEEK_2);
    const retried = await payoutsFor(retry.id);
    assert.equal(retried.length, 1);
    assert.equal(Number(retried[0].amount_pesewas), 2000);
  });

  test('a Partner is never shown a provider failure reason', async () => {
    await earn(4);
    const settlement = await run();
    const [payout] = await payoutsFor(settlement.id);
    await service('select public.fail_payout($1, $2)', [
      payout.id,
      'paystack: amount below minimum transfer',
    ]);

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_partner_payouts(20)')).rows
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'PROCESSING', 'a failure reads as still being processed');
    const serialised = JSON.stringify(mine);
    assert.ok(!/paystack/i.test(serialised), 'the provider is never named to a Partner');
    assert.ok(!/minimum/i.test(serialised), 'and neither are its limits');
  });

  // =========================================================================
  // The policy is a setting
  // =========================================================================

  test('the threshold is GH₵20 by default and an administrator can change it', async () => {
    const config = await one('select * from public.pricing_config');
    assert.equal(Number(config.partner_min_payout_pesewas), THRESHOLD);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query(
          `select * from public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null, null, null, $2)`,
          ['lowering the weekly floor for the pilot', 1000]
        ),
      { commit: true }
    );

    assert.equal(
      Number((await one('select * from public.pricing_config')).partner_min_payout_pesewas),
      1000
    );

    await earn(2); // GH₵10, now exactly at the new floor
    const settlement = await run();
    assert.equal(Number(settlement.total_pesewas), 1000, 'the new policy applies immediately');

    const actions = await service(
      "select * from public.admin_actions where action = 'CONFIG_UPDATE'"
    );
    assert.equal(actions.length, 1, 'and the change is audited');
    assert.equal(actions[0].reason, 'lowering the weekly floor for the pilot');
  });

  test('a non-admin cannot change the payout policy', async () => {
    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query(
          `select public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null, null, null, $2)`,
          ['pay me now', 1]
        )
      )
    );
    assert.match(error.message, /admin privileges required/i);
  });

  test('the vendor floor and the Partner floor move independently', async () => {
    await setPartnerPayoutThreshold(5000);
    const config = await one('select * from public.pricing_config');
    assert.equal(Number(config.partner_min_payout_pesewas), 5000);
    assert.equal(Number(config.min_payout_pesewas), 0, 'the vendor floor is untouched');

    const partnerFloor = await one("select public.payout_threshold_for('PARTNER') as n");
    const vendorFloor = await one("select public.payout_threshold_for('VENDOR') as n");
    assert.equal(Number(partnerFloor.n), 5000);
    assert.equal(Number(vendorFloor.n), 0);
  });

  // =========================================================================
  // What an administrator sees
  // =========================================================================

  test('an administrator sees every balance, and who cannot be paid', async () => {
    await earn(4, ACTORS.partnerYaw);
    await earn(1, ACTORS.partnerAdjoa);

    const rows = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_partner_balances()')).rows
    );

    const yaw = rows.find((r) => r.partner_id === ACTORS.partnerYaw);
    const adjoa = rows.find((r) => r.partner_id === ACTORS.partnerAdjoa);

    assert.equal(Number(yaw.available_pesewas), 2000);
    assert.equal(yaw.eligible_for_payout, true);
    assert.equal(Number(adjoa.available_pesewas), 500);
    assert.equal(adjoa.eligible_for_payout, false);

    // Neither can actually be paid: no destination is registered in the fixture.
    assert.equal(yaw.has_destination, false);
    assert.equal(yaw.transfers_ready, false);

    for (const row of rows) {
      assert.ok(!('account_number' in row), 'an account number never reaches a screen');
    }
  });

  test('a non-admin gets nothing from the balances view', async () => {
    await earn(4);
    for (const actor of [ACTORS.partnerYaw, ACTORS.customerAma, ACTORS.vendor1Staff]) {
      const rows = await asUser(
        actor,
        async (c) => (await c.query('select * from public.admin_partner_balances()')).rows
      );
      assert.deepEqual(rows, [], 'is_admin() is checked in the function body');
    }
  });

  test('a Partner reads only their own payouts', async () => {
    await earn(4, ACTORS.partnerYaw);
    await run();

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_partner_payouts(20)')).rows
    );
    assert.equal(mine.length, 1);

    const theirs = await asUser(
      ACTORS.partnerAdjoa,
      async (c) => (await c.query('select * from public.my_partner_payouts(20)')).rows
    );
    assert.deepEqual(theirs, [], "another Partner's payouts are not visible");
  });

  test('no client role can write a payout or an allocation', async () => {
    await earn(4);
    for (const sql of [
      `insert into public.payouts (settlement_run_id, payee_type, payee_id, amount_pesewas, idempotency_key)
         values (gen_random_uuid(), 'PARTNER', '${ACTORS.partnerYaw}', 999900, 'mine')`,
      `update public.allocations set amount_pesewas = 999900 where payee_type = 'PARTNER'`,
      `update public.payouts set status = 'PAID' where payee_type = 'PARTNER'`,
    ]) {
      const error = await expectRejection(asUser(ACTORS.partnerYaw, (c) => c.query(sql)));
      assert.match(error.message, /permission denied/i);
    }
  });
});
