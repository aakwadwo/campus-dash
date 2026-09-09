import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  LOCATIONS,
} from './helpers/db.js';
import { orderReadyForDispatch, completeDelivery, expectRejection } from './helpers/flow.js';

/**
 * Customer rewards.
 *
 * THE COUNT IS NOT A COUNTER. It is a COUNT(*) over orders in order_status
 * COMPLETED, so there is no second number to keep in step with the order list
 * and nothing that can drift. Most of what follows is proving that the things
 * which are NOT that state — cancelled, rejected, expired, half-finished — are
 * therefore not in it, without a single rule being written to exclude them.
 *
 * The reward ROW is the only thing written, and it exists so that reaching the
 * goal is a fact with a timestamp rather than a number somebody saw on a screen
 * once. Its uniqueness is (user_id, cycle), which is what makes the 51st order
 * create nothing.
 */
describe('customer rewards', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  const GOAL = 50;
  const MILESTONES = [25, 40, 50];

  /**
   * Completes `n` orders for a customer as directly as the state machine
   * permits.
   *
   * Walking fifty orders through submit → accept → pay → prepare → ready →
   * assign → pick up → deliver would take minutes and prove nothing this file
   * is about. So the first one goes the whole way — that is the test that the
   * trigger fires on the REAL path — and the rest are inserted at COMPLETED
   * through the same UPDATE the transition performs, which is what the trigger
   * watches.
   */
  async function completeOrders(customer, n, { startAt = 0 } = {}) {
    await asService(async (c) => {
      for (let i = 0; i < n; i += 1) {
        const { rows } = await c.query(
          `insert into public.orders
             (customer_id, vendor_id, order_type, fulfilment_type, order_status,
              payment_status, delivery_status, destination_location_id,
              subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, total_pesewas,
              submitted_at, accepted_at)
           values ($1, $2, 'FOOD', 'PICKUP', 'READY', 'PAID', 'NONE', null,
                   1000, 50, 0, 1050, now(), now())
           returning id`,
          [customer, VENDORS.one]
        );
        // The transition itself, which is what the trigger is attached to.
        await c.query(
          `update public.orders set order_status = 'COMPLETED', completed_at = now()
            where id = $1`,
          [rows[0].id]
        );
      }
    });
    return startAt + n;
  }

  function progressFor(userId) {
    return asUser(
      userId,
      async (c) => (await c.query('select * from public.my_reward_progress()')).rows[0]
    );
  }

  function rewardsFor(userId) {
    return asService(
      async (c) =>
        (
          await c.query('select * from public.customer_rewards where user_id = $1 order by cycle', [
            userId,
          ])
        ).rows
    );
  }

  // =========================================================================
  // The count
  // =========================================================================

  test('a real completed delivery counts, through the whole state machine', async () => {
    const order = await orderReadyForDispatch({
      customer: ACTORS.customerAma,
      destination: LOCATIONS.room204,
    });
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select * from public.partner_accept_delivery($1)', [order.order_id]),
      { commit: true }
    );
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 1, 'the delivery counted');
    assert.equal(progress.goal_orders, GOAL);
    assert.deepEqual(progress.milestones, MILESTONES);
  });

  test('an order that never completed is not counted, and no rule excludes it', async () => {
    // One of each way an order can end without the customer getting anything.
    await asService(async (c) => {
      for (const status of ['CANCELLED', 'REJECTED', 'EXPIRED']) {
        await c.query(
          `insert into public.orders
             (customer_id, vendor_id, order_status, payment_status, delivery_status,
              subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, total_pesewas, submitted_at)
           values ($1, $2, $3, 'UNPAID', 'NONE', 1000, 50, 0, 1050, now())`,
          [ACTORS.customerAma, VENDORS.one, status]
        );
      }
      // And one still in flight.
      await c.query(
        `insert into public.orders
           (customer_id, vendor_id, order_status, payment_status, delivery_status,
            subtotal_pesewas, service_fee_pesewas, delivery_fee_pesewas, total_pesewas, submitted_at)
         values ($1, $2, 'PREPARING', 'PAID', 'NONE', 1000, 50, 0, 1050, now())`,
        [ACTORS.customerAma, VENDORS.one]
      );
    });

    const progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 0);
    assert.equal(progress.reward_unlocked, false);
  });

  test("one customer's orders never count towards another's", async () => {
    await completeOrders(ACTORS.customerKwesi, 5);
    const ama = await progressFor(ACTORS.customerAma);
    const kwesi = await progressFor(ACTORS.customerKwesi);
    assert.equal(ama.completed_orders, 0);
    assert.equal(kwesi.completed_orders, 5);
  });

  // =========================================================================
  // The milestones, exactly as specified
  // =========================================================================

  test('24 reaches no milestone; the 25th reaches the first', async () => {
    await completeOrders(ACTORS.customerAma, 24);
    let progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 24);
    assert.deepEqual(progress.milestones_reached, [], 'nothing reached yet');
    assert.equal(progress.next_milestone, 25);
    assert.equal(progress.orders_to_next, 1);
    assert.equal(progress.reward_unlocked, false);

    await completeOrders(ACTORS.customerAma, 1);
    progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 25);
    assert.deepEqual(progress.milestones_reached, [25], 'the first mark');
    assert.equal(progress.next_milestone, 40);
    assert.equal(progress.reward_unlocked, false, 'a milestone is not the reward');
  });

  test('39 reaches no new milestone; the 40th reaches the second', async () => {
    await completeOrders(ACTORS.customerAma, 39);
    let progress = await progressFor(ACTORS.customerAma);
    assert.deepEqual(progress.milestones_reached, [25], 'still only the first');
    assert.equal(progress.next_milestone, 40);
    assert.equal(progress.orders_to_next, 1);

    await completeOrders(ACTORS.customerAma, 1);
    progress = await progressFor(ACTORS.customerAma);
    assert.deepEqual(progress.milestones_reached, [25, 40]);
    assert.equal(progress.next_milestone, 50);
    assert.equal(progress.orders_to_next, 10);
    assert.equal(progress.reward_unlocked, false);
  });

  test('49 has not reached the goal; the 50th unlocks the reward', async () => {
    await completeOrders(ACTORS.customerAma, 49);
    let progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 49);
    assert.equal(progress.reward_unlocked, false, 'one short is not there');
    assert.equal(progress.orders_to_next, 1);
    assert.equal((await rewardsFor(ACTORS.customerAma)).length, 0, 'and nothing is recorded');

    await completeOrders(ACTORS.customerAma, 1);
    progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 50);
    assert.deepEqual(progress.milestones_reached, [25, 40, 50]);
    assert.equal(progress.next_milestone, null, 'there is nothing after the goal');
    assert.equal(progress.reward_unlocked, true);
    assert.equal(progress.reward_status, 'UNLOCKED');
    assert.ok(progress.reward_unlocked_at instanceof Date);

    const rewards = await rewardsFor(ACTORS.customerAma);
    assert.equal(rewards.length, 1, 'exactly one reward');
    assert.equal(rewards[0].cycle, 1);
    assert.equal(rewards[0].goal_orders, GOAL);
    assert.equal(rewards[0].completed_orders_at_unlock, 50);
  });

  test('the 51st and every order after it creates no second reward', async () => {
    await completeOrders(ACTORS.customerAma, 50);
    assert.equal((await rewardsFor(ACTORS.customerAma)).length, 1);

    await completeOrders(ACTORS.customerAma, 1);
    assert.equal((await rewardsFor(ACTORS.customerAma)).length, 1, '51st changes nothing');

    await completeOrders(ACTORS.customerAma, 20);
    const rewards = await rewardsFor(ACTORS.customerAma);
    assert.equal(rewards.length, 1, '71 orders, still one reward');
    assert.equal(rewards[0].completed_orders_at_unlock, 50, 'and it still records where it began');

    const progress = await progressFor(ACTORS.customerAma);
    assert.equal(progress.completed_orders, 71);
    assert.equal(progress.reward_unlocked, true);
  });

  test('a second full run of the goal earns a second reward', async () => {
    await completeOrders(ACTORS.customerAma, 100);
    const rewards = await rewardsFor(ACTORS.customerAma);
    assert.equal(rewards.length, 2, 'one per completed run of the goal');
    assert.deepEqual(
      rewards.map((r) => r.cycle),
      [1, 2]
    );
  });

  test('re-completing an already completed order does not award anything twice', async () => {
    await completeOrders(ACTORS.customerAma, 50);
    assert.equal((await rewardsFor(ACTORS.customerAma)).length, 1);

    // The transition is guarded so this cannot happen through the application.
    // Forcing it here proves the trigger is idempotent even so: it fires only
    // on a change INTO completed, and the unique index catches the rest.
    await asService((c) =>
      c.query(
        `update public.orders set order_status = 'COMPLETED'
          where customer_id = $1 and order_status = 'COMPLETED'`,
        [ACTORS.customerAma]
      )
    );
    assert.equal((await rewardsFor(ACTORS.customerAma)).length, 1);
  });

  // =========================================================================
  // Authorisation
  // =========================================================================

  test('a customer reads only their own progress and their own rewards', async () => {
    await completeOrders(ACTORS.customerKwesi, 50);

    const ama = await progressFor(ACTORS.customerAma);
    assert.equal(ama.completed_orders, 0, "Ama does not see Kwesi's orders");
    assert.equal(ama.reward_unlocked, false);

    const rows = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.customer_rewards')).rows
    );
    assert.deepEqual(rows, [], 'RLS hides another customer’s reward row');
  });

  test('no client role can write a reward for themselves', async () => {
    for (const sql of [
      "insert into public.customer_rewards (user_id, cycle, goal_orders, completed_orders_at_unlock) values ('00000000-0000-4000-8000-000000000021', 1, 50, 50)",
      "update public.customer_rewards set status = 'FULFILLED' where cycle = 1",
      'delete from public.customer_rewards where cycle = 1',
    ]) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql)));
      assert.match(error.message, /permission denied/i);
    }
  });

  test('an administrator sees who is waiting, and records what was given', async () => {
    await completeOrders(ACTORS.customerAma, 50);

    const waiting = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query("select * from public.admin_customer_rewards('UNLOCKED', 100)")).rows
    );
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].user_id, ACTORS.customerAma);
    assert.equal(waiting[0].completed_orders, 50);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_settle_customer_reward($1, $2)', [
          waiting[0].reward_id,
          'Free lunch at Muni',
        ]),
      { commit: true }
    );

    const after = await rewardsFor(ACTORS.customerAma);
    assert.equal(after[0].status, 'FULFILLED');
    assert.equal(after[0].notes, 'Free lunch at Muni');
    assert.equal(after[0].fulfilled_by, ACTORS.admin);

    // And it is on the audit trail, like every other admin decision.
    const actions = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.admin_actions where action = 'SETTLE_CUSTOMER_REWARD'"
          )
        ).rows
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].reason, 'Free lunch at Muni');
  });

  test('a reward can only be settled once, and only by an administrator', async () => {
    await completeOrders(ACTORS.customerAma, 50);
    const [reward] = await rewardsFor(ACTORS.customerAma);

    const notAdmin = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.admin_settle_customer_reward($1, $2)', [reward.id, 'mine now'])
      )
    );
    assert.match(notAdmin.message, /admin only/i);

    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_settle_customer_reward($1, $2)', [reward.id, 'given']),
      { commit: true }
    );
    const again = await expectRejection(
      asUser(ACTORS.admin, (c) =>
        c.query('select public.admin_settle_customer_reward($1, $2)', [reward.id, 'given twice'])
      )
    );
    assert.match(again.message, /not open/i);
  });
});
