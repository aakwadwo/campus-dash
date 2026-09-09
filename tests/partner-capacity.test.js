import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  dedicatedClient,
  resetTransactionalState,
  closePools,
  ACTORS,
} from './helpers/db.js';
import { orderReadyForDispatch, partnerAccept, getOrder, expectRejection } from './helpers/flow.js';

/**
 * Configurable Partner capacity.
 *
 * TWO IS NOW A DEFAULT, NOT A CONSTANT. An administrator changes
 * pricing_config.max_active_deliveries_per_partner and the very next acceptance
 * attempt reads it — there is no cache and no deploy.
 *
 * WHAT DOES NOT CHANGE IS THE GUARANTEE. The configured maximum decides how
 * many slots exist; orders_partner_active_slot_unique decides that two claims
 * never get the same one. Reading a number out of a table is not an atomicity
 * primitive and is not asked to be one — which is why the last tests here
 * bypass the function entirely and go at the index directly.
 */
describe('configurable Partner capacity', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  /** Sets the maximum the way an administrator does, with the audit that implies. */
  async function setMax(n) {
    return asUser(
      ACTORS.admin,
      (c) =>
        c.query(
          `select * from public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null, null, $2)`,
          [`capacity now ${n}`, n]
        ),
      { commit: true }
    );
  }

  function capacityFor(partner) {
    return asUser(
      partner,
      async (c) => (await c.query('select * from public.partner_capacity()')).rows[0]
    );
  }

  test('the default is two, and it is where an administrator finds it', async () => {
    const config = await asService(
      async (c) => (await c.query('select * from public.pricing_config')).rows[0]
    );
    assert.equal(config.max_active_deliveries_per_partner, 2);

    const capacity = await capacityFor(ACTORS.partnerYaw);
    assert.equal(capacity.max_active, 2);
    assert.equal(capacity.active_now, 0);
    assert.equal(capacity.slots_free, 2);
  });

  // =========================================================================
  // The limit at each configured value
  // =========================================================================

  test('at 1, the second acceptance is refused', async () => {
    await setMax(1);

    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();

    assert.equal((await partnerAccept(first.order_id, ACTORS.partnerYaw)).success, true);

    const blocked = await partnerAccept(second.order_id, ACTORS.partnerYaw);
    assert.equal(blocked.success, false);
    assert.match(blocked.reason, /already have an active delivery/i, 'and it reads as English');

    const stored = await getOrder(second.order_id);
    assert.equal(stored.delivery_status, 'SEARCHING', 'the order stays available to somebody else');
    assert.equal(stored.partner_id, null);
  });

  test('at 2, two are allowed and the third is refused', async () => {
    await setMax(2);

    const orders = await Promise.all([
      orderReadyForDispatch(),
      orderReadyForDispatch(),
      orderReadyForDispatch(),
    ]);

    assert.equal((await partnerAccept(orders[0].order_id, ACTORS.partnerYaw)).success, true);
    assert.equal((await partnerAccept(orders[1].order_id, ACTORS.partnerYaw)).success, true);

    const blocked = await partnerAccept(orders[2].order_id, ACTORS.partnerYaw);
    assert.equal(blocked.success, false);
    assert.match(blocked.reason, /2 active deliveries/i);
  });

  test('at 3, three are allowed and the fourth is refused', async () => {
    await setMax(3);

    const orders = [];
    for (let i = 0; i < 4; i += 1) orders.push(await orderReadyForDispatch());

    for (let i = 0; i < 3; i += 1) {
      const result = await partnerAccept(orders[i].order_id, ACTORS.partnerYaw);
      assert.equal(result.success, true, `acceptance ${i + 1} of 3`);
    }

    const blocked = await partnerAccept(orders[3].order_id, ACTORS.partnerYaw);
    assert.equal(blocked.success, false);
    assert.match(blocked.reason, /3 active deliveries/i);

    const capacity = await capacityFor(ACTORS.partnerYaw);
    assert.equal(capacity.max_active, 3);
    assert.equal(capacity.active_now, 3);
    assert.equal(capacity.slots_free, 0);
  });

  test('at 5, the slots are numbered 1 to 5 and each is used once', async () => {
    await setMax(5);

    const orders = [];
    for (let i = 0; i < 5; i += 1) orders.push(await orderReadyForDispatch());
    for (const order of orders) {
      assert.equal((await partnerAccept(order.order_id, ACTORS.partnerYaw)).success, true);
    }

    const slots = await asService(async (c) =>
      (
        await c.query(
          `select partner_slot from public.orders
              where partner_id = $1 and delivery_status = 'ASSIGNED'
              order by partner_slot`,
          [ACTORS.partnerYaw]
        )
      ).rows.map((r) => r.partner_slot)
    );
    assert.deepEqual(slots, [1, 2, 3, 4, 5], 'the lowest free slot, every time');
  });

  // =========================================================================
  // Changing it while the pilot is running
  // =========================================================================

  test('raising the limit takes effect on the very next acceptance', async () => {
    const orders = [];
    for (let i = 0; i < 3; i += 1) orders.push(await orderReadyForDispatch());

    await partnerAccept(orders[0].order_id, ACTORS.partnerYaw);
    await partnerAccept(orders[1].order_id, ACTORS.partnerYaw);
    assert.equal((await partnerAccept(orders[2].order_id, ACTORS.partnerYaw)).success, false);

    await setMax(3);

    const now = await partnerAccept(orders[2].order_id, ACTORS.partnerYaw);
    assert.equal(now.success, true, 'no restart, no deploy, no cache to clear');
  });

  test('lowering the limit never takes an order off somebody already carrying it', async () => {
    await setMax(3);
    const orders = [];
    for (let i = 0; i < 4; i += 1) orders.push(await orderReadyForDispatch());
    for (let i = 0; i < 3; i += 1) await partnerAccept(orders[i].order_id, ACTORS.partnerYaw);

    await setMax(1);

    // All three are still theirs, still live, still in their slots.
    const held = await asService(
      async (c) =>
        (
          await c.query(
            `select id, partner_slot, delivery_status from public.orders
              where partner_id = $1 order by partner_slot`,
            [ACTORS.partnerYaw]
          )
        ).rows
    );
    assert.equal(held.length, 3, 'nothing was taken away');
    assert.deepEqual(
      held.map((o) => o.delivery_status),
      ['ASSIGNED', 'ASSIGNED', 'ASSIGNED']
    );

    // But nothing new is accepted until they are back under the limit.
    const blocked = await partnerAccept(orders[3].order_id, ACTORS.partnerYaw);
    assert.equal(blocked.success, false);

    const capacity = await capacityFor(ACTORS.partnerYaw);
    assert.equal(capacity.max_active, 1);
    assert.equal(capacity.active_now, 3);
    assert.equal(capacity.slots_free, 0, 'never negative');
  });

  test('finishing a delivery frees the slot at any configured limit', async () => {
    await setMax(1);
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();

    await partnerAccept(first.order_id, ACTORS.partnerYaw);
    assert.equal((await partnerAccept(second.order_id, ACTORS.partnerYaw)).success, false);

    const { completeDelivery } = await import('./helpers/flow.js');
    await completeDelivery(first.order_id, ACTORS.partnerYaw);

    assert.equal(
      (await partnerAccept(second.order_id, ACTORS.partnerYaw)).success,
      true,
      'a finished delivery does not hold its slot'
    );
  });

  // =========================================================================
  // The limit is an index, not a number in a function
  // =========================================================================

  test('the configured limit cannot be exceeded by two simultaneous acceptances', async () => {
    await setMax(1);
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();

    // ONE Partner, TWO connections, both committing. The count in the WHERE
    // clause can be read by both before either commits; the unique slot index
    // cannot be raced.
    const a = await dedicatedClient(ACTORS.partnerYaw);
    const b = await dedicatedClient(ACTORS.partnerYaw);

    try {
      const [ra, rb] = await Promise.all([
        a.query('select * from public.partner_accept_delivery($1)', [first.order_id]),
        b.query('select * from public.partner_accept_delivery($1)', [second.order_id]),
      ]);

      const won = [ra.rows[0], rb.rows[0]].filter((r) => r.success);
      assert.equal(won.length, 1, 'exactly one acceptance survives a tie at a limit of one');
    } finally {
      await a.end();
      await b.end();
    }

    const live = await asService(
      async (c) =>
        (
          await c.query(
            `select count(*)::int as n from public.orders
              where partner_id = $1 and delivery_status in ('ASSIGNED','PICKED_UP')`,
            [ACTORS.partnerYaw]
          )
        ).rows[0].n
    );
    assert.equal(live, 1, 'and the database agrees');
  });

  test('the slot index refuses a direct write, whatever the function believes', async () => {
    await setMax(3);
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    await partnerAccept(first.order_id, ACTORS.partnerYaw);

    // Bypass every function and reuse an occupied slot as superuser.
    const taken = await asService(
      async (c) =>
        (await c.query('select partner_slot from public.orders where id = $1', [first.order_id]))
          .rows[0].partner_slot
    );

    const error = await expectRejection(
      asService((c) =>
        c.query(
          `update public.orders
              set partner_id = $1, partner_slot = $2, delivery_status = 'ASSIGNED', assigned_at = now()
            where id = $3`,
          [ACTORS.partnerYaw, taken, second.order_id]
        )
      )
    );
    assert.match(error.message, /orders_partner_active_slot_unique/);
  });

  // =========================================================================
  // The setting itself
  // =========================================================================

  test('only an administrator may change it, and the change is audited', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query(
          `select public.admin_update_config(
             $1, null, null, null, null, null, null, null, null, null, null, null, null, null, $2)`,
          ['let me carry ten', 10]
        )
      )
    );
    assert.match(error.message, /admin privileges required/i);

    await setMax(4);
    const actions = await asService(
      async (c) =>
        (await c.query("select * from public.admin_actions where action = 'CONFIG_UPDATE'")).rows
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].reason, 'capacity now 4');
    assert.equal(actions[0].admin_user_id, ACTORS.admin);
    assert.equal(actions[0].before_state.max_active_deliveries_per_partner, 2);
    assert.equal(actions[0].after_state.max_active_deliveries_per_partner, 4);
  });

  test('a nonsensical limit is refused rather than stored', async () => {
    for (const value of [0, -1, 11, 100]) {
      const error = await expectRejection(setMax(value));
      assert.match(error.message, /between 1 and 10/i, `refused ${value}`);
    }

    const config = await asService(
      async (c) => (await c.query('select * from public.pricing_config')).rows[0]
    );
    assert.equal(config.max_active_deliveries_per_partner, 2, 'unchanged by every refusal');
  });

  test('changing another setting leaves the capacity alone', async () => {
    await setMax(3);
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_update_config($1, $2)', ['fee change only', 600]),
      { commit: true }
    );

    const config = await asService(
      async (c) => (await c.query('select * from public.pricing_config')).rows[0]
    );
    assert.equal(config.service_fee_bps, 600);
    assert.equal(config.max_active_deliveries_per_partner, 3, 'blank means leave alone');
  });
});
