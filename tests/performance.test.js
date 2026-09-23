import { test, describe, before, beforeEach, after } from 'node:test';
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
  payOrder,
  vendorReady,
  partnerAccept,
  expectRejection,
} from './helpers/flow.js';
import { WRITES_THAT_INVALIDATE } from '@/lib/customer/catalogue';

/**
 * WHAT THE PERFORMANCE WORK MUST NOT HAVE CHANGED.
 *
 * The order screen's poll asks a small question instead of re-rendering; the
 * question has to be the caller's own and has to move whenever the screen
 * would. The shared catalogue cache is expired by name, so every name has to
 * be a function that exists. And the store's board, rewritten to stop reading a
 * store's whole history, still answers only to its staff.
 */
after(async () => {
  await resetTransactionalState();
  await closePools();
});

const signalFor = (orderId, who = ACTORS.customerAma) =>
  asUser(
    who,
    async (c) =>
      (await c.query('select public.customer_order_signal($1) as s', [orderId])).rows[0].s
  );

describe("the customer's order signal", () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  test('moves with every step somebody else takes', async () => {
    const order = await submitOrder();
    const seen = [await signalFor(order.order_id)];

    await payOrder(order.order_id);
    seen.push(await signalFor(order.order_id));
    await partnerAccept(order.order_id);
    seen.push(await signalFor(order.order_id));
    await vendorReady(order.order_id);
    seen.push(await signalFor(order.order_id));

    assert.ok(seen.every(Boolean), 'the owner always gets an answer');
    assert.equal(new Set(seen).size, seen.length, 'each step changed it');
  });

  test('is stable while nothing happens', async () => {
    const order = await submitOrder();
    await payOrder(order.order_id);
    assert.equal(await signalFor(order.order_id), await signalFor(order.order_id));
  });

  test('is nobody else’s', async () => {
    const order = await submitOrder();
    assert.equal(await signalFor(order.order_id, ACTORS.customerKwesi), null, 'another customer');
    assert.equal(await signalFor(order.order_id, ACTORS.partnerYaw), null, 'a Partner');
    await expectRejection(
      asAnon((c) => c.query('select public.customer_order_signal($1)', [order.order_id]))
    );
  });
});

describe('the catalogue cache', () => {
  test('every write that expires it is a real function', async () => {
    const found = await asService(async (c) =>
      (
        await c.query(
          "select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)",
          [WRITES_THAT_INVALIDATE]
        )
      ).rows.map((r) => r.proname)
    );
    const missing = WRITES_THAT_INVALIDATE.filter((name) => !found.includes(name));
    assert.deepEqual(missing, [], 'a misspelt name would leave the cache stale');
  });
});

describe("the store's board, without its whole history", () => {
  before(resetTransactionalState);

  test('still answers only to the store', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await payOrder(order.order_id);

    const board = (who) =>
      asUser(
        who,
        async (c) =>
          (await c.query('select * from public.vendor_order_board($1, 5)', [VENDORS.one])).rows
      );

    assert.ok((await board(ACTORS.vendor1Staff)).some((r) => r.order_id === order.order_id));
    assert.deepEqual(await board(ACTORS.vendor2Staff), [], 'another store');
    assert.deepEqual(await board(ACTORS.customerAma), [], 'the customer');
  });
});
