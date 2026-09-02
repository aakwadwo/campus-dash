import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
  dedicatedClient,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  LOCATIONS,
} from './helpers/db.js';
import {
  orderReadyForDispatch,
  getOrder,
  getSecrets,
  expectRejection,
  tryTransition,
  submitOrder,
} from './helpers/flow.js';

/**
 * The Partner system.
 *
 * Registration, dispatch, the atomic claim, the handoff, and the two ways a
 * delivery can end badly. The privacy rules are tested from both sides: what a
 * Partner can see before the handoff, and what disappears after it.
 */
describe('partner system', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const asPartner = (userId, sql, params) =>
    asUser(userId, async (c) => (await c.query(sql, params)).rows, { commit: true });

  const activeDelivery = (userId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0] ?? null
    );

  const offers = (userId) =>
    asUser(userId, async (c) => (await c.query('select * from public.get_delivery_offers()')).rows);

  const application = (userId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.my_partner_application()')).rows[0] ?? null
    );

  const accept = (userId, orderId) =>
    asUser(
      userId,
      async (c) =>
        (await c.query('select * from public.partner_accept_delivery($1)', [orderId])).rows[0],
      { commit: true }
    );

  // =========================================================================
  // Registration
  // =========================================================================
  test('a customer applies, and lands in PENDING_REVIEW with documents recorded', async () => {
    const before = await application(ACTORS.customerAma);
    assert.equal(before, null, 'no application until they make one');

    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', [
      'TEST-STU-9001',
      'Class of 2029',
      'ama@example.com',
      'ama/student-id.jpg',
      'ama/face.jpg',
    ]);

    const after = await application(ACTORS.customerAma);
    assert.equal(after.status, 'PENDING_REVIEW');
    assert.equal(after.is_available, false, 'an applicant is not on shift');
    assert.equal(after.has_documents, true);

    const caps = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.is_partner, false, 'applying is not approval');
    assert.equal(caps.can_order, true, 'and they are still a customer');
  });

  test('an application missing any required field is refused', async () => {
    for (const params of [
      ['TEST-STU-9002', 'Class of 2029', 'ama@example.com', '', 'face.jpg'],
      ['TEST-STU-9002', 'Class of 2029', 'ama@example.com', 'id.jpg', ''],
      ['', 'Class of 2029', 'ama@example.com', 'id.jpg', 'face.jpg'],
      // Declared identity is as required as the photographs: a reviewer uses
      // the cohort to sanity-check the ID, and the address is the only channel
      // that still works when SMS is the thing that has failed.
      ['TEST-STU-9002', '', 'ama@example.com', 'id.jpg', 'face.jpg'],
      ['TEST-STU-9002', 'Class of 2029', '', 'id.jpg', 'face.jpg'],
    ]) {
      const error = await expectRejection(
        asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', params)
      );
      assert.match(error.message, /required/);
    }

    const malformed = await expectRejection(
      asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', [
        'TEST-STU-9002',
        'Class of 2029',
        'not-an-address',
        'id.jpg',
        'face.jpg',
      ])
    );
    assert.match(malformed.message, /does not look like an address/);
  });

  test('the applicant never receives a document path', async () => {
    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', [
      'TEST-STU-9003',
      'Class of 2029',
      'ama@example.com',
      'secret/student-id.jpg',
      'secret/face.jpg',
    ]);
    const view = await application(ACTORS.customerAma);
    const serialised = JSON.stringify(view);
    assert.ok(!serialised.includes('secret/'), 'a storage key is never handed back');
    assert.ok(!('student_id_image_path' in view));
  });

  test('an approved Partner cannot re-apply; a suspended one is told to contact support', async () => {
    const approved = await expectRejection(
      asPartner(ACTORS.partnerYaw, 'select public.partner_apply($1, $2, $3, $4, $5)', [
        'TEST-STU-0031',
        'Class of 2028',
        'yaw@example.com',
        'id.jpg',
        'face.jpg',
      ])
    );
    assert.match(approved.message, /already an approved Partner/);

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [
          ACTORS.partnerAdjoa,
          'SUSPENDED',
          'under investigation',
        ]),
      { commit: true }
    );
    const suspended = await expectRejection(
      asPartner(ACTORS.partnerAdjoa, 'select public.partner_apply($1, $2, $3, $4, $5)', [
        'TEST-STU-0032',
        'Class of 2028',
        'adjoa@example.com',
        'id.jpg',
        'face.jpg',
      ])
    );
    assert.match(suspended.message, /suspended/);
  });

  test('a rejected applicant may apply again, and the old decision is cleared', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3, $4)', [
          ACTORS.applicantKofi,
          'REJECTED',
          'photo unclear',
          'retake it',
        ]),
      { commit: true }
    );

    await asPartner(ACTORS.applicantKofi, 'select public.partner_apply($1, $2, $3, $4, $5)', [
      'TEST-STU-0033',
      'Class of 2027',
      'kofi@example.com',
      'kofi/id2.jpg',
      'kofi/face2.jpg',
    ]);

    const view = await application(ACTORS.applicantKofi);
    assert.equal(view.status, 'PENDING_REVIEW');
    assert.equal(view.reviewed_at, null, 'the previous decision no longer stands');
    assert.equal(view.review_notes, null);
  });

  test('two approved Partners cannot share a student ID number', async () => {
    const error = await expectRejection(
      asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', [
        'TEST-STU-0031',
        'Class of 2029',
        'ama@example.com',
        'id.jpg',
        'face.jpg',
      ])
    );
    assert.match(error.message, /partner_profiles_student_id_unique/);
  });

  test('a suspended account cannot apply at all', async () => {
    await asService((c) =>
      c.query('update public.users set is_suspended = true where id = $1', [ACTORS.customerAma])
    );
    const error = await expectRejection(
      asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2, $3, $4, $5)', [
        'TEST-STU-9004',
        'Class of 2029',
        'ama@example.com',
        'id.jpg',
        'face.jpg',
      ])
    );
    assert.match(error.message, /account suspended/);
  });

  // =========================================================================
  // Availability and eligibility
  // =========================================================================
  test('only approved, available Partners with no active delivery see offers', async () => {
    const order = await orderReadyForDispatch();

    // Approved and online: sees it.
    assert.equal((await offers(ACTORS.partnerYaw)).length, 1);

    // Offline: sees nothing.
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_set_availability(false)'),
      {
        commit: true,
      }
    );
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0);
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_set_availability(true)'),
      {
        commit: true,
      }
    );

    // Pending applicant: sees nothing, and cannot claim.
    assert.equal((await offers(ACTORS.applicantKofi)).length, 0);

    // Carrying a job: sees nothing.
    await accept(ACTORS.partnerYaw, order.order_id);
    const second = await orderReadyForDispatch();
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0);
    assert.ok(second.order_id);
  });

  test('an offer shows everything needed to decide, and nothing about the customer', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    const [offer] = await offers(ACTORS.partnerYaw);

    assert.equal(offer.order_id, order.order_id);
    assert.equal(offer.vendor_name, 'Test Kitchen One');
    assert.equal(offer.destination_zone, 'Hostel Block A');
    assert.equal(offer.earnings_pesewas, 500);
    assert.equal(offer.walk_minutes, 9, 'vendor 4 min + block 5 min');
    assert.equal(offer.food_is_ready, true);

    const serialised = JSON.stringify(offer);
    assert.ok(!serialised.includes('Room 204'), 'the room is not in the offer');
    assert.ok(!serialised.includes('+2332000000'), 'no phone number');
    assert.ok(!('customer_id' in offer));
  });

  test('an unpaid or unready order is never offered', async () => {
    const submitted = await submitOrder();
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0, 'not accepted yet');

    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_accept_order($1)', [
      submitted.order_id,
    ]);
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0, 'accepted but not paid or ready');
  });

  test('a pickup order is never offered to anyone', async () => {
    await orderReadyForDispatch({ fulfilment: 'PICKUP', destination: null });
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0);
  });

  // =========================================================================
  // First valid acceptance wins
  // =========================================================================
  test('three Partners racing for one delivery: exactly one wins', async () => {
    const order = await orderReadyForDispatch();

    const clients = await Promise.all(
      [ACTORS.partnerYaw, ACTORS.partnerAdjoa, ACTORS.partnerEsi].map((id) => dedicatedClient(id))
    );

    try {
      const results = await Promise.all(
        clients.map((client) =>
          client.query('select * from public.partner_accept_delivery($1)', [order.order_id])
        )
      );
      const envelopes = results.map((r) => r.rows[0]);
      const won = envelopes.filter((e) => e.success);
      const lost = envelopes.filter((e) => !e.success);

      assert.equal(won.length, 1, 'exactly one Partner wins');
      assert.equal(lost.length, 2);
      assert.ok(lost.every((e) => /already been taken/.test(e.reason)));
      assert.ok(won[0].pickup_code, 'the winner gets a pickup code');
      assert.ok(
        lost.every((e) => e.pickup_code === null),
        'losers get nothing'
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'ASSIGNED');
    assert.ok(stored.partner_id);

    const rejected = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.order_events where order_id = $1 and event = 'PARTNER_ACCEPT' and not accepted",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(rejected.length, 2, 'both losses are logged');
  });

  test('one active delivery per Partner is enforced by the database itself', async () => {
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, first.order_id);

    const blocked = await accept(ACTORS.partnerYaw, second.order_id);
    assert.equal(blocked.success, false);

    // And directly, bypassing every function.
    const error = await expectRejection(
      asService((c) =>
        c.query(
          `update public.orders set partner_id = $1, delivery_status = 'ASSIGNED', assigned_at = now()
            where id = $2`,
          [ACTORS.partnerYaw, second.order_id]
        )
      )
    );
    assert.match(error.message, /orders_one_active_delivery_per_partner/);
  });

  test('an unapproved or offline Partner cannot claim, even knowing the order id', async () => {
    const order = await orderReadyForDispatch();

    const unapproved = await expectRejection(accept(ACTORS.applicantKofi, order.order_id));
    assert.match(unapproved.message, /not approved/);

    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_set_availability(false)'),
      {
        commit: true,
      }
    );
    const offline = await accept(ACTORS.partnerYaw, order.order_id);
    assert.equal(offline.success, false, 'availability is checked in the claim itself');

    assert.equal((await getOrder(order.order_id)).partner_id, null);
  });

  // =========================================================================
  // The privacy rule
  // =========================================================================
  test('before handoff the Partner sees a zone; after it, the room and the phone', async () => {
    const order = await orderReadyForDispatch({
      customer: ACTORS.customerAma,
      destination: LOCATIONS.room204,
    });
    await accept(ACTORS.partnerYaw, order.order_id);

    const before = await activeDelivery(ACTORS.partnerYaw);
    assert.equal(before.destination_zone, 'Hostel Block A');
    assert.equal(before.destination, null, 'the room is withheld until handoff');
    assert.equal(before.customer_phone, null);
    assert.equal(before.customer_name, null);
    assert.ok(before.vendor_phone, 'but the stall can be called');

    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const after = await activeDelivery(ACTORS.partnerYaw);
    assert.match(after.destination, /Room 204/);
    assert.equal(after.customer_phone, '+233200000021');
    assert.equal(after.customer_name, 'Ama Test-Customer');
  });

  test('the customer phone disappears once the delivery is done', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
      order.order_id,
      secrets.delivery_code,
    ]);

    assert.equal(await activeDelivery(ACTORS.partnerYaw), null, 'no active job');

    const history = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_delivery_history()')).rows
    );
    const serialised = JSON.stringify(history);
    assert.ok(!serialised.includes('+233200000021'), 'not in history either');
    assert.ok(!serialised.includes('Room 204'));

    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(rows.length, 0, 'and RLS closes too');
  });

  test("a Partner cannot see another Partner's active delivery", async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);

    assert.equal(await activeDelivery(ACTORS.partnerAdjoa), null);

    const rows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows
    );
    assert.equal(rows.length, 0);

    const code = await expectRejection(
      asUser(ACTORS.partnerAdjoa, (c) =>
        c.query('select public.get_my_pickup_code($1)', [order.order_id])
      )
    );
    assert.match(code.message, /no pickup code available/);
  });

  // =========================================================================
  // Cancellation and reassignment
  // =========================================================================
  test('a Partner cancels: same order, fresh code, vendor does nothing', async () => {
    const order = await orderReadyForDispatch();
    const claimed = await accept(ACTORS.partnerYaw, order.order_id);
    const oldCode = claimed.pickup_code;
    const orderNumber = claimed.order_number;

    const cancel = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_cancel_delivery($1, $2)',
      [order.order_id, 'something came up']
    );
    assert.equal(cancel.success, true);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.order_number, orderNumber, 'THE SAME ORDER');
    assert.equal(stored.delivery_status, 'SEARCHING');
    assert.equal(stored.partner_id, null);
    assert.equal(stored.order_status, 'READY', 'vendor preparation untouched');
    assert.equal(stored.payment_status, 'PAID', 'payment untouched');

    // The old code is dead immediately.
    const stale = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, oldCode]
    );
    assert.equal(stale.success, false);

    // A second Partner picks it up with a new code.
    const second = await accept(ACTORS.partnerAdjoa, order.order_id);
    assert.equal(second.success, true);
    assert.notEqual(second.pickup_code, oldCode);

    const fresh = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, second.pickup_code]
    );
    assert.equal(fresh.success, true);
  });

  test('a Partner cannot cancel once they are carrying the food', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const cancel = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_cancel_delivery($1, $2)',
      [order.order_id, 'changed my mind']
    );
    assert.equal(cancel.success, false);
    assert.match(cancel.reason, /already collected/);
  });

  test('cancelling frees the Partner to take another job', async () => {
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, first.order_id);
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_cancel_delivery($1, $2)', [
      first.order_id,
      'too far',
    ]);

    const next = await accept(ACTORS.partnerYaw, second.order_id);
    assert.equal(next.success, true);
  });

  // =========================================================================
  // Handoff and completion
  // =========================================================================
  test('the vendor cannot confirm a handoff with a wrong or stale code', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);

    const wrong = await tryTransition(
      ACTORS.vendor1Staff,
      'select public.vendor_confirm_pickup($1, $2)',
      [order.order_id, '0000']
    );
    assert.equal(wrong.success, false);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'ASSIGNED', 'nothing moved');

    const logged = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.order_events where order_id = $1 and event = 'VENDOR_CONFIRM_PICKUP' and not accepted",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(logged.length, 1, 'a bad code attempt is evidence');
  });

  test('a Partner cannot complete a delivery with the wrong code', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    const wrong = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_complete_delivery($1, $2)',
      [order.order_id, '0000']
    );
    assert.equal(wrong.success, false);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'PICKED_UP');
  });

  test('completing the delivery records the earning and completes the order', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);
    const done = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_complete_delivery($1, $2)',
      [order.order_id, secrets.delivery_code]
    );
    assert.equal(done.success, true);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'DELIVERED');
    assert.equal(stored.order_status, 'COMPLETED');

    const earnings = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
    );
    assert.equal(earnings.earned_pesewas, 500);
    assert.equal(earnings.awaiting_pesewas, 500, 'owed, not yet paid out');
  });

  // =========================================================================
  // Customer absence
  // =========================================================================
  test('a Partner cannot claim absence instantly — the wait is enforced by the server', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);

    // Straight to confirming, without reporting: refused.
    const early = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_confirm_customer_absent($1)',
      [order.order_id]
    );
    assert.equal(early.success, false);
    assert.match(early.reason, /report that the customer is not responding first/);

    // Report, then immediately try to close: still refused.
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_report_customer_absent($1)', [
      order.order_id,
    ]);
    const tooSoon = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_confirm_customer_absent($1)',
      [order.order_id]
    );
    assert.equal(tooSoon.success, false);
    assert.match(tooSoon.reason, /keep waiting/);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'PICKED_UP');
  });

  test('after the wait, absence closes the delivery and the Partner still earns', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await tryTransition(ACTORS.vendor1Staff, 'select public.vendor_confirm_pickup($1, $2)', [
      order.order_id,
      secrets.pickup_code,
    ]);
    await tryTransition(ACTORS.partnerYaw, 'select public.partner_report_customer_absent($1)', [
      order.order_id,
    ]);

    // Wind the report back past the waiting period.
    await asService((c) =>
      c.query(
        "update public.orders set customer_absent_reported_at = now() - interval '1 hour' where id = $1",
        [order.order_id]
      )
    );

    const closed = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_confirm_customer_absent($1)',
      [order.order_id]
    );
    assert.equal(closed.success, true);

    const stored = await getOrder(order.order_id);
    assert.equal(stored.delivery_status, 'FAILED_CUSTOMER_ABSENT');
    // The food order is NOT destroyed by a delivery failure.
    assert.equal(stored.order_status, 'READY');
    assert.equal(stored.payment_status, 'PAID');

    const allocations = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.allocations where order_id = $1 and payee_type = 'PARTNER'",
            [order.order_id]
          )
        ).rows
    );
    assert.equal(allocations.length, 1, 'the Partner collected and travelled, so they are paid');
    assert.equal(allocations[0].amount_pesewas, 500);
  });

  test('absence cannot be reported before the food is even collected', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);

    const result = await tryTransition(
      ACTORS.partnerYaw,
      'select public.partner_report_customer_absent($1)',
      [order.order_id]
    );
    assert.equal(result.success, false);
    assert.match(result.reason, /once you are carrying the order/);
  });

  test('a Partner cannot touch a delivery that is not theirs', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);

    for (const [sql, params] of [
      ['select public.partner_cancel_delivery($1, $2)', [order.order_id, 'not mine']],
      ['select public.partner_report_customer_absent($1)', [order.order_id]],
      ['select public.partner_confirm_customer_absent($1)', [order.order_id]],
    ]) {
      const result = await asUser(ACTORS.partnerAdjoa, async (c) => {
        try {
          return { row: (await c.query(sql, params)).rows[0], threw: false };
        } catch (error) {
          return { threw: true, message: error.message };
        }
      });
      // Either it raises, or it returns a failure — never a success.
      if (!result.threw) {
        const envelope = Object.values(result.row)[0];
        const success =
          typeof envelope === 'string' ? envelope.startsWith('(t') : envelope?.success;
        assert.ok(!success, `${sql} must not succeed for another Partner`);
      }
    }

    const complete = await expectRejection(
      asUser(ACTORS.partnerAdjoa, (c) =>
        c.query('select public.partner_complete_delivery($1, $2)', [
          order.order_id,
          secrets.delivery_code,
        ])
      )
    );
    assert.match(complete.message, /not carrying this delivery/);
  });

  // =========================================================================
  // Authorisation
  // =========================================================================
  test('a customer cannot approve themselves or set Partner availability', async () => {
    const availability = await expectRejection(
      asUser(ACTORS.customerAma, (c) => c.query('select public.partner_set_availability(true)'))
    );
    assert.match(availability.message, /not approved/);

    const direct = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query("update public.partner_profiles set status = 'APPROVED' where user_id = $1", [
          ACTORS.customerAma,
        ])
      )
    );
    assert.match(direct.message, /permission denied/i);
  });

  test('anonymous visitors cannot reach any Partner function', async () => {
    for (const sql of [
      'select * from public.get_delivery_offers()',
      'select * from public.partner_active_delivery()',
      'select * from public.my_partner_application()',
    ]) {
      const error = await expectRejection(asAnon((c) => c.query(sql)));
      assert.match(error.message, /permission denied/i);
    }
  });

  test('a Partner cannot read partner_profiles directly for anyone else', async () => {
    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_profiles')).rows
    );
    assert.equal(rows.length, 1, 'only their own row');
    assert.equal(rows[0].user_id, ACTORS.partnerYaw);
  });

  test('a vendor cannot assign or impersonate a Partner', async () => {
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });
    const claim = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select * from public.partner_accept_delivery($1)', [order.order_id])
      )
    );
    assert.match(claim.message, /not approved/);
    assert.equal((await getOrder(order.order_id)).partner_id, null);
  });
});
