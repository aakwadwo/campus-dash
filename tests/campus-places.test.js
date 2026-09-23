import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  submitScanOrder,
  payOrder,
  vendorReady,
  vendorRedeemScan,
  partnerAccept,
  chooseFulfilment,
  tryTransition,
  getOrder,
  expectRejection,
} from './helpers/flow.js';

/**
 * WHERE, AS PRECISELY AS THE CUSTOMER CHOSE, AND NO MORE.
 *
 * The real Academic City tree is reference data from a migration, so these
 * tests use the names a student would. A floor is a complete destination, a
 * room is optional, and what an order stores is exactly what was chosen.
 *
 * Plus the two optional notes an order carries, each for one reader, and the
 * read that tells a store when Paystack will pay it.
 */
after(async () => {
  await resetTransactionalState();
  await closePools();
});

const place = async (label) => {
  const rows = await asAnon(
    async (c) =>
      (await c.query('select * from public.destination_places() where label = $1', [label])).rows
  );
  assert.equal(rows.length, 1, `exactly one place is labelled "${label}"`);
  return rows[0];
};

const customerView = (orderId, customer = ACTORS.customerAma) =>
  asUser(
    customer,
    async (c) =>
      (await c.query('select * from public.customer_order_detail($1)', [orderId])).rows[0] ?? null
  );

const vendorView = (orderId, staff = ACTORS.vendor1Staff) =>
  asUser(
    staff,
    async (c) =>
      (await c.query('select * from public.vendor_order_detail($1)', [orderId])).rows[0] ?? null
  );

describe('the campus, as students name it', () => {
  before(resetTransactionalState);

  test('every place from the brief exists, reads naturally, and can be chosen', async () => {
    for (const label of [
      'Hostel A Entrance',
      'Hostel A · C Floor',
      'Hostel A · C Floor · C17',
      'Hostel B · D Floor · D32',
      'Academic Block · First Floor',
      'Academic Block · First Floor · Library',
      'Academic Block · Second Floor · Math Center',
      'Administrative Block · Ground Floor',
      'Administrative Block · First Floor · Reception/Lounge',
      'Football Field',
      'Rec Center Down',
      'Wafflemania',
      'Hostel Car Park',
    ]) {
      const row = await place(label);
      assert.equal(row.is_deliverable, true, label);
    }
  });

  test('the recognisable places are navigational, not destinations', async () => {
    const rows = await asAnon(
      async (c) => (await c.query('select * from public.destination_places()')).rows
    );
    const top = ['Academic Block', 'Administrative Block', 'Hostel A', 'Hostel B'];
    for (const name of top) {
      const row = rows.find((r) => r.name === name && r.kind === 'BLOCK');
      assert.ok(row, name);
      assert.equal(row.is_deliverable, false, `${name} is opened, not chosen`);
    }
    // 32 rooms on each of four floors in two hostels.
    const hostelRooms = rows.filter((r) => /^Hostel [AB] · [A-D] Floor · [A-D]\d+$/.test(r.label));
    assert.equal(hostelRooms.length, 256);
  });

  test('no place is invented: nothing called "Other" or "unspecified"', async () => {
    const rows = await asAnon(
      async (c) => (await c.query('select name from public.destination_places()')).rows
    );
    assert.ok(!rows.some((r) => /other|unspecified/i.test(r.name)));
  });
});

describe('an order keeps the precision the customer chose', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  for (const label of [
    'Hostel A Entrance',
    'Hostel A · C Floor',
    'Hostel A · C Floor · C17',
    'Academic Block · First Floor',
    'Administrative Block · Ground Floor',
    'Football Field',
  ]) {
    test(`to "${label}"`, async () => {
      const destination = (await place(label)).location_id;
      const order = await submitOrder({ destination });
      const view = await customerView(order.order_id);
      assert.equal(view.destination, label, 'no room fabricated, none dropped');
    });
  }

  test('a Partner is offered the building and floor, and the room only once assigned', async () => {
    const destination = (await place('Hostel A · C Floor · C17')).location_id;
    const order = await submitOrder({ destination });
    await payOrder(order.order_id);

    const offer = await asUser(ACTORS.partnerYaw, async (c) =>
      (await c.query('select * from public.get_delivery_offers()')).rows.find(
        (o) => o.order_id === order.order_id
      )
    );
    assert.equal(offer.destination_zone, 'Hostel A');
    assert.equal(offer.destination_floor, 'C Floor');
    assert.doesNotMatch(JSON.stringify(offer), /C17/, 'never the room on a broadcast offer');

    await partnerAccept(order.order_id);
    const [job] = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
    );
    assert.equal(job.destination, 'Hostel A · C Floor · C17');
    assert.ok(job.customer_phone, 'the existing contact path: the number, from assignment');
  });

  test('the destination is fixed once the order is paid', async () => {
    const entrance = (await place('Hostel A Entrance')).location_id;
    const elsewhere = (await place('Football Field')).location_id;
    const order = await submitOrder({ destination: entrance });
    await payOrder(order.order_id);

    const result = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_choose_fulfilment($1, $2, $3, $4)',
      [order.order_id, 'DELIVERY', elsewhere, null]
    );
    assert.equal(result.success, false, 'no location change after payment');

    const stored = await getOrder(order.order_id);
    assert.equal(stored.destination_location_id, entrance, 'where they said they would be');
  });

  test('before payment, the destination can still be changed', async () => {
    const entrance = (await place('Hostel A Entrance')).location_id;
    const floor = (await place('Hostel B · A Floor')).location_id;
    const order = await submitOrder({ destination: entrance });
    await chooseFulfilment(order.order_id, { destination: floor });
    assert.equal((await getOrder(order.order_id)).destination_location_id, floor);
  });

  test('a navigational place is refused as a destination', async () => {
    const hostel = (
      await asAnon(
        async (c) =>
          (
            await c.query(
              "select * from public.destination_places() where name = 'Hostel A' and kind = 'BLOCK'"
            )
          ).rows[0]
      )
    ).location_id;
    const error = await expectRejection(submitOrder({ destination: hostel }));
    assert.match(error.message, /not a valid delivery location/);
  });
});

describe('order information for the store, additional information for the Partner', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  const partnerJob = async () =>
    (
      await asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.partner_active_delivery()')).rows
      )
    )[0] ?? null;

  test('order information exists before payment and reaches the store with the order', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', orderNote: 'No pepper, please.' });

    // Written by the submission itself, so it is there while the order is
    // still unpaid — nothing is saved after the payment.
    const [row] = await asService(
      async (c) =>
        (await c.query('select body from public.order_notes where order_id = $1', [order.order_id]))
          .rows
    );
    assert.equal(row.body, 'No pepper, please.');
    assert.equal(await vendorView(order.order_id), null, 'no store sees an unpaid order');

    await payOrder(order.order_id);
    assert.equal((await vendorView(order.order_id)).order_information, 'No pepper, please.');
    assert.equal((await customerView(order.order_id)).order_information, 'No pepper, please.');
  });

  test('a collection keeps no Partner note, and needs none', async () => {
    const order = await submitOrder({
      fulfilment: 'PICKUP',
      orderNote: 'No salad.',
      note: 'Call when you arrive.',
    });
    assert.equal((await getOrder(order.order_id)).destination_note, null);
  });

  test('a Partner order: the store reads the food note, the Partner reads theirs', async () => {
    const destination = (await place('Hostel A · C Floor · C17')).location_id;
    const order = await submitOrder({
      destination,
      orderNote: 'Bigger chicken if available.',
      note: "I'm near the stairs. Please call when you arrive.",
    });
    await payOrder(order.order_id);

    const detail = await vendorView(order.order_id);
    assert.equal(detail.order_information, 'Bigger chicken if available.');
    // NEITHER THE PARTNER'S NOTE NOR THE PLACE IS THE STORE'S.
    assert.doesNotMatch(JSON.stringify(detail), /stairs|C17|C Floor|Hostel A/);

    await vendorReady(order.order_id);
    await partnerAccept(order.order_id);
    const job = await partnerJob();
    assert.equal(job.destination, 'Hostel A · C Floor · C17');
    assert.equal(job.destination_note, "I'm near the stairs. Please call when you arrive.");
    assert.doesNotMatch(JSON.stringify(job), /chicken/, "the food note is not the Partner's");

    // Not through the table either: the assigned Partner can read their
    // order's row, and the food note is not on it.
    const direct = await asUser(ACTORS.partnerYaw, async (c) => ({
      order: (await c.query('select * from public.orders where id = $1', [order.order_id])).rows[0],
      notes: (await c.query('select * from public.order_notes')).rows,
    }));
    assert.ok(direct.order, 'the Partner does read their order');
    assert.doesNotMatch(JSON.stringify(direct.order), /chicken/);
    assert.deepEqual(direct.notes, []);

    // The customer sees both, and the place, each separately.
    const mine = await customerView(order.order_id);
    assert.equal(mine.order_information, 'Bigger chicken if available.');
    assert.equal(mine.destination_note, "I'm near the stairs. Please call when you arrive.");
    assert.equal(mine.destination, 'Hostel A · C Floor · C17');
  });

  test('a Meal Scan order carries both the same way, collected or carried', async () => {
    const pickup = await submitScanOrder({
      fulfilment: 'PICKUP',
      orderNote: 'Extra napkins.',
      note: 'ignored on a collection',
    });
    await payOrder(pickup.order_id);
    const detail = await vendorView(pickup.order_id, ACTORS.wafflemaniaStaff);
    assert.equal(detail.order_information, 'Extra napkins.');
    assert.equal((await getOrder(pickup.order_id)).destination_note, null);

    const destination = (await place('Hostel B Entrance')).location_id;
    const carried = await submitScanOrder({
      destination,
      orderNote: 'No pepper.',
      note: 'Call when you arrive.',
    });
    await payOrder(carried.order_id);
    const carriedDetail = await vendorView(carried.order_id, ACTORS.wafflemaniaStaff);
    assert.equal(carriedDetail.order_information, 'No pepper.');
    assert.doesNotMatch(JSON.stringify(carriedDetail), /Call when you arrive/);
    assert.equal((await getOrder(carried.order_id)).destination_note, 'Call when you arrive.');
  });

  test('nobody else can read either', async () => {
    const destination = (await place('Hostel A Entrance')).location_id;
    const order = await submitOrder({
      destination,
      orderNote: 'No onions.',
      note: 'Leave it with reception.',
    });
    await payOrder(order.order_id);

    assert.equal(await vendorView(order.order_id, ACTORS.vendor2Staff), null, 'another store');
    assert.equal(
      await customerView(order.order_id, ACTORS.customerKwesi),
      null,
      'another customer'
    );
    const theirs = await asUser(ACTORS.customerKwesi, async (c) => ({
      notes: (await c.query('select * from public.order_notes')).rows,
      orders: (await c.query('select * from public.orders where id = $1', [order.order_id])).rows,
    }));
    assert.deepEqual(theirs, { notes: [], orders: [] });

    const offered = await asUser(ACTORS.partnerYaw, async (c) =>
      JSON.stringify((await c.query('select * from public.get_delivery_offers()')).rows)
    );
    assert.doesNotMatch(offered, /reception|onions/, 'never on an offer');

    const anon = await expectRejection(asAnon((c) => c.query('select * from public.order_notes')));
    assert.match(anon.message, /permission denied/);
  });

  test('switching to collection before paying keeps the Partner note', async () => {
    const destination = (await place('Hostel A Entrance')).location_id;
    const order = await submitOrder({ destination, note: 'Black shirt.' });
    await chooseFulfilment(order.order_id, { fulfilment: 'PICKUP' });
    assert.equal((await getOrder(order.order_id)).destination_note, 'Black shirt.');
  });

  test('both are bounded at 280 characters', async () => {
    const food = await expectRejection(
      submitOrder({ fulfilment: 'PICKUP', orderNote: 'x'.repeat(281) })
    );
    assert.match(food.message, /order information under 280/);
    const partner = await expectRejection(submitOrder({ note: 'x'.repeat(281) }));
    assert.match(partner.message, /additional information under 280/);

    const ok = await submitOrder({ orderNote: 'x'.repeat(280), note: 'y'.repeat(280) });
    assert.ok(ok.order_id);
  });

  test('empty means absent', async () => {
    const order = await submitOrder({ orderNote: '   ', note: '  ' });
    assert.equal((await getOrder(order.order_id)).destination_note, null);
    const rows = await asService(
      async (c) =>
        (await c.query('select 1 from public.order_notes where order_id = $1', [order.order_id]))
          .rows
    );
    assert.deepEqual(rows, []);
  });
});

describe("when a store's split money arrives", () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  async function giveVendorASubaccount() {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_set_payout_destination($1,$2,$3,$4,$5,$6)', [
          'VENDOR',
          VENDORS.one,
          'MTN',
          '0551234567',
          'Muni Kitchen',
          'pilot setup',
        ]),
      { commit: true }
    );
    await asService((c) =>
      c.query('select public.attach_payout_subaccount($1,$2,$3,$4,$5)', [
        'VENDOR',
        VENDORS.one,
        'paystack',
        'ACCT_muni_test',
        null,
      ])
    );
  }

  async function payWithSplit(orderId) {
    return asService(async (c) => {
      const payment = (
        await c.query("select * from public.create_payment_intent($1, 'paystack', $2)", [
          orderId,
          `split:${orderId}`,
        ])
      ).rows[0];
      const { subtotal_pesewas } = (
        await c.query('select subtotal_pesewas from public.orders where id = $1', [orderId])
      ).rows[0];
      await c.query('select public.attach_payment_split($1, $2, $3)', [
        payment.id,
        'ACCT_muni_test',
        Number(subtotal_pesewas),
      ]);
      await c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        `ps_txn_${payment.id}`,
        payment.amount_pesewas,
      ]);
    });
  }

  const payoutDays = (staff = ACTORS.vendor1Staff) =>
    asUser(
      staff,
      async (c) =>
        (await c.query('select * from public.vendor_payout_days($1)', [VENDORS.one])).rows
    );

  test('split money is reported by the Ghana day it was paid, and writes nothing', async () => {
    await giveVendorASubaccount();
    const first = await submitOrder({ fulfilment: 'PICKUP' });
    const second = await submitOrder({ fulfilment: 'PICKUP' });
    await payWithSplit(first.order_id);
    await payWithSplit(second.order_id);

    const before = await asService(
      async (c) =>
        (
          await c.query(
            'select (select count(*) from public.payouts) p, (select count(*) from public.settlement_runs) r'
          )
        ).rows[0]
    );
    const rows = await payoutDays();
    const after = await asService(
      async (c) =>
        (
          await c.query(
            'select (select count(*) from public.payouts) p, (select count(*) from public.settlement_runs) r'
          )
        ).rows[0]
    );

    const today = await asService(
      async (c) =>
        (await c.query("select (now() at time zone 'Africa/Accra')::date::text d")).rows[0].d
    );
    const split = rows.filter((r) => r.settlement_channel === 'SPLIT');
    assert.equal(split.length, 1, 'one day');
    assert.equal(new Date(split[0].paid_day).toISOString().slice(0, 10), today);
    const subtotal = Number((await getOrder(first.order_id)).subtotal_pesewas) * 2;
    assert.equal(Number(split[0].amount_pesewas), subtotal, "the store's own money, both orders");
    assert.deepEqual(after, before, 'a read, not a settlement');
  });

  test('money with no subaccount is reported as owed through the ledger', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await payOrder(order.order_id);
    const rows = await payoutDays();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].settlement_channel, 'TRANSFER');
  });

  test("another store, a customer and a visitor cannot read a store's money", async () => {
    await giveVendorASubaccount();
    const order = await submitOrder({ fulfilment: 'PICKUP' });
    await payWithSplit(order.order_id);

    assert.deepEqual(await payoutDays(ACTORS.vendor2Staff), []);
    assert.deepEqual(await payoutDays(ACTORS.customerAma), []);
    await expectRejection(
      asAnon((c) => c.query('select * from public.vendor_payout_days($1)', [VENDORS.one]))
    );
  });
});

describe('the checkout', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  test('asks for two notes, each for one reader, and never for a free-form place', () => {
    const source = read('app/order/[vendorId]/menu-and-basket.js');
    assert.match(source, /label="Order information"/);
    assert.match(source, /label="Additional information"/);
    assert.match(source, /name="order_note"/);
    assert.match(source, /name="destination_note"/);
    assert.doesNotMatch(source, /Other location|location information/i);
    // Order information before the choice, so every order is asked; Additional
    // information after the place, inside the Partner-only block.
    const picker = source.indexOf('<DestinationPicker');
    assert.ok(source.indexOf('label="Order information"') < source.indexOf('<FulfilmentChoice'));
    assert.ok(source.indexOf('label="Additional information"') > picker);
  });

  test('the picker opens a hostel on its entrance', () => {
    const source = read('app/destination-picker.js');
    assert.match(source, /COMMON_AREA/);
    assert.match(source, /Room \(optional\)/);
  });
});
