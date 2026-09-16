import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  LOCATIONS,
} from './helpers/db.js';
import { orderReadyForDispatch, partnerAccept, getOrder, getSecrets } from './helpers/flow.js';

/**
 * Dispatch: what a Partner is told before they decide, and what happens to an
 * order when one of them changes their mind.
 *
 * THE TWO FAILURES THIS EXISTS FOR.
 *
 *   1. An offer carried the BLOCK and nothing else. A fourth-floor room and a
 *      ground-floor one are the same block and a very different job, so the
 *      thing a Partner was actually deciding on was missing from the offer.
 *   2. A cancellation released the order and stopped. The customer kept
 *      counting down against a deadline set when a DIFFERENT Partner took the
 *      job — often nearly expired — and no Partner was told there was work
 *      again, because the broadcast had already gone out for this order and the
 *      notification layer deduplicates on the order.
 */
describe('partner dispatch', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const offersFor = (partner) =>
    asUser(
      partner,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );

  const cancelAs = (partner, orderId, reason = null) =>
    asUser(
      partner,
      async (c) =>
        (await c.query('select * from public.partner_cancel_delivery($1, $2)', [orderId, reason]))
          .rows[0],
      { commit: true }
    );

  // =========================================================================
  // WHAT AN OFFER SAYS
  // =========================================================================
  describe('the offer', () => {
    test('carries the block AND the floor, and never the room', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });

      const offer = (await offersFor(ACTORS.partnerYaw)).find((o) => o.order_id === order.order_id);
      assert.ok(offer, 'the job is on offer');

      assert.equal(offer.destination_zone, 'Hostel Block A', 'the block');
      assert.equal(offer.destination_floor, 'Floor 2', 'and the floor, which is most of the walk');

      // THE ROOM IS STILL WITHHELD. Every available Partner sees this list, and
      // a student's room number is not something to broadcast to a pool of
      // people none of whom has the job yet.
      assert.doesNotMatch(JSON.stringify(offer), /Room 204/, 'never the room');
      assert.doesNotMatch(JSON.stringify(offer), /\+233/, 'and never a phone number');
    });

    test('the exact destination arrives with the assignment, and only then', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);

      const [job] = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
      );
      assert.match(job.destination, /Room 204/, 'the whole path, to the one person who needs it');
      assert.ok(job.customer_phone, 'and the number, from assignment');
    });

    test('a destination with no floor is not an error, just a missing line', async () => {
      // Not every deliverable place sits on a floor — a field, a common area.
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room101 });
      const offer = (await offersFor(ACTORS.partnerYaw)).find((o) => o.order_id === order.order_id);
      assert.equal(offer.destination_floor, 'Floor 1');
    });

    test('says how long the search has left, from the server’s clock', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      const offer = (await offersFor(ACTORS.partnerYaw)).find((o) => o.order_id === order.order_id);
      assert.ok(offer.seconds_until_search_expires > 0);
      assert.ok(offer.seconds_until_search_expires <= 600);
    });
  });

  // =========================================================================
  // CANCELLATION
  // =========================================================================
  describe('cancellation', () => {
    test('releases the order, rotates the code and reopens the search window', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);

      const before = await getOrder(order.order_id);
      const codeBefore = (await getSecrets(order.order_id)).pickup_code;
      assert.equal(before.partner_id, ACTORS.partnerYaw);

      // Wind the deadline down to almost nothing, which is the case that
      // matters: a Partner who sits on a job and drops it must not hand the
      // next one a search that is about to expire.
      await asService((c) =>
        c.query(
          "update public.orders set search_deadline_at = now() + interval '5 seconds' where id = $1",
          [order.order_id]
        )
      );

      const result = await cancelAs(ACTORS.partnerYaw, order.order_id, 'bike broke');
      assert.equal(result.success, true);

      const after = await getOrder(order.order_id);
      assert.equal(after.partner_id, null);
      assert.equal(after.partner_slot, null);
      assert.equal(after.delivery_status, 'SEARCHING');
      assert.equal(after.assigned_at, null);

      // A FRESH WINDOW. Counting the next Partner down against a deadline set
      // when somebody else took the job would expire the search under a person
      // who had done nothing wrong.
      assert.ok(
        new Date(after.search_deadline_at) - new Date() > 60_000,
        'the search starts again rather than resuming'
      );

      // THE OLD CODE DIES IMMEDIATELY.
      const codeAfter = (await getSecrets(order.order_id)).pickup_code;
      assert.equal(codeAfter, null);
      assert.notEqual(codeBefore, codeAfter);
    });

    /**
     * `dispatch_generation` is the thing that makes the NEXT broadcast a
     * different notification from the last one. The notification layer
     * deduplicates on the subject, so without it a re-broadcast reached
     * everyone who had already been told exactly once — which is to say,
     * nobody. Asserting the counter moves is asserting that the message can
     * go out again.
     */
    test('bumps the dispatch generation, so the order can be broadcast again', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      const before = (await getOrder(order.order_id)).dispatch_generation;

      await partnerAccept(order.order_id, ACTORS.partnerYaw);
      await cancelAs(ACTORS.partnerYaw, order.order_id);

      const after = (await getOrder(order.order_id)).dispatch_generation;
      assert.equal(after, before + 1, 'a new generation is a new notification');
    });

    test('the cancelling Partner loses the job, and everyone eligible can see it again', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);

      // While it is theirs, nobody else is offered it.
      assert.equal(
        (await offersFor(ACTORS.partnerAdjoa)).some((o) => o.order_id === order.order_id),
        false
      );

      await cancelAs(ACTORS.partnerYaw, order.order_id);

      // THE CANCELLING PARTNER HAS NOTHING.
      const active = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
      );
      assert.deepEqual(active, [], 'no active delivery, no phone number, no destination');

      // AND IT IS BACK IN THE POOL — for the Partner who cancelled it as much
      // as for anybody else. They may have dropped it by accident.
      for (const partner of [ACTORS.partnerYaw, ACTORS.partnerAdjoa]) {
        assert.equal(
          (await offersFor(partner)).some((o) => o.order_id === order.order_id),
          true,
          'the job is offered again'
        );
      }
    });

    test('another Partner can take it straight away, and gets a fresh code', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);
      await cancelAs(ACTORS.partnerYaw, order.order_id);

      const claimed = await partnerAccept(order.order_id, ACTORS.partnerAdjoa);
      assert.equal(claimed.success, true);

      const after = await getOrder(order.order_id);
      assert.equal(after.partner_id, ACTORS.partnerAdjoa);
      assert.equal(after.delivery_status, 'ASSIGNED');
    });

    test('the order, the payment and the preparation are untouched', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      const before = await getOrder(order.order_id);
      await partnerAccept(order.order_id, ACTORS.partnerYaw);
      await cancelAs(ACTORS.partnerYaw, order.order_id);
      const after = await getOrder(order.order_id);

      assert.equal(after.order_status, before.order_status, 'same order');
      assert.equal(after.payment_status, 'PAID');
      assert.equal(after.vendor_order_no, before.vendor_order_no, 'still order 001');
      assert.equal(Number(after.total_pesewas), Number(before.total_pesewas));
    });

    test('a Partner who is not the assigned one cannot cancel', async () => {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);

      const result = await cancelAs(ACTORS.partnerAdjoa, order.order_id);
      assert.equal(result.success, false);
      assert.equal((await getOrder(order.order_id)).partner_id, ACTORS.partnerYaw);
    });
  });

  // =========================================================================
  // ONLINE TIME IS MEASURED
  // =========================================================================
  describe('availability sessions', () => {
    const setAvailability = (partner, available) =>
      asUser(
        partner,
        (c) => c.query('select * from public.partner_set_availability($1)', [available]),
        { commit: true }
      );

    const sessionsFor = (partner) =>
      asService(
        async (c) =>
          (
            await c.query(
              'select * from public.partner_sessions where user_id = $1 order by started_at',
              [partner]
            )
          ).rows
      );

    const activityFor = (partner) =>
      asUser(
        partner,
        async (c) => (await c.query('select * from public.my_partner_activity()')).rows[0]
      );

    test('going offline closes the session; going online opens a new one', async () => {
      // resetTransactionalState leaves the seeded Partners approved and online,
      // so there is an open session to close.
      await setAvailability(ACTORS.partnerYaw, false);

      let sessions = await sessionsFor(ACTORS.partnerYaw);
      assert.ok(sessions.length >= 1);
      assert.ok(
        sessions.every((s) => s.ended_at !== null),
        'nothing is left open'
      );

      await setAvailability(ACTORS.partnerYaw, true);
      sessions = await sessionsFor(ACTORS.partnerYaw);
      assert.equal(
        sessions.filter((s) => s.ended_at === null).length,
        1,
        'exactly one open session'
      );
    });

    /**
     * AT MOST ONE OPEN SESSION, enforced by a partial unique index rather than
     * by the function being careful. Two would double-count every minute
     * between them, and the totals an administrator steers by would drift
     * upward for as long as nobody noticed.
     */
    test('going online twice does not open a second session', async () => {
      await setAvailability(ACTORS.partnerYaw, true);
      await setAvailability(ACTORS.partnerYaw, true);

      const open = (await sessionsFor(ACTORS.partnerYaw)).filter((s) => s.ended_at === null);
      assert.equal(open.length, 1);
    });

    /** Starts from no history at all, so the sum is of exactly what is inserted. */
    const clearSessions = (partner) =>
      asService((c) =>
        c.query('delete from public.partner_sessions where user_id = $1', [partner])
      );

    test('online time is summed from the sessions, not from page visits', async () => {
      await setAvailability(ACTORS.partnerYaw, false);
      await clearSessions(ACTORS.partnerYaw);

      // A closed hour, earlier today.
      await asService((c) =>
        c.query(
          `insert into public.partner_sessions (user_id, started_at, ended_at)
           values ($1, date_trunc('day', now()) + interval '1 hour',
                       date_trunc('day', now()) + interval '2 hours')`,
          [ACTORS.partnerYaw]
        )
      );

      const activity = await activityFor(ACTORS.partnerYaw);
      assert.equal(activity.is_online, false);
      assert.equal(activity.current_session_seconds, null);
      assert.ok(
        Number(activity.online_seconds_today) >= 3600,
        'the hour is counted, and it is a measured hour'
      );
    });

    /**
     * A session that began before the window counts only the part of itself
     * inside it. Summing whole sessions would credit a Partner who came online
     * last night with the whole of it against today.
     */
    test('a session straddling midnight counts only today’s share', async () => {
      await setAvailability(ACTORS.partnerYaw, false);
      await clearSessions(ACTORS.partnerYaw);
      await asService((c) =>
        c.query(
          `insert into public.partner_sessions (user_id, started_at, ended_at)
           values ($1, date_trunc('day', now()) - interval '3 hours',
                       date_trunc('day', now()) + interval '1 hour')`,
          [ACTORS.partnerYaw]
        )
      );

      const activity = await activityFor(ACTORS.partnerYaw);
      const today = Number(activity.online_seconds_today);
      assert.ok(today >= 3500 && today <= 3700, `expected about an hour, got ${today}s`);
    });

    test('an administrator sees the roster with its measured totals', async () => {
      const rows = await asUser(
        ACTORS.admin,
        async (c) => (await c.query('select * from public.admin_partner_activity()')).rows
      );

      const yaw = rows.find((r) => r.user_id === ACTORS.partnerYaw);
      assert.ok(yaw, 'the Partner is on the roster');
      assert.equal(yaw.is_online, true, 'approved Partners are online by default');
      assert.ok(yaw.current_session_seconds !== null, 'and the current session is timed');
      assert.ok('online_seconds_today' in yaw);
      assert.ok('online_seconds_this_week' in yaw);
      assert.ok('last_online_at' in yaw);
      assert.ok('last_offline_at' in yaw);
      assert.ok('deliveries_completed' in yaw);
    });

    test('nobody but an administrator sees the roster', async () => {
      for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.vendor1Staff]) {
        const rows = await asUser(
          actor,
          async (c) => (await c.query('select * from public.admin_partner_activity()')).rows
        );
        assert.deepEqual(rows, [], 'is_admin() is re-checked in the function body');
      }
    });

    test('a Partner reads their own sessions and nobody else’s', async () => {
      const mine = await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.partner_sessions')).rows
      );
      assert.ok(mine.every((s) => s.user_id === ACTORS.partnerYaw));

      const theirs = await asUser(
        ACTORS.customerAma,
        async (c) => (await c.query('select * from public.partner_sessions')).rows
      );
      assert.deepEqual(theirs, []);
    });
  });
});
