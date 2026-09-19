// Pins the service-role client at the local stack before anything reads config.
import './helpers/local-supabase.js';

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PaystackPaymentProvider, MOMO_BANK_CODE } from '../lib/payments/paystack.js';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
} from './helpers/db.js';
import {
  acceptedOrder,
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
  getAllocations,
  submitScanOrder,
  expectRejection,
} from './helpers/flow.js';

/**
 * Paystack subaccounts and split settlement.
 *
 * WHAT PAYSTACK ACTUALLY SUPPORTS, and therefore what is implemented:
 *
 *   * a SUBACCOUNT is a settlement destination, created once from a Ghana
 *     mobile money network and number;
 *   * a DYNAMIC SPLIT is a `split` object passed inline on
 *     /transaction/initialize, so one charge can be divided without registering
 *     a split group first;
 *   * `type: 'flat'` shares are amounts in the minor unit, which for GHS is the
 *     pesewa — the unit this codebase already uses, so nothing is converted;
 *   * `bearer_type: 'account'` leaves Paystack's fee with us.
 *
 * WHAT IT CANNOT DO, and why the Partner is absent from every split below: the
 * split is fixed when the charge is created, and at that moment NO PARTNER
 * EXISTS — the food is not cooked, dispatch has not opened, and there is nobody
 * to name. Their GH₵5 is carved out of the platform allocation when they
 * actually complete the delivery and settled by the existing transfer path.
 */

const SECRET = 'sk_test_stub_key_for_split_tests_only';

function stubFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

function providerWith(fetchImpl) {
  return new PaystackPaymentProvider({
    secretKey: SECRET,
    apiUrl: 'https://api.paystack.test',
    fetchImpl,
  });
}

const INITIALISED = {
  body: {
    status: true,
    data: { reference: 'ref-1', authorization_url: 'https://checkout.paystack.test/x' },
  },
};

// ===========================================================================
// The adapter
// ===========================================================================

describe('Paystack subaccounts', () => {
  test('a Ghana mobile money account becomes a subaccount', async () => {
    const fetchImpl = stubFetch({
      body: { status: true, data: { subaccount_code: 'ACCT_abc123', business_name: 'Muni' } },
    });
    const provider = providerWith(fetchImpl);

    const result = await provider.ensureSubaccount({
      businessName: 'Muni Kitchen',
      momoNetwork: 'MTN',
      accountNumber: '0551234567',
      contactEmail: 'muni@example.com',
    });

    assert.equal(result.subaccountCode, 'ACCT_abc123');

    const [call] = fetchImpl.calls;
    assert.match(call.url, /\/subaccount$/);
    assert.equal(call.body.settlement_bank, MOMO_BANK_CODE.MTN);
    assert.equal(call.body.account_number, '0551234567');
    assert.equal(call.body.business_name, 'Muni Kitchen');
    assert.equal(call.body.primary_contact_email, 'muni@example.com');
  });

  test('percentage_charge is zero, so a missing split keeps the money with us', async () => {
    // THE FAIL-SAFE. percentage_charge is the default share Paystack applies
    // when a transaction names this subaccount with no explicit split. Campus
    // Dash always sends one — but if it ever did not, 0 leaves the money in our
    // balance where it can still be sent on. A default of 100 would send the
    // whole charge, service fee and delivery fee included, and Paystack cannot
    // pull that back.
    const fetchImpl = stubFetch({
      body: { status: true, data: { subaccount_code: 'ACCT_abc123' } },
    });
    await providerWith(fetchImpl).ensureSubaccount({
      businessName: 'Muni',
      momoNetwork: 'MTN',
      accountNumber: '0551234567',
    });
    assert.equal(fetchImpl.calls[0].body.percentage_charge, 0);
  });

  test('an unsupported network is refused before any request is made', async () => {
    const fetchImpl = stubFetch({ body: { status: true, data: {} } });
    await assert.rejects(
      () =>
        providerWith(fetchImpl).ensureSubaccount({
          businessName: 'Muni',
          momoNetwork: 'GLO',
          accountNumber: '0551234567',
        }),
      /unsupported mobile money network/
    );
    assert.equal(fetchImpl.calls.length, 0, 'nothing was sent');
  });

  test('a Paystack refusal is reported, not swallowed', async () => {
    const fetchImpl = stubFetch({
      ok: false,
      status: 400,
      body: { status: false, message: 'Account number is invalid' },
    });
    await assert.rejects(
      () =>
        providerWith(fetchImpl).ensureSubaccount({
          businessName: 'Muni',
          momoNetwork: 'MTN',
          accountNumber: '0000000000',
        }),
      /Account number is invalid/
    );
  });
});

describe('Paystack dynamic splits', () => {
  test('a split is flat, in pesewas, with the fee on the main account', async () => {
    const fetchImpl = stubFetch(INITIALISED);
    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k1',
      amountPesewas: 4200,
      currency: 'GHS',
      customerEmail: 'ama@acity.edu.gh',
      reference: 'ref-1',
      split: { subaccountCode: 'ACCT_vendor', sharePesewas: 3500 },
    });

    assert.equal(result.splitApplied, true);

    const { split } = fetchImpl.calls[0].body;
    assert.equal(split.type, 'flat', 'the vendor is owed an amount, not a proportion');
    assert.equal(split.currency, 'GHS');
    assert.equal(split.bearer_type, 'account', 'Campus Dash absorbs the processing fee');
    assert.deepEqual(split.subaccounts, [{ subaccount: 'ACCT_vendor', share: 3500 }]);
    // The share crosses the boundary unscaled: Paystack's minor unit for GHS IS
    // the pesewa.
    assert.equal(fetchImpl.calls[0].body.amount, 4200);
  });

  test('no split object is sent when there is nothing to split', async () => {
    const fetchImpl = stubFetch(INITIALISED);
    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k1',
      amountPesewas: 700,
      customerEmail: 'ama@acity.edu.gh',
      reference: 'ref-1',
      split: null,
    });
    assert.equal(result.splitApplied, false);
    assert.equal('split' in fetchImpl.calls[0].body, false);
  });

  test('a zero share is not a split, and is not sent', async () => {
    const fetchImpl = stubFetch(INITIALISED);
    await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k1',
      amountPesewas: 700,
      customerEmail: 'ama@acity.edu.gh',
      reference: 'ref-1',
      split: { subaccountCode: 'ACCT_vendor', sharePesewas: 0 },
    });
    assert.equal('split' in fetchImpl.calls[0].body, false);
  });

  test('a share bigger than the charge is refused before it is sent', async () => {
    // Paystack's minimum transaction for a flat split is the sum of the shares,
    // so a split larger than the payment simply cannot settle. Better to fail
    // here, loudly, than to open a checkout that will not resolve.
    const fetchImpl = stubFetch(INITIALISED);
    await assert.rejects(
      () =>
        providerWith(fetchImpl).initiateCollection({
          idempotencyKey: 'k1',
          amountPesewas: 1000,
          customerEmail: 'ama@acity.edu.gh',
          reference: 'ref-1',
          split: { subaccountCode: 'ACCT_vendor', sharePesewas: 2000 },
        }),
      /exceeds the charge/
    );
    assert.equal(fetchImpl.calls.length, 0);
  });

  test('a non-integer share is a bug, and is refused rather than rounded', async () => {
    const fetchImpl = stubFetch(INITIALISED);
    await assert.rejects(
      () =>
        providerWith(fetchImpl).initiateCollection({
          idempotencyKey: 'k1',
          amountPesewas: 1000,
          customerEmail: 'ama@acity.edu.gh',
          reference: 'ref-1',
          split: { subaccountCode: 'ACCT_vendor', sharePesewas: 350.5 },
        }),
      /integer number of pesewas/
    );
  });

  test('a refused split does not stop the payment, and says so', async () => {
    // A customer must be able to buy lunch when a vendor's subaccount has been
    // deactivated. The charge goes through without the split; the vendor's money
    // stays in our balance and the settlement run sends it, which is the path
    // that existed before splits did.
    const fetchImpl = stubFetch([
      { ok: false, status: 400, body: { status: false, message: 'Subaccount is inactive' } },
      INITIALISED,
    ]);

    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k1',
      amountPesewas: 4200,
      customerEmail: 'ama@acity.edu.gh',
      reference: 'ref-1',
      split: { subaccountCode: 'ACCT_dead', sharePesewas: 3500 },
    });

    assert.equal(result.status, 'PENDING', 'the customer can still pay');
    assert.ok(result.redirectUrl, 'and is still sent to a checkout');
    assert.equal(result.splitApplied, false, 'but the ledger is told the truth');
    assert.match(result.splitError, /Subaccount is inactive/);

    assert.equal(fetchImpl.calls.length, 2);
    assert.ok('split' in fetchImpl.calls[0].body, 'first attempt carried it');
    assert.equal('split' in fetchImpl.calls[1].body, false, 'the retry did not');
  });

  test('a failure that is not about the split is not retried', async () => {
    const fetchImpl = stubFetch({
      ok: false,
      status: 400,
      body: { status: false, message: 'Invalid email address' },
    });

    await assert.rejects(
      () =>
        providerWith(fetchImpl).initiateCollection({
          idempotencyKey: 'k1',
          amountPesewas: 4200,
          customerEmail: 'nope',
          reference: 'ref-1',
          split: { subaccountCode: 'ACCT_vendor', sharePesewas: 3500 },
        }),
      /Invalid email address/
    );
    assert.equal(fetchImpl.calls.length, 1, 'one attempt, no blind retry');
  });

  test('a duplicate reference never claims a split it cannot verify', async () => {
    // Paystack already holds this transaction, created with whatever split it
    // was created with. Claiming otherwise would let the ledger decide a vendor
    // had been paid on the strength of a guess.
    const fetchImpl = stubFetch([
      {
        ok: false,
        status: 400,
        body: { status: false, message: 'Duplicate Transaction Reference' },
      },
      { body: { status: true, data: { status: 'success', amount: 4200, currency: 'GHS' } } },
    ]);

    const result = await providerWith(fetchImpl).initiateCollection({
      idempotencyKey: 'k1',
      amountPesewas: 4200,
      customerEmail: 'ama@acity.edu.gh',
      reference: 'ref-1',
      split: { subaccountCode: 'ACCT_vendor', sharePesewas: 3500 },
    });

    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.splitApplied, false);
    assert.match(result.splitError, /duplicate reference/i);
  });
});

// ===========================================================================
// The ledger
// ===========================================================================

describe('split settlement in the ledger', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);

  /** Registers a vendor subaccount the way the application does. */
  async function giveVendorASubaccount(vendorId = VENDORS.one, code = 'ACCT_muni_test') {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_set_payout_destination($1,$2,$3,$4,$5,$6)', [
          'VENDOR',
          vendorId,
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
        vendorId,
        'paystack',
        code,
        null,
      ])
    );
  }

  /** Pays an order, recording a split of the given size against it. */
  async function payWithSplit(orderId, { subaccount = 'ACCT_muni_test', share = null } = {}) {
    return asService(async (c) => {
      const { rows } = await c.query(
        "select * from public.create_payment_intent($1, 'paystack', $2)",
        [orderId, `split:${orderId}`]
      );
      const payment = rows[0];

      if (subaccount) {
        const order = (
          await c.query('select subtotal_pesewas from public.orders where id = $1', [orderId])
        ).rows[0];
        await c.query('select public.attach_payment_split($1, $2, $3)', [
          payment.id,
          subaccount,
          share ?? Number(order.subtotal_pesewas),
        ]);
      }

      await c.query('select public.confirm_payment($1, $2, $3)', [
        payment.id,
        `ps_txn_${payment.id}`,
        payment.amount_pesewas,
      ]);
      return payment;
    });
  }

  test('a split charge settles the vendor allocation without a payout run', async () => {
    await giveVendorASubaccount();
    const order = await acceptedOrder();
    await payWithSplit(order.order_id);

    const allocations = await getAllocations(order.order_id);
    const vendor = allocations.find((a) => a.payee_type === 'VENDOR');
    const platform = allocations.find((a) => a.payee_type === 'PLATFORM');

    assert.equal(vendor.status, 'SETTLED', 'Paystack already sent it');
    assert.equal(vendor.settlement_channel, 'SPLIT');
    assert.ok(vendor.settled_at, 'with a timestamp, like any other settlement');

    // 100% OF THE FOOD, and nothing else. The service fee and the delivery fee
    // are the platform's, and they stayed in our balance.
    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows[0]
    );
    assert.equal(Number(vendor.amount_pesewas), Number(stored.subtotal_pesewas));
    assert.equal(
      Number(platform.amount_pesewas),
      Number(stored.service_fee_pesewas) + Number(stored.delivery_fee_pesewas)
    );
    assert.equal(platform.settlement_channel, 'TRANSFER', 'our own revenue is not split');
  });

  test('a settled vendor allocation is never claimed by a run, so nobody is paid twice', async () => {
    await giveVendorASubaccount();
    const order = await acceptedOrder();
    await payWithSplit(order.order_id);

    const run = await asService(
      async (c) =>
        (
          await c.query(
            `select * from public.create_settlement_run('VENDOR', now() - interval '1 day', now() + interval '1 day')`
          )
        ).rows[0]
    );

    assert.equal(Number(run.total_pesewas), 0, 'there was nothing left to send');

    const payouts = await asService(
      async (c) =>
        (await c.query('select * from public.payouts where settlement_run_id = $1', [run.id])).rows
    );
    assert.equal(payouts.length, 0);

    const [vendor] = (await getAllocations(order.order_id)).filter(
      (a) => a.payee_type === 'VENDOR'
    );
    assert.equal(vendor.status, 'SETTLED');
    assert.equal(vendor.settlement_run_id, null, 'and no run ever claimed it');
  });

  test('a vendor with no subaccount is still paid, by the run', async () => {
    const order = await acceptedOrder();
    await payWithSplit(order.order_id, { subaccount: null });

    const [vendor] = (await getAllocations(order.order_id)).filter(
      (a) => a.payee_type === 'VENDOR'
    );
    assert.equal(vendor.status, 'ELIGIBLE');
    assert.equal(vendor.settlement_channel, 'TRANSFER');

    const run = await asService(
      async (c) =>
        (
          await c.query(
            `select * from public.create_settlement_run('VENDOR', now() - interval '1 day', now() + interval '1 day')`
          )
        ).rows[0]
    );
    assert.ok(Number(run.total_pesewas) > 0, 'the old path still works');
  });

  test('a split that was refused leaves the money to the run', async () => {
    // attach_payment_split is only called when the provider CONFIRMS it applied
    // one, so a refused split simply leaves the payment with no split recorded
    // — and the ledger reads what happened, not what was intended.
    await giveVendorASubaccount();
    const order = await acceptedOrder();
    await payWithSplit(order.order_id, { subaccount: null });

    const [vendor] = (await getAllocations(order.order_id)).filter(
      (a) => a.payee_type === 'VENDOR'
    );
    assert.equal(vendor.status, 'ELIGIBLE', 'a registered subaccount is not the same as a split');
    assert.equal(vendor.settlement_channel, 'TRANSFER');
  });

  test('a partial split does not settle the row', async () => {
    // A remainder nobody was going to send is worse than no split at all.
    await giveVendorASubaccount();
    const order = await acceptedOrder();
    await payWithSplit(order.order_id, { share: 100 });

    const [vendor] = (await getAllocations(order.order_id)).filter(
      (a) => a.payee_type === 'VENDOR'
    );
    assert.equal(vendor.status, 'ELIGIBLE');
    assert.equal(vendor.settlement_channel, 'TRANSFER');
  });

  test('a scan order with a pack splits the pack to the store, and only the pack', async () => {
    await giveVendorASubaccount(VENDORS.wafflemania);
    // Stated, not inherited: another file zeroes the pack for its own arithmetic.
    await asService((c) =>
      c.query('update public.pricing_config set scan_pack_fee_pesewas = 400 where id')
    );

    // A Partner order, so the pack is compulsory: GH₵2 fee + GH₵4 pack + GH₵5.
    const order = await submitScanOrder({ vendorId: VENDORS.wafflemania });
    await payWithSplit(order.order_id, { share: 400 });

    const vendor = (await getAllocations(order.order_id)).filter((a) => a.payee_type === 'VENDOR');
    assert.equal(vendor.length, 1, 'the pack is the store’s money');
    assert.equal(Number(vendor[0].amount_pesewas), 400, 'the pack, and never the scanned value');
    assert.equal(vendor[0].status, 'SETTLED', 'paid by the split, so no run can claim it');
    assert.equal(vendor[0].settlement_channel, 'SPLIT');
  });

  test('a scan collection with no pack has no vendor allocation to split at all', async () => {
    await giveVendorASubaccount(VENDORS.wafflemania);

    const order = await submitScanOrder({
      vendorId: VENDORS.wafflemania,
      fulfilment: 'PICKUP',
      wantsPack: false,
    });
    await payWithSplit(order.order_id, { subaccount: null });

    const allocations = await getAllocations(order.order_id);
    assert.equal(
      allocations.filter((a) => a.payee_type === 'VENDOR').length,
      0,
      'the university settles the food, and there is no pack: the store is owed nothing by us'
    );
  });

  test('the Partner is settled by transfer, because no Partner exists at charge time', async () => {
    await giveVendorASubaccount();
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    const allocations = await getAllocations(order.order_id);
    const partner = allocations.find((a) => a.payee_type === 'PARTNER');

    assert.ok(partner, 'the Partner earned, and it is on the ledger');
    assert.equal(partner.status, 'ELIGIBLE');
    assert.equal(
      partner.settlement_channel,
      'TRANSFER',
      'a split is fixed at the charge, and at the charge there was nobody to name'
    );

    // And the balance still holds: every pesewa is allocated exactly once.
    const stored = await asService(
      async (c) =>
        (await c.query('select * from public.orders where id = $1', [order.order_id])).rows[0]
    );
    const total = allocations.reduce((sum, a) => sum + Number(a.amount_pesewas), 0);
    assert.equal(total, Number(stored.total_pesewas));
  });

  test('a split is recorded only while the payment is pending', async () => {
    await giveVendorASubaccount();
    const order = await acceptedOrder();
    const payment = await payWithSplit(order.order_id);

    const error = await expectRejection(
      asService((c) =>
        c.query('select public.attach_payment_split($1, $2, $3)', [payment.id, 'ACCT_other', 100])
      )
    );
    assert.match(error.message, /only be recorded while the payment is pending/i);
  });

  test('no client role can record a split or a subaccount', async () => {
    for (const sql of [
      "select public.attach_payment_split('11111111-1111-4111-8111-111111111111', 'ACCT_x', 100)",
      "select public.attach_payout_subaccount('VENDOR', '20000000-0000-4000-8000-000000000001', 'paystack', 'ACCT_x', null)",
    ]) {
      const error = await expectRejection(asUser(ACTORS.customerAma, (c) => c.query(sql)));
      assert.match(error.message, /permission denied/i);
    }
  });
});

// ===========================================================================
// Vendor and Partner payout setup
// ===========================================================================

describe('payout setup', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  test('a vendor sets their own destination, and only their own', async () => {
    const row = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (
          await c.query('select * from public.vendor_set_payout_destination($1,$2,$3,$4)', [
            VENDORS.one,
            'MTN',
            '0551234567',
            'Muni Kitchen',
          ])
        ).rows[0],
      { commit: true }
    );
    assert.equal(row.payee_id, VENDORS.one);
    assert.equal(row.momo_network, 'MTN');

    const notMine = await expectRejection(
      asUser(ACTORS.vendor1Staff, (c) =>
        c.query('select public.vendor_set_payout_destination($1,$2,$3,$4)', [
          VENDORS.two,
          'MTN',
          '0551234567',
          'Someone Else',
        ])
      )
    );
    assert.match(notMine.message, /do not own that store/i);
  });

  test('changing the number invalidates BOTH provider identities', async () => {
    await asUser(
      ACTORS.vendor1Staff,
      (c) =>
        c.query('select public.vendor_set_payout_destination($1,$2,$3,$4)', [
          VENDORS.one,
          'MTN',
          '0551234567',
          'Muni Kitchen',
        ]),
      { commit: true }
    );
    await asService((c) =>
      c.query(
        `update public.payout_destinations
            set provider = 'paystack', provider_recipient_code = 'RCP_old',
                provider_subaccount_code = 'ACCT_old'
          where payee_type = 'VENDOR' and payee_id = $1`,
        [VENDORS.one]
      )
    );

    await asUser(
      ACTORS.vendor1Staff,
      (c) =>
        c.query('select public.vendor_set_payout_destination($1,$2,$3,$4)', [
          VENDORS.one,
          'MTN',
          '0209999999',
          'Muni Kitchen',
        ]),
      { commit: true }
    );

    const row = await asService(
      async (c) =>
        (
          await c.query(
            "select * from public.payout_destinations where payee_type = 'VENDOR' and payee_id = $1",
            [VENDORS.one]
          )
        ).rows[0]
    );
    assert.equal(row.account_number, '0209999999');
    assert.equal(row.provider_recipient_code, null, 'a transfer would have paid the old number');
    assert.equal(
      row.provider_subaccount_code,
      null,
      'and a split would have routed food money to it'
    );
  });

  test('a payee reads their own destination, and never the whole number', async () => {
    await asUser(
      ACTORS.vendor1Staff,
      (c) =>
        c.query('select public.vendor_set_payout_destination($1,$2,$3,$4)', [
          VENDORS.one,
          'MTN',
          '0551234567',
          'Muni Kitchen',
        ]),
      { commit: true }
    );

    const mine = await asUser(
      ACTORS.vendor1Staff,
      async (c) => (await c.query('select * from public.my_payout_destination()')).rows
    );
    assert.equal(mine.length, 1);
    assert.equal(mine[0].payee_type, 'VENDOR');
    assert.equal(mine[0].account_last3, '567');
    assert.ok(!('account_number' in mine[0]), 'the full number never leaves the server');
    assert.equal(mine[0].split_ready, false);

    // And nobody else's.
    const theirs = await asUser(
      ACTORS.vendor2Staff,
      async (c) => (await c.query('select * from public.my_payout_destination()')).rows
    );
    assert.deepEqual(theirs, []);
  });

  test('an administrator can see who is not set up yet', async () => {
    const readiness = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_payout_readiness()')).rows
    );

    assert.ok(readiness.length > 0, 'active vendors and approved Partners are all listed');
    for (const row of readiness) {
      assert.equal(row.has_destination, false, 'nothing is registered in the fixture');
      assert.equal(row.split_ready, false);
      assert.ok(!('account_number' in row), 'never the whole number, even for an admin list');
    }

    const notAdmin = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.admin_payout_readiness()')).rows
    );
    assert.deepEqual(notAdmin, [], 'is_admin() is checked in the function body');
  });
});
