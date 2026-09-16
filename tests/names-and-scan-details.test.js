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
import {
  orderReadyForDispatch,
  partnerAccept,
  partnerConfirmPickup,
  completeDelivery,
  submitScanOrder,
  expectRejection,
} from './helpers/flow.js';

/**
 * First names, and the scan brief.
 *
 * Two changes that turn out to be the same rule twice: give each side of a
 * delivery exactly what they need to find and speak to the other, and nothing
 * more, for exactly as long as the delivery lasts.
 *
 *   The CUSTOMER is told the Partner's first name — "Kwame is on the way" —
 *   and not their surname.
 *
 *   The PARTNER is told the customer's first name, prominently, because it is
 *   what they say when somebody opens the door. The phone number rule is
 *   untouched: assignment to completion, and never afterwards.
 *
 *   The SCAN BRIEF is what the customer wants done, gated on exactly the same
 *   release as the scan image itself.
 */
describe('first names and the scan brief', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  const LIVE = ['ASSIGNED', 'PICKED_UP'];

  function detailFor(customer, orderId) {
    return asUser(
      customer,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [orderId])).rows[0]
    );
  }

  function activeFor(partner) {
    return asUser(
      partner,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
    );
  }

  // =========================================================================
  // The columns
  // =========================================================================

  test('full_name is derived from the parts and cannot drift from them', async () => {
    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.update_my_profile($1, $2)', ['Akosua', 'Boateng']),
      { commit: true }
    );

    const row = await asService(
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows[0]
    );
    assert.equal(row.first_name, 'Akosua');
    assert.equal(row.last_name, 'Boateng');
    assert.equal(row.full_name, 'Akosua Boateng', 'the whole is the parts, always');

    // Even a direct write to full_name is recomputed, so the two can never
    // disagree once the parts are set.
    await asService((c) =>
      c.query("update public.users set full_name = 'Someone Else' where id = $1", [
        ACTORS.customerAma,
      ])
    );
    const after = await asService(
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows[0]
    );
    assert.equal(after.full_name, 'Akosua Boateng');
  });

  test('a first name is required; a last name is not', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.update_my_profile($1, $2)', ['   ', 'Boateng'])
      )
    );
    assert.match(error.message, /first name is required/i);

    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.update_my_profile($1, $2)', ['Akosua', null]),
      { commit: true }
    );
    const row = await asService(
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows[0]
    );
    assert.equal(row.last_name, null);
    assert.equal(row.full_name, 'Akosua', 'a mononym is a name');
  });

  // =========================================================================
  // The phone number, in Settings
  // =========================================================================
  /**
   * A CUSTOMER'S NUMBER IS A PROFILE FIELD — it is what a Partner rings on
   * arrival, and it is theirs to change. A VENDOR'S IS A CREDENTIAL: they sign
   * in with it, so a settings form that could move it would be an account
   * takeover with a text input. Both rules live in SQL.
   */
  test('a customer can change the number a Partner rings', async () => {
    const original = await asService(
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma]))
          .rows[0].phone
    );

    try {
      await asUser(
        ACTORS.customerAma,
        (c) =>
          c.query('select public.update_my_profile($1, $2, $3)', ['Ama', 'Owusu', '+233208887777']),
        { commit: true }
      );

      const row = await asService(
        async (c) =>
          (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows[0]
      );
      assert.equal(row.phone, '+233208887777');
    } finally {
      // The identity table is NOT truncated between tests — it is the seeded
      // cast — so a committed change here would follow every later suite around.
      await asService((c) =>
        c.query('update public.users set phone = $1 where id = $2', [original, ACTORS.customerAma])
      );
    }
  });

  test('leaving the number out leaves it alone, rather than clearing it', async () => {
    const before = await asService(
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma]))
          .rows[0].phone
    );

    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.update_my_profile($1, $2)', ['Ama', 'Owusu']),
      { commit: true }
    );

    const after = await asService(
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerAma]))
          .rows[0].phone
    );
    assert.equal(after, before, 'a name form must not be able to delete a phone number');
  });

  test('a badly shaped number is refused before it reaches the column', async () => {
    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.update_my_profile($1, $2, $3)', ['Ama', 'Owusu', '0201234567'])
      )
    );
    assert.match(error.message, /valid phone number/i);
  });

  test('a number already on another account is refused, and says so', async () => {
    const theirs = await asService(
      async (c) =>
        (await c.query('select phone from public.users where id = $1', [ACTORS.customerKwesi]))
          .rows[0].phone
    );

    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.update_my_profile($1, $2, $3)', ['Ama', 'Owusu', theirs])
      )
    );
    assert.match(error.message, /already used by another Campus Dash account/i);
  });

  test('a store owner cannot move the number they sign in with', async () => {
    const error = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.update_my_profile($1, $2, $3)', ['Kofi', 'Mensah', '+233208886666'])
      )
    );
    assert.match(error.message, /how you sign in/i);

    // And their name still changes, because that is not a credential.
    await asUser(
      ACTORS.vendor1Staff,
      (c) => c.query('select public.update_my_profile($1, $2)', ['Kofi', 'Mensah']),
      { commit: true }
    );
    const row = await asService(
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.vendor1Staff])).rows[0]
    );
    assert.equal(row.first_name, 'Kofi');
  });

  test('capabilities carry the parts as well as the whole', async () => {
    const caps = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.first_name, 'Ama');
    assert.equal(caps.last_name, 'Test-Customer');
    assert.equal(caps.full_name, 'Ama Test-Customer');
  });

  test('an account with only a legacy full_name still yields a first name', async () => {
    // Accounts created before the split have no parts. given_name() falls back
    // to the first word rather than showing nothing.
    await asService((c) =>
      c.query(
        `update public.users set first_name = null, last_name = null, full_name = 'Yaw Test-Partner'
          where id = $1`,
        [ACTORS.partnerYaw]
      )
    );
    const name = await asService(
      async (c) =>
        (
          await c.query(
            'select public.given_name(first_name, full_name) as n from public.users where id = $1',
            [ACTORS.partnerYaw]
          )
        ).rows[0].n
    );
    assert.equal(name, 'Yaw');
  });

  // =========================================================================
  // What each side is told
  // =========================================================================

  test('the customer is told the Partner’s first name, and not their surname', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const detail = await detailFor(ACTORS.customerAma, order.order_id);
    assert.equal(detail.partner_name, 'Yaw', 'a person, not a database row');
    assert.ok(!JSON.stringify(detail).includes('Test-Partner'), 'the surname never travels');
    assert.ok(detail.partner_phone, 'the number is there while they are carrying it');
  });

  /**
   * THE NUMBER STOPS. THE FIRST NAME DOES NOT.
   *
   * Both used to end with the delivery, which meant the rating prompt said
   * "your Partner" and the order history named nobody — rating somebody became
   * an oddly anonymous act, and a customer could not say who had brought their
   * lunch an hour later. A first name is what one person tells another about
   * another, and hard rule 19 has always allowed it in both directions.
   *
   * The PHONE NUMBER is the thing the window was really protecting, and its
   * window is unchanged: assignment until the delivery ends, never afterwards,
   * never in an SMS. Hard rule 14.
   */
  test('the Partner’s number stops when the delivery does, and their first name stays', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const detail = await detailFor(ACTORS.customerAma, order.order_id);
    assert.equal(detail.delivery_status, 'DELIVERED');
    assert.equal(detail.partner_name, 'Yaw', 'the customer can still say who brought it');
    assert.equal(detail.partner_phone, null, 'the number is over with the delivery');
    assert.equal(detail.delivery_code, null, 'and the code has no further use');

    // A SURNAME IS NEVER RETURNED, at any point. given_name() is what the
    // column holds, so widening this would take a deliberate change.
    assert.doesNotMatch(JSON.stringify(detail), /Test-Partner/);
  });

  test('the Partner sees the customer’s first name for as long as they carry it', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    let [job] = await activeFor(ACTORS.partnerYaw);
    assert.equal(job.customer_first_name, 'Ama');
    assert.ok(job.customer_phone, 'and the number, from assignment');
    assert.ok(LIVE.includes(job.delivery_status));

    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw);
    [job] = await activeFor(ACTORS.partnerYaw);
    assert.equal(job.customer_first_name, 'Ama', 'still theirs on the second leg');

    await completeDelivery(order.order_id, ACTORS.partnerYaw);
    const after = await activeFor(ACTORS.partnerYaw);
    assert.deepEqual(after, [], 'and nothing afterwards');
  });

  test('a Partner who is not assigned learns neither name nor number', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const adjoa = await activeFor(ACTORS.partnerAdjoa);
    assert.deepEqual(adjoa, []);

    // And the offer board, which every available Partner can see, carries no
    // identity at all.
    const offers = await asUser(
      ACTORS.partnerAdjoa,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    for (const offer of offers) {
      const serialised = JSON.stringify(offer);
      assert.ok(!serialised.includes('Ama'), 'no customer name on a broadcast offer');
      assert.ok(!/\+233\d/.test(serialised), 'and no phone number');
    }
  });

  test('a Partner cannot read the customer row outside the delivery window', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const during = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.equal(during.length, 1, 'the RLS policy allows it while the delivery is live');

    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const after = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.users where id = $1', [ACTORS.customerAma])).rows
    );
    assert.deepEqual(after, [], 'and refuses it the moment the delivery ends');
  });

  // =========================================================================
  // The scan brief
  // =========================================================================

  async function submitScan({
    customer = ACTORS.customerAma,
    details = 'Jollof with chicken from the hot counter. Fish is fine if it has run out.',
  } = {}) {
    return submitScanOrder({ customer, vendorId: VENDORS.wafflemania, details });
  }

  /**
   * THE NOTE IS OPTIONAL NOW, and that is a consequence of the items being
   * real. It used to be the only way anybody knew what to collect, so it had to
   * be compulsory and a blank one was refused. The order itself says what was
   * asked for; what is left is genuinely optional context.
   */
  test('a scan order without a note is accepted', async () => {
    for (const details of ['', '   ', null]) {
      const order = await submitScan({ details });
      assert.ok(order.order_id, 'a blank note is not a reason to refuse an order');
    }
  });

  test('the details are stored, and the customer can read their own back', async () => {
    const order = await submitScan();

    const mine = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select * from public.my_scan_order($1)', [order.order_id])).rows[0]
    );
    assert.match(mine.details, /Jollof with chicken/);

    const notMine = await asUser(
      ACTORS.customerKwesi,
      async (c) => (await c.query('select * from public.my_scan_order($1)', [order.order_id])).rows
    );
    assert.deepEqual(notMine, [], 'somebody else’s errand tells them nothing');
  });

  test('the brief opens on assignment and closes when the delivery ends', async () => {
    const order = await submitScan();

    // Unpaid and unassigned: nobody may read it.
    const before = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_scan_brief($1)', [order.order_id])).rows
    );
    assert.deepEqual(before, []);

    await asService(async (c) => {
      const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        order.order_id,
        `scan:${order.order_id}`,
      ]);
      await c.query('select public.confirm_payment($1, $2, $3)', [
        rows[0].id,
        `fake_txn_${rows[0].id}`,
        rows[0].amount_pesewas,
      ]);
    });

    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const during = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_scan_brief($1)', [order.order_id])).rows[0]
    );
    assert.match(during.details, /Jollof with chicken/, 'the assigned Partner is told what to ask');
    assert.equal(during.restaurant_name, 'Wafflemania (test)');
    // AND WHAT THE ORDER ACTUALLY IS. The note is context; the items are the
    // order, and a Partner who has both does not have to ring anybody.
    assert.equal(during.items.length, 1);

    // An unassigned Partner gets nothing, at the same moment.
    const otherPartner = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (await c.query('select * from public.partner_scan_brief($1)', [order.order_id])).rows
    );
    assert.deepEqual(otherPartner, []);

    // And when the assignment goes away, so does the brief.
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_cancel_delivery($1, $2)', [order.order_id, 'gave up']),
      { commit: true }
    );
    const after = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.partner_scan_brief($1)', [order.order_id])).rows
    );
    assert.deepEqual(after, [], 'losing the assignment revokes the brief, not just the image');
  });

  test('an administrator sees the details on the errand', async () => {
    const order = await submitScan();
    const view = await asUser(
      ACTORS.admin,
      async (c) =>
        (await c.query('select * from public.admin_scan_order($1)', [order.order_id])).rows[0]
    );
    assert.match(view.details, /Jollof with chicken/);
  });

  test('details longer than the column allows are refused', async () => {
    const error = await expectRejection(submitScan({ details: 'x'.repeat(1001) }));
    assert.match(error.message, /under 1000 characters/i);
  });
});
