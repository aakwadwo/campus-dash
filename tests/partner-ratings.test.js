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
  acceptedOrder,
  orderReadyForDispatch,
  partnerAccept,
  partnerConfirmPickup,
  completeDelivery,
  payOrder,
  vendorReady,
  tryTransition,
  expectRejection,
} from './helpers/flow.js';

/**
 * Partner ratings.
 *
 * THE ORDER IS THE PRIMARY KEY. That is the whole duplicate rule: a second
 * rating for the same delivery cannot exist, so there is no window in which two
 * taps become two rows and no counter to keep in step.
 *
 * THE PARTNER IS NOT A PARAMETER. customer_rate_partner reads them off the
 * order, so there is nothing a hand-built request can aim at somebody else —
 * which is the only interesting attack on a ratings system.
 */
describe('partner ratings', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  /** A delivery taken all the way to COMPLETED by the named Partner. */
  async function deliveredOrder({
    partner = ACTORS.partnerYaw,
    customer = ACTORS.customerAma,
  } = {}) {
    const order = await orderReadyForDispatch({ customer, destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, partner);
    await completeDelivery(order.order_id, partner);
    return order;
  }

  function rate(customer, orderId, stars, comment = null) {
    return tryTransition(customer, 'select public.customer_rate_partner($1, $2, $3)', [
      orderId,
      stars,
      comment,
    ]);
  }

  function ratingsFor(orderId) {
    return asService(
      async (c) =>
        (await c.query('select * from public.partner_ratings where order_id = $1', [orderId])).rows
    );
  }

  // =========================================================================
  // The happy path
  // =========================================================================

  test('the customer rates the Partner who brought it, and everything is recorded', async () => {
    const order = await deliveredOrder();

    const result = await rate(ACTORS.customerAma, order.order_id, 5, 'Fast, and knocked properly.');
    assert.equal(result.success, true);

    const [rating] = await ratingsFor(order.order_id);
    assert.equal(rating.order_id, order.order_id);
    assert.equal(rating.customer_id, ACTORS.customerAma);
    assert.equal(rating.partner_id, ACTORS.partnerYaw, 'read off the order, never sent');
    assert.equal(rating.stars, 5);
    assert.equal(rating.comment, 'Fast, and knocked properly.');
    assert.ok(rating.created_at instanceof Date);
  });

  test('the comment is optional', async () => {
    const order = await deliveredOrder();
    assert.equal((await rate(ACTORS.customerAma, order.order_id, 4)).success, true);
    const [rating] = await ratingsFor(order.order_id);
    assert.equal(rating.comment, null);
  });

  test('a blank comment is stored as no comment, not as blank', async () => {
    const order = await deliveredOrder();
    await rate(ACTORS.customerAma, order.order_id, 3, '   ');
    const [rating] = await ratingsFor(order.order_id);
    assert.equal(rating.comment, null);
  });

  test('the order screen offers the prompt once, and stops offering it', async () => {
    const order = await deliveredOrder();

    let detail = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [order.order_id])).rows[0]
    );
    assert.equal(detail.can_rate_partner, true);
    assert.equal(detail.rated_stars, null);

    await rate(ACTORS.customerAma, order.order_id, 5);

    detail = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [order.order_id])).rows[0]
    );
    assert.equal(detail.can_rate_partner, false, 'the prompt does not come back');
    assert.equal(detail.rated_stars, 5);
  });

  // =========================================================================
  // What cannot be rated
  // =========================================================================

  test('one rating per delivery, however many times the button is pressed', async () => {
    const order = await deliveredOrder();
    assert.equal((await rate(ACTORS.customerAma, order.order_id, 5)).success, true);

    const second = await rate(ACTORS.customerAma, order.order_id, 1, 'changed my mind');
    assert.equal(second.success, false);
    assert.match(second.reason, /already rated/i);

    const rows = await ratingsFor(order.order_id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stars, 5, 'the first answer stands');
  });

  test('an order still in flight cannot be rated', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);

    const result = await rate(ACTORS.customerAma, order.order_id, 5);
    assert.equal(result.success, false);
    assert.match(result.reason, /once it is complete/i);
    assert.equal((await ratingsFor(order.order_id)).length, 0);
  });

  test('a self-collected order has no Partner to rate', async () => {
    const order = await acceptedOrder({ fulfilment: 'PICKUP' });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    const secrets = await asService(
      async (c) =>
        (await c.query('select * from public.order_secrets where order_id = $1', [order.order_id]))
          .rows[0]
    );
    // The store reads the code out; the CUSTOMER types it in.
    await tryTransition(ACTORS.customerAma, 'select public.customer_complete_pickup($1,$2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const result = await rate(ACTORS.customerAma, order.order_id, 5);
    assert.equal(result.success, false);
    assert.match(result.reason, /no Partner brought this order/i);
  });

  test('a customer cannot rate somebody else’s delivery', async () => {
    const order = await deliveredOrder({ customer: ACTORS.customerAma });

    // AUTHORISATION failure, so it RAISES. And a stranger's order and an order
    // that does not exist get the same message, so probing tells them nothing.
    const notMine = await expectRejection(
      asUser(ACTORS.customerKwesi, (c) =>
        c.query('select public.customer_rate_partner($1, $2, $3)', [order.order_id, 1, null])
      )
    );
    assert.match(notMine.message, /not your order/i);

    const noSuchOrder = await expectRejection(
      asUser(ACTORS.customerKwesi, (c) =>
        c.query('select public.customer_rate_partner($1, $2, $3)', [
          '00000000-0000-4000-8000-0000000000ff',
          1,
          null,
        ])
      )
    );
    assert.match(noSuchOrder.message, /not your order/i, 'the same message, deliberately');

    assert.equal((await ratingsFor(order.order_id)).length, 0);
  });

  test('a Partner cannot rate themselves, or anybody', async () => {
    const order = await deliveredOrder();
    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select public.customer_rate_partner($1, $2, $3)', [order.order_id, 5, 'me'])
      )
    );
    assert.match(error.message, /not your order/i);
  });

  test('a rating outside one to five is refused', async () => {
    const order = await deliveredOrder();
    for (const stars of [0, -1, 6, 99, null]) {
      const error = await expectRejection(
        asUser(ACTORS.customerAma, (c) =>
          c.query('select public.customer_rate_partner($1, $2, $3)', [order.order_id, stars, null])
        )
      );
      assert.match(error.message, /one and five stars/i, `refused ${stars}`);
    }
    assert.equal((await ratingsFor(order.order_id)).length, 0);
  });

  test('a comment longer than the column allows is refused by the database', async () => {
    const order = await deliveredOrder();
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.customer_rate_partner($1, $2, $3)', [
          order.order_id,
          5,
          'x'.repeat(501),
        ])
      )
    );
    assert.match(error.message, /comment_length/);
  });

  // =========================================================================
  // Who may read what
  // =========================================================================

  test('no client role can write a rating directly', async () => {
    const order = await deliveredOrder();
    for (const sql of [
      `insert into public.partner_ratings (order_id, partner_id, customer_id, stars)
         values ('${order.order_id}', '${ACTORS.partnerYaw}', '${ACTORS.customerAma}', 5)`,
      `update public.partner_ratings set stars = 5 where order_id = '${order.order_id}'`,
      `delete from public.partner_ratings where order_id = '${order.order_id}'`,
    ]) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql)));
      assert.match(error.message, /permission denied/i);
    }
  });

  test('a customer reads the rating they left, and nobody else’s', async () => {
    const mine = await deliveredOrder({ customer: ACTORS.customerAma });
    await rate(ACTORS.customerAma, mine.order_id, 5);

    const theirs = await deliveredOrder({
      customer: ACTORS.customerKwesi,
      partner: ACTORS.partnerAdjoa,
    });
    await rate(ACTORS.customerKwesi, theirs.order_id, 2, 'left it at the gate');

    const visible = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.partner_ratings')).rows
    );
    assert.equal(visible.length, 1);
    assert.equal(visible[0].order_id, mine.order_id);
  });

  test('a Partner sees their average, never the individual rows', async () => {
    // WHY AN AGGREGATE. With two deliveries an hour, one row plus a timestamp
    // names the customer who left it — and a Partner who can identify a
    // complainant is a Partner somebody is afraid to rate honestly.
    const first = await deliveredOrder();
    await rate(ACTORS.customerAma, first.order_id, 5);
    const second = await deliveredOrder({ customer: ACTORS.customerKwesi });
    await rate(ACTORS.customerKwesi, second.order_id, 2, 'was late');

    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_ratings')).rows
    );
    assert.deepEqual(rows, [], 'RLS gives a Partner no individual rating at all');

    const summary = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_partner_rating()')).rows[0]
    );
    assert.equal(Number(summary.rating_count), 2);
    assert.equal(Number(summary.average_stars), 3.5);

    const earnings = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(Number(earnings.rating_count), 2);
    assert.equal(Number(earnings.average_stars), 3.5);
  });

  test('one Partner’s ratings never count towards another’s', async () => {
    const yaws = await deliveredOrder({ partner: ACTORS.partnerYaw });
    await rate(ACTORS.customerAma, yaws.order_id, 5);

    const adjoas = await asUser(
      ACTORS.partnerAdjoa,
      async (c) => (await c.query('select * from public.my_partner_rating()')).rows[0]
    );
    assert.equal(Number(adjoas.rating_count), 0);
    assert.equal(adjoas.average_stars, null);
  });

  test('an administrator can read every rating, and filter to the bad ones', async () => {
    const good = await deliveredOrder();
    await rate(ACTORS.customerAma, good.order_id, 5, 'great');
    const bad = await deliveredOrder({ customer: ACTORS.customerKwesi });
    await rate(ACTORS.customerKwesi, bad.order_id, 1, 'never arrived');

    const all = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_partner_ratings()')).rows
    );
    assert.equal(all.length, 2);
    assert.ok(all[0].order_number, 'with the order it is about');
    assert.ok(all[0].partner_name && all[0].customer_name, 'and both people');

    const low = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_partner_ratings(null, 2::smallint, 50)')).rows
    );
    assert.equal(low.length, 1);
    assert.equal(low[0].stars, 1);
    assert.equal(low[0].comment, 'never arrived');

    // And the roster carries the standing, which is the question the list is for.
    const partners = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_partners()')).rows
    );
    const yaw = partners.find((p) => p.user_id === ACTORS.partnerYaw);
    assert.equal(Number(yaw.rating_count), 2, 'both deliveries were his');
    assert.equal(Number(yaw.average_stars), 3, 'five and one');
  });

  test('a non-admin gets nothing from the admin ratings view', async () => {
    const order = await deliveredOrder();
    await rate(ACTORS.customerAma, order.order_id, 5);

    for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.vendor1Staff]) {
      const rows = await asUser(
        actor,
        async (c) => (await c.query('select * from public.admin_partner_ratings()')).rows
      );
      assert.deepEqual(rows, [], 'is_admin() is checked in the function body');
    }
  });
});
