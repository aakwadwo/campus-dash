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
  getAllocations,
  submitOrder,
  payOrder,
  vendorReady,
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

  /** The first (or only) active delivery. A Partner may now hold two. */
  const activeDelivery = (userId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0] ?? null
    );

  const activeDeliveries = (userId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
    );

  /**
   * THE HANDOFF, in its new direction: the vendor reads the code out and the
   * PARTNER types it in. Reading it from order_secrets here stands in for
   * "somebody said the number out loud" — no client role can select that table.
   */
  const partnerPickup = async (partnerId, orderId, code = undefined) => {
    const pickupCode = code === undefined ? (await getSecrets(orderId)).pickup_code : code;
    return tryTransition(partnerId, 'select public.partner_confirm_pickup($1, $2)', [
      orderId,
      pickupCode,
    ]);
  };

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
  test('a customer becomes a Partner on the SAME account, adding one document', async () => {
    const before = await application(ACTORS.customerAma);
    assert.equal(before, null, 'no application until they make one');

    // ONE document, and nothing else. Name, student ID number, level and the
    // verified school address are already on the account from customer sign-up
    // — re-collecting them is what would make this look like a second identity.
    // No face photograph either: the school address already established who
    // this is, so a second photograph proved nothing and was dropped.
    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1)', ['ama/student-id.jpg']);

    const after = await application(ACTORS.customerAma);
    assert.equal(after.status, 'PENDING_REVIEW');
    assert.equal(after.is_available, false, 'an applicant is not on shift');
    assert.equal(after.has_documents, true);

    const caps = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.user_id, ACTORS.customerAma, 'the same identity, not a new one');
    assert.equal(caps.is_partner, false, 'applying is not approval');
    assert.equal(caps.can_order, true, 'and they are still a customer');
  });

  test('an application is refused without the student ID', async () => {
    for (const path of ['', '   ', null]) {
      const noId = await expectRejection(
        asPartner(ACTORS.customerAma, 'select public.partner_apply($1)', [path])
      );
      assert.match(noId.message, /photograph of your student ID is required/);
    }
  });

  /**
   * THE AGREEMENT IS RECORDED, not implied by a sentence under a button. It
   * lands in the same transaction as the application, against the published
   * version, so "they agreed" is a row somebody can point at.
   */
  test('applying records the Partner terms acceptance alongside the application', async () => {
    const terms = await asService(
      async (c) =>
        (
          await c.query(
            "select id, version from public.terms_documents where audience = 'PARTNER' and published_at is not null order by version desc limit 1"
          )
        ).rows[0]
    );

    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2)', [
      'ama/student-id.jpg',
      terms.id,
    ]);

    const accepted = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.terms_acceptances where user_id = $1 and audience = 'PARTNER'",
            [ACTORS.customerAma]
          )
        ).rows
    );
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].version, terms.version);
  });

  test('the wrong audience of terms is refused, rather than silently ignored', async () => {
    const customerTerms = await asService(
      async (c) =>
        (
          await c.query(
            "select id from public.terms_documents where audience = 'CUSTOMER' order by version desc limit 1"
          )
        ).rows[0].id
    );

    const error = await expectRejection(
      asPartner(ACTORS.customerAma, 'select public.partner_apply($1, $2)', [
        'ama/student-id.jpg',
        customerTerms,
      ])
    );
    assert.match(error.message, /Partner terms must be accepted/);
    assert.equal(await application(ACTORS.customerAma), null, 'and no application was written');
  });

  test('a new application stores no face photograph', async () => {
    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1)', ['ama/student-id.jpg']);

    const row = await asService(
      async (c) =>
        (
          await c.query(
            'select student_id_image_path, face_image_path from public.partner_profiles where user_id = $1',
            [ACTORS.customerAma]
          )
        ).rows[0]
    );
    assert.equal(row.student_id_image_path, 'ama/student-id.jpg');
    assert.equal(row.face_image_path, null, 'Campus Dash no longer asks for one');
  });

  test('applying without the Customer capability is refused — PARTNER ⇒ CUSTOMER', async () => {
    // The vendor staff account has no student profile. The foreign key
    // partner_requires_customer would refuse the row anyway; this is the check
    // that turns that into a sentence somebody can act on.
    const error = await expectRejection(
      asPartner(ACTORS.vendor1Staff, 'select public.partner_apply($1)', ['student-id.jpg'])
    );
    assert.match(error.message, /finish signing up as a customer/i);

    // And the admin, for the same reason: admin does not imply customer.
    const adminError = await expectRejection(
      asPartner(ACTORS.admin, 'select public.partner_apply($1)', ['student-id.jpg'])
    );
    assert.match(adminError.message, /finish signing up as a customer/i);
  });

  test('the applicant never receives a document path', async () => {
    await asPartner(ACTORS.customerAma, 'select public.partner_apply($1)', [
      'secret/student-id.jpg',
    ]);
    const view = await application(ACTORS.customerAma);
    const serialised = JSON.stringify(view);
    assert.ok(!serialised.includes('secret/'), 'a storage key is never handed back');
    assert.ok(!('face_image_path' in view));
    assert.ok(!('student_id_image_path' in view));
  });

  test('an approved Partner cannot re-apply; a suspended one is told to contact support', async () => {
    const approved = await expectRejection(
      asPartner(ACTORS.partnerYaw, 'select public.partner_apply($1)', ['student-id.jpg'])
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
      asPartner(ACTORS.partnerAdjoa, 'select public.partner_apply($1)', ['student-id.jpg'])
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

    await asPartner(ACTORS.applicantKofi, 'select public.partner_apply($1)', [
      'kofi/student-id2.jpg',
    ]);

    const view = await application(ACTORS.applicantKofi);
    assert.equal(view.status, 'PENDING_REVIEW');
    assert.equal(view.reviewed_at, null, 'the previous decision no longer stands');
    assert.equal(view.review_notes, null);

    // A rejection never took the Customer capability away, and re-applying
    // does not re-grant it — it was never in question.
    const caps = await asUser(
      ACTORS.applicantKofi,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.can_order, true);
  });

  test('a suspended account cannot apply at all', async () => {
    await asService((c) =>
      c.query('update public.users set is_suspended = true where id = $1', [ACTORS.customerAma])
    );
    const error = await expectRejection(
      asPartner(ACTORS.customerAma, 'select public.partner_apply($1)', ['student-id.jpg'])
    );
    assert.match(error.message, /account suspended/);
  });

  // =========================================================================
  // Availability and eligibility
  // =========================================================================
  test('only approved, available Partners below the capacity limit see offers', async () => {
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

    // Carrying ONE job: still sees offers, because the limit is two.
    await accept(ACTORS.partnerYaw, order.order_id);
    const second = await orderReadyForDispatch();
    assert.equal((await offers(ACTORS.partnerYaw)).length, 1, 'one active still leaves room');

    // Carrying TWO: sees nothing, rather than being shown work that would be
    // refused on acceptance.
    await accept(ACTORS.partnerYaw, second.order_id);
    const third = await orderReadyForDispatch();
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0, 'at the limit, nothing is offered');
    assert.ok(third.order_id);
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

  /**
   * PAYMENT IS THE GATE, not READY. The pool opens the moment the money lands,
   * so a Partner can claim a job while the kitchen works — but an order nobody
   * has paid for is not work, and is never offered.
   */
  test('an unpaid order is never offered, and paying is what offers it', async () => {
    const order = await submitOrder();
    assert.equal((await offers(ACTORS.partnerYaw)).length, 0, 'nothing has been paid for');

    await payOrder(order.order_id);

    const open = await offers(ACTORS.partnerYaw);
    const offer = open.find((o) => o.order_id === order.order_id);
    assert.ok(offer, 'paid, so it is work');
    assert.equal(offer.food_is_ready, false, 'and the Partner is told it is not cooked yet');
  });

  test('a collection order is never offered to anybody', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);

    assert.equal((await offers(ACTORS.partnerYaw)).length, 0, 'there is nobody to bring it to');
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
      assert.ok(won[0].order_number, 'the winner is told which order is theirs');
      // NO PICKUP CODE COMES BACK. The claim used to hand one to the Partner;
      // it now belongs to the vendor, who reads it out at the counter.
      assert.ok(!('pickup_code' in won[0]), 'the claim no longer returns a pickup code');
      assert.ok(
        lost.every((e) => e.order_number === null),
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

  test('TWO active deliveries are allowed, and a third is refused', async () => {
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    const third = await orderReadyForDispatch();

    assert.equal((await accept(ACTORS.partnerYaw, first.order_id)).success, true);
    assert.equal(
      (await accept(ACTORS.partnerYaw, second.order_id)).success,
      true,
      'two at once is the point of the change'
    );

    const blocked = await accept(ACTORS.partnerYaw, third.order_id);
    assert.equal(blocked.success, false);
    assert.match(blocked.reason, /2 active deliveries/i);

    const held = await activeDeliveries(ACTORS.partnerYaw);
    assert.equal(held.length, 2);
    assert.deepEqual(
      held.map((d) => d.partner_slot).sort(),
      [1, 2],
      'each occupies its own numbered slot'
    );
    assert.equal((await getOrder(third.order_id)).partner_id, null);
  });

  test('the capacity limit holds at the database level, not just in the function', async () => {
    // Two claimed properly, then a third forced in with a direct UPDATE as the
    // superuser — bypassing partner_accept_delivery entirely. The partial unique
    // index on (partner_id, partner_slot) is what refuses it, which is what
    // makes "at most two" a guarantee rather than a predicate somebody could
    // race past.
    const first = await orderReadyForDispatch();
    const second = await orderReadyForDispatch();
    const third = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, first.order_id);
    await accept(ACTORS.partnerYaw, second.order_id);

    for (const slot of [1, 2]) {
      const error = await expectRejection(
        asService((c) =>
          c.query(
            `update public.orders
                set partner_id = $1, partner_slot = $3,
                    delivery_status = 'ASSIGNED', assigned_at = now()
              where id = $2`,
            [ACTORS.partnerYaw, third.order_id, slot]
          )
        )
      );
      assert.match(error.message, /orders_partner_active_slot_unique/);
    }
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
  test('an unassigned Partner sees a zone; the ASSIGNED one sees the room and the phone', async () => {
    const order = await orderReadyForDispatch({
      customer: ACTORS.customerAma,
      destination: LOCATIONS.room204,
    });

    // BEFORE THE CLAIM: the offer list is what every available Partner sees,
    // and it names a zone and nothing about a person.
    const offered = (await offers(ACTORS.partnerYaw)).find((o) => o.order_id === order.order_id);
    assert.equal(offered.destination_zone, 'Hostel Block A');
    const offerText = JSON.stringify(offered);
    assert.ok(!offerText.includes('Room 204'), 'no room number in a broadcast offer');
    assert.ok(!offerText.includes('+233200000021'), 'and no phone number');

    // AFTER THE CLAIM, and before any handoff: the room and the number, because
    // a Partner who cannot find a door needs to ring before the food is cold.
    await accept(ACTORS.partnerYaw, order.order_id);

    const assigned = await activeDelivery(ACTORS.partnerYaw);
    assert.match(assigned.destination, /Room 204/);
    assert.equal(assigned.customer_phone, '+233200000021');
    assert.equal(assigned.customer_name, 'Ama Test-Customer');
    assert.ok(assigned.vendor_phone, 'and the stall can be called too');

    // The RLS policy on public.users agrees independently of the read model.
    const rows = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(rows.length, 1, 'the policy allows the row while the delivery is live');

    // An UNASSIGNED Partner gets neither, through either route.
    assert.equal(await activeDelivery(ACTORS.partnerAdjoa), null);
    const strangerRows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(strangerRows.length, 0);
  });

  test('the customer phone disappears once the delivery is done', async () => {
    const order = await orderReadyForDispatch({ customer: ACTORS.customerAma });
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);
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

    // And no Partner has a route to the handoff code AT ALL — it is the store's
    // to read out, and vendor_handoff_code() refuses anyone who does not staff
    // the store. Including the Partner who is actually carrying the order.
    const code = await expectRejection(
      asUser(ACTORS.partnerAdjoa, (c) =>
        c.query('select public.vendor_handoff_code($1)', [order.order_id])
      )
    );
    assert.match(code.message, /not authorised for this order/);

    const alsoTheAssignedOne = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select public.vendor_handoff_code($1)', [order.order_id])
      )
    );
    assert.match(alsoTheAssignedOne.message, /not authorised for this order/);
  });

  // =========================================================================
  // Cancellation and reassignment
  // =========================================================================
  test('a Partner cancels: same order, fresh code, vendor does nothing', async () => {
    const order = await orderReadyForDispatch();
    const claimed = await accept(ACTORS.partnerYaw, order.order_id);
    const orderNumber = claimed.order_number;
    // The code lives on the order, not in the claim's answer. Reading it here
    // stands in for the vendor reading it off their own screen.
    const oldCode = (await getSecrets(order.order_id)).pickup_code;

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

    // The old code is dead immediately. Checked from the NEXT Partner's hand,
    // because the one who walked away is no longer authorised to try at all —
    // that refusal is an authorisation failure and raises, which is a different
    // fact from "the number is wrong".

    // A second Partner picks it up, and the vendor's code has rotated.
    const second = await accept(ACTORS.partnerAdjoa, order.order_id);
    assert.equal(second.success, true);
    const newCode = (await getSecrets(order.order_id)).pickup_code;
    assert.notEqual(newCode, oldCode, 'a fresh assignment mints a fresh code');

    const stale = await partnerPickup(ACTORS.partnerAdjoa, order.order_id, oldCode);
    assert.equal(stale.success, false, 'the code from the abandoned assignment is worthless');

    const fresh = await partnerPickup(ACTORS.partnerAdjoa, order.order_id, newCode);
    assert.equal(fresh.success, true);
  });

  test('a Partner cannot cancel once they are carrying the food', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);

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
  test('a Partner cannot confirm a handoff with a wrong or stale code', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);

    const wrong = await partnerPickup(ACTORS.partnerYaw, order.order_id, '0000');
    assert.equal(wrong.success, false);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'ASSIGNED', 'nothing moved');

    const logged = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.order_events where order_id = $1 and event = 'PARTNER_CONFIRM_PICKUP' and not accepted",
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
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);

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
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);
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
  // Completing a delivery: AUTHORISATION and STATE are different failures
  // =========================================================================
  // Hard rule 9 — a transition RAISES for authorisation and returns
  // { success, reason } for state and contention, because a raise rolls back
  // the very log the rejection is supposed to leave behind.
  //
  // partner_complete_delivery() used to fold both into one guard, so the
  // RIGHTFUL Partner re-submitting on an already-DELIVERED order was told they
  // were not carrying a delivery they had just completed — and the replay was
  // never recorded. These pin the two failures apart.
  describe('completing a delivery — state failures are not authorisation failures', () => {
    /** An order carried by partnerYaw and confirmed picked up. */
    async function pickedUpOrder() {
      const order = await orderReadyForDispatch();
      await accept(ACTORS.partnerYaw, order.order_id);
      const secrets = await getSecrets(order.order_id);
      await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);
      return { order, secrets };
    }

    const completionEvents = (orderId) =>
      asService(
        async (c) =>
          (
            await c.query(
              `select accepted, from_state, reason from public.order_events
                where order_id = $1 and event = 'PARTNER_COMPLETE' order by id`,
              [orderId]
            )
          ).rows
      );

    test('A. the rightful Partner with a PICKED_UP order completes it', async () => {
      const { order, secrets } = await pickedUpOrder();
      const done = await tryTransition(
        ACTORS.partnerYaw,
        'select public.partner_complete_delivery($1, $2)',
        [order.order_id, secrets.delivery_code]
      );
      assert.equal(done.success, true);

      const stored = await getOrder(order.order_id);
      assert.equal(stored.delivery_status, 'DELIVERED');
      assert.equal(stored.order_status, 'COMPLETED');
    });

    test('B. the rightful Partner on an already-DELIVERED order gets a SOFT rejection', async () => {
      const { order, secrets } = await pickedUpOrder();
      await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
        order.order_id,
        secrets.delivery_code,
      ]);

      // The replay must NOT raise. tryTransition would throw if it did.
      const replay = await tryTransition(
        ACTORS.partnerYaw,
        'select public.partner_complete_delivery($1, $2)',
        [order.order_id, secrets.delivery_code]
      );
      assert.equal(replay.success, false, 'a state failure, not an authorisation failure');
      assert.match(replay.reason, /not awaiting completion/);

      // And it is LOGGED — the whole point of not raising.
      const events = await completionEvents(order.order_id);
      assert.equal(events.length, 2, 'the success and the replay are both recorded');
      assert.equal(events[0].accepted, true);
      assert.equal(events[1].accepted, false, 'the rejected replay survived in order_events');
      assert.equal(events[1].from_state, 'DELIVERED', 'and records the state it was actually in');
    });

    test('C. a DIFFERENT Partner is refused as an authorisation failure', async () => {
      const { order, secrets } = await pickedUpOrder();
      const error = await expectRejection(
        asUser(ACTORS.partnerAdjoa, (c) =>
          c.query('select public.partner_complete_delivery($1, $2)', [
            order.order_id,
            secrets.delivery_code,
          ])
        )
      );
      assert.match(error.message, /not carrying this delivery/);
      assert.equal(error.code, '42501', 'insufficient_privilege — the security boundary is intact');
      assert.equal((await getOrder(order.order_id)).delivery_status, 'PICKED_UP');
    });

    test('D. a user who is not a Partner at all is refused the same way', async () => {
      const { order, secrets } = await pickedUpOrder();
      for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.admin]) {
        const error = await expectRejection(
          asUser(actor, (c) =>
            c.query('select public.partner_complete_delivery($1, $2)', [
              order.order_id,
              secrets.delivery_code,
            ])
          )
        );
        assert.match(error.message, /not carrying this delivery/);
        assert.equal(error.code, '42501');
      }
      // Nothing leaks: an order id that does not exist is refused identically,
      // so the message cannot be used to probe for real orders.
      const missing = await expectRejection(
        asUser(ACTORS.partnerYaw, (c) =>
          c.query('select public.partner_complete_delivery($1, $2)', [
            '00000000-0000-4000-8000-0000000000ff',
            '1234',
          ])
        )
      );
      assert.match(missing.message, /not carrying this delivery/);
    });

    test('E. a duplicate completion has no second financial or order effect', async () => {
      const { order, secrets } = await pickedUpOrder();
      await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
        order.order_id,
        secrets.delivery_code,
      ]);

      const before = await getOrder(order.order_id);
      const allocationsBefore = await getAllocations(order.order_id);

      await tryTransition(ACTORS.partnerYaw, 'select public.partner_complete_delivery($1, $2)', [
        order.order_id,
        secrets.delivery_code,
      ]);

      const after = await getOrder(order.order_id);
      const allocationsAfter = await getAllocations(order.order_id);

      assert.equal(after.delivery_status, 'DELIVERED');
      assert.equal(after.order_status, 'COMPLETED');
      assert.deepEqual(
        after.delivered_at,
        before.delivered_at,
        'the delivery timestamp is not moved by a replay'
      );
      assert.deepEqual(after.completed_at, before.completed_at);
      assert.deepEqual(
        allocationsAfter,
        allocationsBefore,
        'the Partner is not paid twice for one delivery'
      );
    });
  });

  // =========================================================================
  // Customer absence
  // =========================================================================
  test('a Partner cannot claim absence instantly — the wait is enforced by the server', async () => {
    const order = await orderReadyForDispatch();
    await accept(ACTORS.partnerYaw, order.order_id);
    const secrets = await getSecrets(order.order_id);
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);

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
    await partnerPickup(ACTORS.partnerYaw, order.order_id, secrets.pickup_code);
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

  // =========================================================================
  // Conflict of interest
  // =========================================================================
  // A Partner is approved by hand, and the handoff is proved by two codes: the
  // vendor releases the food against the pickup code, the customer releases the
  // delivery against the delivery code. A Partner who is ALSO the customer, or
  // also the person behind the counter, holds both halves — so a delivery could
  // be recorded, and earned, with nothing having moved. These are the two cases
  // where that is true.

  /**
   * Makes a Partner the OWNER of a vendor. resetTransactionalState() restores
   * the seeded ownership afterwards.
   *
   * The staff join table is gone: ownership is one column on vendors, so
   * "works for this vendor" and "owns this vendor" are now the same question.
   */
  const employ = (userId, vendorId) =>
    asService((c) =>
      c.query('update public.vendors set owner_user_id = $1 where id = $2', [userId, vendorId])
    );

  const acceptEvents = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query(
            "select accepted, reason from public.order_events where order_id = $1 and event = 'PARTNER_ACCEPT' order by created_at",
            [orderId]
          )
        ).rows
    );

  test('a Partner is not offered an order they placed themselves', async () => {
    const own = await orderReadyForDispatch({ customer: ACTORS.partnerYaw });

    const mine = await offers(ACTORS.partnerYaw);
    assert.equal(
      mine.some((o) => o.order_id === own.order_id),
      false,
      'your own order is never an offer'
    );

    // And it is a real offer for everybody else, so the order itself is fine.
    const theirs = await offers(ACTORS.partnerAdjoa);
    assert.equal(
      theirs.some((o) => o.order_id === own.order_id),
      true
    );
  });

  test('a Partner cannot claim an order they placed, even knowing the id', async () => {
    const own = await orderReadyForDispatch({ customer: ACTORS.partnerYaw });

    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select * from public.partner_accept_delivery($1)', [own.order_id])
      )
    );
    assert.match(error.message, /order you placed yourself/i);

    // Refused, and nothing was assigned or logged as an acceptance.
    assert.equal((await getOrder(own.order_id)).partner_id, null);
    assert.equal((await getOrder(own.order_id)).delivery_status, 'SEARCHING');
    assert.deepEqual(await acceptEvents(own.order_id), []);
  });

  test('a Partner is not offered an order from a store they own', async () => {
    // The order is walked to READY first, THEN the store changes hands: the
    // seeded owner is the one who can accept and cook it, and handing the store
    // over beforehand would break the setup rather than the rule under test.
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });
    await employ(ACTORS.partnerYaw, VENDORS.one);

    const mine = await offers(ACTORS.partnerYaw);
    assert.equal(
      mine.some((o) => o.order_id === order.order_id),
      false,
      'not from your own counter'
    );
    const theirs = await offers(ACTORS.partnerAdjoa);
    assert.equal(
      theirs.some((o) => o.order_id === order.order_id),
      true
    );
  });

  test('a Partner cannot claim an order from a store they own', async () => {
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });
    await employ(ACTORS.partnerYaw, VENDORS.one);

    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select * from public.partner_accept_delivery($1)', [order.order_id])
      )
    );
    assert.match(error.message, /store you own/i);

    assert.equal((await getOrder(order.order_id)).partner_id, null);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'SEARCHING');
    assert.deepEqual(await acceptEvents(order.order_id), []);
  });

  test('an unrelated approved Partner still sees and claims the offer', async () => {
    // The negative control. Without it these rules could pass by refusing
    // everybody.
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });

    const seen = await offers(ACTORS.partnerYaw);
    assert.equal(
      seen.some((o) => o.order_id === order.order_id),
      true
    );

    const claim = await accept(ACTORS.partnerYaw, order.order_id);
    assert.equal(claim.success, true);
    // The code is minted on the order for the VENDOR to read out; the claim
    // itself hands the Partner nothing but the job.
    assert.match((await getSecrets(order.order_id)).pickup_code, /^\d{4}$/);
    assert.equal((await getOrder(order.order_id)).partner_id, ACTORS.partnerYaw);
  });

  test('owning one store does not bar you from delivering for another', async () => {
    // The rule is per store, not "a vendor may never deliver".
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });
    await employ(ACTORS.partnerYaw, VENDORS.two);

    const seen = await offers(ACTORS.partnerYaw);
    assert.equal(
      seen.some((o) => o.order_id === order.order_id),
      true
    );

    const claim = await accept(ACTORS.partnerYaw, order.order_id);
    assert.equal(claim.success, true);
    assert.equal((await getOrder(order.order_id)).partner_id, ACTORS.partnerYaw);
  });

  test('not being an approved Partner is still the FIRST thing you are told', async () => {
    // Check order is load-bearing. Someone who is not a Partner at all must
    // hear that, not hear about a conflict they could never have had.
    const order = await orderReadyForDispatch({ vendorId: VENDORS.one });
    await employ(ACTORS.applicantKofi, VENDORS.one);

    const error = await expectRejection(
      asUser(ACTORS.applicantKofi, (c) =>
        c.query('select * from public.partner_accept_delivery($1)', [order.order_id])
      )
    );
    assert.match(error.message, /not approved/, 'approval is checked before conflicts');
    assert.equal((await getOrder(order.order_id)).partner_id, null);
  });

  test('an ordinary lost race is still logged as a rejection, not raised', async () => {
    // The conflict rules raise, which rolls their transaction back and leaves
    // no log — that is what hard rule 9 means by an authorisation failure. The
    // routine path must keep behaving the other way round.
    const order = await orderReadyForDispatch();
    const won = await accept(ACTORS.partnerYaw, order.order_id);
    assert.equal(won.success, true);

    const lost = await accept(ACTORS.partnerAdjoa, order.order_id);
    assert.equal(lost.success, false);

    const events = await acceptEvents(order.order_id);
    assert.equal(events.filter((e) => e.accepted).length, 1);
    const rejected = events.filter((e) => !e.accepted);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason, /already taken or partner ineligible/);
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
