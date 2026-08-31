import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, asUser, resetTransactionalState, closePools, ACTORS } from './helpers/db.js';
import { submitOrder, orderReadyForDispatch, getOrder, expectRejection } from './helpers/flow.js';

/**
 * The timeout jobs.
 *
 * Phase 2 built and tested the functions but nothing invoked them, so a vendor
 * who simply ignored an order left it SUBMITTED for ever. These verify the
 * schedule exists AND that it actually executes.
 */
describe('scheduled jobs', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  test('both jobs are registered and active', async () => {
    const jobs = await asService(
      async (c) =>
        (
          await c.query(
            "select jobname, schedule, active from cron.job where jobname like 'campus-dash-%' order by jobname"
          )
        ).rows
    );
    assert.deepEqual(jobs, [
      { jobname: 'campus-dash-expire-partner-search', schedule: '* * * * *', active: true },
      { jobname: 'campus-dash-expire-stale-orders', schedule: '30 seconds', active: true },
    ]);
  });

  test('the stale-order sweep runs on its own and takes no payment', async (t) => {
    const order = await submitOrder();
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '5 seconds' where id = $1",
        [order.order_id]
      )
    );

    // The job runs every 30s, so allow two intervals before giving up.
    let stored;
    for (let i = 0; i < 35; i += 1) {
      stored = await getOrder(order.order_id);
      if (stored.order_status === 'EXPIRED') break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (stored.order_status !== 'EXPIRED') {
      t.diagnostic('pg_cron did not fire within 70s — is the background worker running?');
    }
    assert.equal(stored.order_status, 'EXPIRED', 'the scheduler expired it with no manual call');
    assert.equal(stored.payment_status, 'UNPAID', 'an auto-rejected order is never charged');

    const payments = await asService(
      async (c) =>
        (await c.query('select * from public.payments where order_id = $1', [order.order_id])).rows
    );
    assert.equal(payments.length, 0);

    const events = await asService(
      async (c) =>
        (
          await c.query(
            "select actor_role, reason from public.order_events where order_id = $1 and event = 'ORDER_EXPIRED'",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].actor_role, 'SYSTEM', 'attributed to the scheduler, not a person');
  });

  test('the sweep leaves orders inside their window alone', async () => {
    const order = await submitOrder();
    await asService((c) => c.query('select public.expire_stale_orders()'));
    assert.equal((await getOrder(order.order_id)).order_status, 'SUBMITTED');
  });

  test('the sweep never touches an order the vendor already accepted', async () => {
    const order = await orderReadyForDispatch();
    await asService((c) =>
      c.query(
        "update public.orders set accept_deadline_at = now() - interval '1 hour' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_stale_orders()'));

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_status, 'READY', 'a passed deadline is irrelevant once accepted');
    assert.equal(stored.payment_status, 'PAID');
  });

  test('the dispatch sweep fails the delivery WITHOUT destroying the food order', async () => {
    const order = await orderReadyForDispatch();
    await asService((c) =>
      c.query(
        "update public.orders set search_deadline_at = now() - interval '1 second' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'FAILED_NO_PARTNER');
    assert.equal(stored.order_status, 'READY', 'the food still exists');
    assert.equal(stored.payment_status, 'PAID', 'and it is still paid for');
  });

  test('the dispatch sweep ignores an order a Partner already took', async () => {
    const order = await orderReadyForDispatch();
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select * from public.partner_accept_delivery($1)', [order.order_id]),
      { commit: true }
    );
    await asService((c) =>
      c.query(
        "update public.orders set search_deadline_at = now() - interval '1 hour' where id = $1",
        [order.order_id]
      )
    );
    await asService((c) => c.query('select public.expire_partner_search()'));

    assert.equal((await getOrder(order.order_id)).delivery_status, 'ASSIGNED');
  });

  test('neither sweep is callable by a signed-in user', async () => {
    for (const fn of ['expire_stale_orders', 'expire_partner_search']) {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) => c.query(`select public.${fn}()`))
      );
      assert.match(error.message, /permission denied/i, `${fn} must be server-side only`);
    }
  });

  test('an admin can see whether the jobs are actually running', async () => {
    const rows = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_scheduled_job_status()')).rows
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.active));

    const asCustomer = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.admin_scheduled_job_status()')).rows
    );
    assert.equal(asCustomer.length, 0, 'not an admin, not their business');
  });

  test('the jobs report success rather than failing silently', async () => {
    const runs = await asService(
      async (c) =>
        (
          await c.query(`
        select j.jobname, d.status
          from cron.job_run_details d
          join cron.job j using (jobid)
         where j.jobname like 'campus-dash-%'
         order by d.start_time desc limit 10
      `)
        ).rows
    );
    assert.ok(runs.length > 0, 'the scheduler has actually executed');
    const failures = runs.filter((r) => r.status !== 'succeeded' && r.status !== 'running');
    assert.deepEqual(failures, [], 'no failing scheduled runs');
  });
});
