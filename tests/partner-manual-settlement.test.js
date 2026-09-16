import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  expectRejection,
  setPartnerPayoutThreshold,
} from './helpers/flow.js';

/**
 * Partners are paid by hand, and the SYSTEM says so.
 *
 * THE FAILURE THIS PREVENTS. It was already true in practice that no Partner
 * transfer left automatically — but only because `PAYSTACK_TRANSFERS_ENABLED`
 * is false. The settlement run called sendTransfer() for a Partner like any
 * other payee and was stopped by an environment variable, which is one deploy
 * away from being wrong, invisible to anybody reading the code, and guarding
 * money leaving to a destination nobody had checked.
 *
 * So it is a design now: a Partner run gathers what is owed into payouts and
 * STOPS. A person sends the money, records the reference, and that act appends
 * to admin_actions.
 *
 * THE LEDGER IS UNCHANGED BY ANY OF IT, which is the property worth asserting
 * hardest: "owed" and "settled" mean exactly what they meant before.
 */
describe('partner manual settlement', () => {
  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    await setPartnerPayoutThreshold(0);
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  /** One completed delivery, so the Partner is genuinely owed GH₵5. */
  async function earn(partner = ACTORS.partnerYaw) {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, partner);
    await completeDelivery(order.order_id, partner);
    return order.order_id;
  }

  const runPartnerSettlement = () =>
    asService(async (c) => {
      const end = new Date();
      end.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() + 1);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - 8);
      const { rows } = await c.query(
        "select * from public.create_settlement_run('PARTNER', $1, $2)",
        [start.toISOString(), end.toISOString()]
      );
      return rows[0];
    });

  const payoutsFor = (runId) =>
    asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [runId])).rows
    );

  const awaiting = () =>
    asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query("select * from public.admin_payouts_awaiting_settlement('PARTNER')")).rows
    );

  const allocationsFor = (partner) =>
    asService(
      async (c) =>
        (
          await c.query(
            `select status, amount_pesewas from public.allocations
              where payee_type = 'PARTNER' and payee_id = $1`,
            [partner]
          )
        ).rows
    );

  // =========================================================================
  // THE RUN CREATES, AND STOPS
  // =========================================================================
  test('a Partner run creates a payout and sends nothing', async () => {
    await earn();
    const run = await runPartnerSettlement();

    const payouts = await payoutsFor(run.id);
    assert.equal(payouts.length, 1, 'the money is gathered into a payout');
    assert.equal(Number(payouts[0].amount_pesewas), 500);
    assert.equal(payouts[0].status, 'PENDING', 'and it waits for a person');
    assert.equal(payouts[0].paid_at, null);
    assert.equal(payouts[0].provider_transfer_id, null, 'no provider has seen it');
  });

  /**
   * THE SOURCE-LEVEL CHECK, because the behaviour it guards is an absence and
   * an absence is exactly what a later edit restores by accident. A Partner run
   * must not reach sendPayout().
   */
  test('the settlement run does not transfer for a Partner, by design and not by config', () => {
    const source = readFileSync(new URL('../lib/settlement/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('export async function runSettlement(');
    const body = source.slice(start, source.indexOf('\n}', start));

    assert.match(body, /payeeType === 'PARTNER'/, 'the Partner case is explicit');
    assert.match(body, /if \(!manual\)/, 'and it is what gates sendPayout');

    // Comments stripped, because the prose above the code explains the old
    // behaviour by name and would otherwise match.
    const code = body.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(
      code,
      /PAYSTACK_TRANSFERS_ENABLED|transfersEnabled/,
      'an environment variable is not a policy'
    );
  });

  test('the run reports that nothing was sent, without calling it a failure', async () => {
    await earn();
    await runPartnerSettlement();

    const rows = await awaiting();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'PENDING');
  });

  // =========================================================================
  // RECORDING IT
  // =========================================================================
  describe('an administrator records the transfer', () => {
    test('marking one paid settles the allocations behind it', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);

      const before = await allocationsFor(ACTORS.partnerYaw);
      assert.equal(before[0].status, 'SETTLING', 'claimed by the run');

      const settled = await asUser(
        ACTORS.admin,
        async (c) =>
          (
            await c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
              payout.id,
              'MOMO-REF-9981',
              'weekly run, sent by MoMo',
            ])
          ).rows[0],
        { commit: true }
      );

      assert.equal(settled.status, 'PAID');
      assert.equal(settled.provider, 'manual', 'the rail is named honestly');
      assert.equal(settled.provider_transfer_id, 'MOMO-REF-9981');
      assert.ok(settled.paid_at);

      const after = await allocationsFor(ACTORS.partnerYaw);
      assert.equal(after[0].status, 'SETTLED', 'the liability clears');
    });

    /**
     * A manual settlement has NO provider event behind it, so the reference is
     * the only thing linking the row to a real transfer. A record saying money
     * moved with no way to check it is worse than no record.
     */
    test('it is refused without a reference', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);

      for (const reference of ['', '   ', null]) {
        const error = await expectRejection(
          asUser(ACTORS.admin, (c) =>
            c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
              payout.id,
              reference,
              'weekly run',
            ])
          )
        );
        assert.match(error.message, /reference/i);
      }

      assert.equal((await payoutsFor(run.id))[0].status, 'PENDING', 'nothing moved');
    });

    test('it appends to admin_actions', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);

      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
            payout.id,
            'MOMO-REF-1',
            'weekly run',
          ]),
        { commit: true }
      );

      const actions = await asService(
        async (c) =>
          (
            await c.query(
              `select action, target_type, target_id, reason from public.admin_actions
                where action = 'PAYOUT_SETTLED_MANUALLY'`
            )
          ).rows
      );
      assert.equal(actions.length, 1, 'who, what and why');
      assert.equal(actions[0].target_type, 'payout');
      assert.equal(actions[0].target_id, payout.id);
      assert.equal(actions[0].reason, 'weekly run');
    });

    /** A double-tapped button must not claim the money was sent twice. */
    test('recording it twice is idempotent', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);

      const settle = () =>
        asUser(
          ACTORS.admin,
          async (c) =>
            (
              await c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
                payout.id,
                'MOMO-REF-2',
                'weekly run',
              ])
            ).rows[0],
          { commit: true }
        );

      const first = await settle();
      const second = await settle();
      assert.equal(second.status, 'PAID');
      assert.equal(second.paid_at.toISOString(), first.paid_at.toISOString(), 'unchanged');

      const actions = await asService(
        async (c) =>
          (
            await c.query(
              "select count(*)::int as n from public.admin_actions where action = 'PAYOUT_SETTLED_MANUALLY'"
            )
          ).rows[0].n
      );
      assert.equal(actions, 1, 'and only one audit entry');
    });

    test('nobody but an administrator can record one', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);

      for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.vendor1Staff]) {
        const error = await expectRejection(
          asUser(actor, (c) =>
            c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
              payout.id,
              'MOMO-REF-X',
              'let me pay myself',
            ])
          )
        );
        assert.match(error.message, /admin privileges required/i);
      }

      assert.equal((await payoutsFor(run.id))[0].status, 'PENDING');
    });
  });

  // =========================================================================
  // WHAT THE OPERATOR SEES
  // =========================================================================
  describe('the weekly list', () => {
    test('shows who, how much and where — and only the last three digits', async () => {
      await earn();
      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_set_payout_destination($1,$2,$3,$4,$5,$6)', [
            'PARTNER',
            ACTORS.partnerYaw,
            'MTN',
            '0244123456',
            'Yaw Test-Partner',
            'weekly payouts',
          ]),
        { commit: true }
      );
      await runPartnerSettlement();

      const [row] = await awaiting();
      assert.equal(Number(row.amount_pesewas), 500);
      assert.equal(row.momo_network, 'MTN');
      assert.equal(row.account_last3, '456');
      assert.equal(Number(row.deliveries), 1);

      // AN OPERATOR NEEDS TO RECOGNISE A DESTINATION, not to be able to read a
      // full account number off a screen in a shared office.
      assert.doesNotMatch(JSON.stringify(row), /0244123456/);
    });

    test('a settled payout drops off it', async () => {
      await earn();
      const run = await runPartnerSettlement();
      const [payout] = await payoutsFor(run.id);
      assert.equal((await awaiting()).length, 1);

      await asUser(
        ACTORS.admin,
        (c) =>
          c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
            payout.id,
            'MOMO-REF-3',
            'weekly run',
          ]),
        { commit: true }
      );

      assert.deepEqual(await awaiting(), [], 'the list is what is left to do');
    });

    test('nobody but an administrator sees it', async () => {
      await earn();
      await runPartnerSettlement();

      for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw]) {
        const rows = await asUser(
          actor,
          async (c) =>
            (await c.query("select * from public.admin_payouts_awaiting_settlement('PARTNER')"))
              .rows
        );
        assert.deepEqual(rows, [], 'is_admin() is re-checked in the function body');
      }
    });
  });

  // =========================================================================
  // THE POLICY THE PARTNER IS TOLD
  // =========================================================================
  test('a Partner is never told about a provider or a provider failure', async () => {
    await earn();
    const run = await runPartnerSettlement();
    const [payout] = await payoutsFor(run.id);

    await asService((c) =>
      c.query("update public.payouts set status = 'FAILED', failure_reason = $1 where id = $2", [
        'paystack: recipient blocked',
        payout.id,
      ])
    );

    const mine = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_partner_payouts(20)')).rows
    );

    // Campus Dash's constraints are Campus Dash's to work within, not an
    // explanation owed to somebody who has done the work.
    assert.doesNotMatch(JSON.stringify(mine), /paystack|recipient blocked/i);
  });
});
