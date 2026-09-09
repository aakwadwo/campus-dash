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

  test('the Partner’s name and number both stop when the delivery does', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const detail = await detailFor(ACTORS.customerAma, order.order_id);
    assert.equal(detail.delivery_status, 'DELIVERED');
    assert.equal(detail.partner_name, null, 'the delivery is over');
    assert.equal(detail.partner_phone, null);
    assert.equal(detail.delivery_code, null, 'and the code has no further use');
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
    return asUser(
      customer,
      async (c) =>
        (
          await c.query('select * from public.submit_scan_order($1,$2,$3,$4,$5,$6,$7)', [
            VENDORS.wafflemania,
            LOCATIONS.room204,
            `${customer}/scans/scan-1.jpg`,
            'image/jpeg',
            120000,
            details,
            null,
          ])
        ).rows[0],
      { commit: true }
    );
  }

  test('an errand without details is refused', async () => {
    for (const details of ['', '   ', null]) {
      const error = await expectRejection(submitScan({ details }));
      assert.match(error.message, /tell us what you want/i);
    }

    const orders = await asService(
      async (c) =>
        (await c.query("select count(*)::int as n from public.orders where order_type = 'SCAN'"))
          .rows[0].n
    );
    assert.equal(orders, 0, 'and no half-created errand is left behind');
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
