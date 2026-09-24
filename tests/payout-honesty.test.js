import './helpers/local-supabase.js';
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
  MENU,
  LOCATIONS,
} from './helpers/db.js';
import {
  submitOrder,
  payOrder,
  orderReadyForDispatch,
  partnerAccept,
  completeDelivery,
  setPartnerPayoutThreshold,
} from './helpers/flow.js';

/**
 * WHAT "PAID" MEANS, AT EVERY STAGE, AND NOT MORE.
 *
 * A store with a Paystack subaccount is paid by split when the customer pays,
 * and never appears in a run. A store without one, and every Partner, is paid
 * by an administrator outside Campus Dash and recorded here — while transfers
 * are off, which they are in production. Nothing becomes PAID because a day
 * arrived, a webhook landed or a button was pressed that sends nothing.
 */

const read = (path) => readFileSync(path, 'utf8');

describe('payout honesty: the rules', () => {
  test('the Partner week is Sunday to Saturday, the same whichever day it is gathered', async () => {
    const { partnerWeek, isPayday } = await import('@/lib/settlement/payday');
    const { periodFor } = await import('@/lib/settlement/index.js');

    const sunday = new Date('2026-09-27T10:00:00Z');
    const monday = new Date('2026-09-28T09:00:00Z');
    const saturday = new Date('2026-10-03T23:00:00Z');
    const want = { periodStart: '2026-09-20T00:00:00.000Z', periodEnd: '2026-09-27T00:00:00.000Z' };

    assert.deepEqual(partnerWeek(sunday), want);
    assert.deepEqual(partnerWeek(monday), want, 'gathered late, still last week');
    assert.deepEqual(partnerWeek(saturday), want);
    assert.deepEqual(periodFor('PARTNER', monday), want, 'the run uses the same week');
    assert.equal(isPayday(sunday), true);
    assert.equal(isPayday(monday), false);

    // Vendors keep their calendar-day period.
    assert.deepEqual(periodFor('VENDOR', monday), {
      periodStart: '2026-09-27T00:00:00.000Z',
      periodEnd: '2026-09-28T00:00:00.000Z',
    });
  });

  test('a run is by hand for Partners always, and for stores whenever transfers are off', async () => {
    const { settlesByHand } = await import('@/lib/settlement/index.js');
    assert.equal(settlesByHand('PARTNER', { canSendTransfers: true }), true);
    assert.equal(settlesByHand('PARTNER', { canSendTransfers: false }), true);
    assert.equal(settlesByHand('VENDOR', { canSendTransfers: false }), true, 'production today');
    assert.equal(settlesByHand('VENDOR', { canSendTransfers: true }), false);
  });

  test('the Sunday reminder lists who reached the threshold for last week, and no one else', async () => {
    const { partnersDue } = await import('@/lib/settlement/payday');
    const now = new Date('2026-09-27T08:00:00Z'); // Sunday
    const inWeek = '2026-09-24T12:00:00Z';
    const thisWeek = '2026-09-27T07:00:00Z'; // after the week closed
    const a = (payee_id, amount_pesewas, order_created_at, extra = {}) => ({
      payee_id,
      amount_pesewas,
      order_created_at,
      status: 'ELIGIBLE',
      settlement_run_id: null,
      ...extra,
    });
    const due = partnersDue({
      now,
      thresholdPesewas: 2000,
      partners: [
        { partner_id: 'p1', partner_name: 'Yaw' },
        { partner_id: 'p2', partner_name: 'Adjoa' },
      ],
      allocations: [
        a('p1', 500, inWeek),
        a('p1', 500, inWeek),
        a('p1', 500, inWeek),
        a('p1', 500, inWeek), // p1: GH₵20 — due
        a('p1', 500, thisWeek), // next week's, not counted
        a('p2', 1500, inWeek), // p2: GH₵15 — under, carries forward
        a('p2', 500, inWeek, { settlement_run_id: 'run' }), // already gathered
        a('p2', 900, inWeek, { status: 'SETTLED' }), // already paid
      ],
    });
    assert.deepEqual(due, [{ partnerId: 'p1', partnerName: 'Yaw', owedPesewas: 2000 }]);
  });

  test('sign-up payout details are required, and "use my SMS number" means the verified one', async () => {
    const { readSignupPayout, payoutNumberFor } = await import('@/lib/vendor/payout-details');
    const form = (fields) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(fields)) f.set(k, v);
      return f;
    };

    assert.match(
      readSignupPayout(form({ momo_account_name: 'Ama', momo_number: '0551234567' })).message,
      /network/
    );
    assert.match(
      readSignupPayout(form({ momo_network: 'MTN', momo_number: '0551234567' })).message,
      /name on the mobile money/
    );
    assert.match(
      readSignupPayout(form({ momo_network: 'MTN', momo_account_name: 'Ama' })).message,
      /mobile money number/
    );
    assert.match(
      readSignupPayout(form({ momo_network: 'MTN', momo_account_name: 'Ama', momo_number: '12' }))
        .message,
      /mobile money number/
    );
    assert.match(
      readSignupPayout(
        form({ momo_network: 'MPESA', momo_account_name: 'Ama', momo_use_signin_phone: 'on' })
      ).message,
      /network/
    );

    // Ticked: no separate number needed, and the payout number is the one the
    // SMS code proved — whatever else was typed.
    const same = readSignupPayout(
      form({
        momo_network: 'MTN',
        momo_account_name: 'Ama',
        momo_use_signin_phone: 'on',
        momo_number: '0209999999',
      })
    );
    assert.equal(same.ok, true);
    assert.equal(payoutNumberFor(same.value, '+233551234567'), '+233551234567');
    assert.equal(payoutNumberFor(same.value, null), null, 'no proven number, nothing saved');

    // Unticked: the separate number.
    const separate = readSignupPayout(
      form({ momo_network: 'VODAFONE', momo_account_name: 'Ama', momo_number: '020 999 9999' })
    );
    assert.equal(separate.ok, true);
    assert.equal(payoutNumberFor(separate.value, '+233551234567'), '+233209999999');
  });
});

describe('payout honesty: the split record', () => {
  // CD-01083's signed charge.success split shares, exactly as production stored them.
  const CD_01083 = {
    fees: 3,
    paystack: 3,
    integration: 4,
    original_share: 7,
    subaccounts: [
      {
        id: 2191152,
        fees: 0,
        amount: 100,
        integration: '2001531',
        original_share: 100,
        subaccount_code: 'ACCT_rkyryk0phpya3yo',
      },
    ],
  };

  test('Paystack bore nothing from the store: the fee came out of Campus Dash’s side', async () => {
    const { splitRecord } = await import('@/lib/settlement/split-record');
    assert.deepEqual(splitRecord(CD_01083, 'ACCT_rkyryk0phpya3yo', 100), {
      subaccountCreditPesewas: 100,
      paystackFeePesewas: 3,
      campusDashNetPesewas: 4,
      vendorFeePesewas: 0,
      confirmed: true,
    });
  });

  test('a record that does not credit the whole share, or does not exist, is not a confirmation', async () => {
    const { splitRecord } = await import('@/lib/settlement/split-record');
    const short = {
      ...CD_01083,
      subaccounts: [{ ...CD_01083.subaccounts[0], amount: 97, fees: 3 }],
    };
    assert.deepEqual(splitRecord(short, 'ACCT_rkyryk0phpya3yo', 100), {
      subaccountCreditPesewas: 97,
      paystackFeePesewas: 3,
      campusDashNetPesewas: 4,
      vendorFeePesewas: 3,
      confirmed: false,
    });
    assert.equal(splitRecord(CD_01083, 'ACCT_someone_else', 100).confirmed, false);
    assert.deepEqual(splitRecord(null, 'ACCT_rkyryk0phpya3yo', 100), {
      subaccountCreditPesewas: null,
      paystackFeePesewas: null,
      campusDashNetPesewas: null,
      vendorFeePesewas: null,
      confirmed: false,
    });
  });

  test('the log is fed by the payment itself, and confirmed by Paystack’s signature alone', () => {
    const lib = read('lib/admin/index.js');
    const from = lib.indexOf('export async function vendorSplitPayments(');
    const reader = lib.slice(from, lib.indexOf('\nexport ', from + 1));
    const code = reader.replace(/\/\/.*$/gm, '');
    // Rows are the store's SPLIT allocations, written by confirm_payment().
    assert.match(code, /\.eq\('settlement_channel', 'SPLIT'\)/);
    // Behind an administrator check.
    assert.match(code, /if \(!me\.is_admin\) throw new Error\('admin privileges required'\)/);
    // Confirmed by the signed record, not by our own processing status, and
    // not by any run, payout or settlement.
    assert.match(code, /e\.signature_valid/);
    assert.doesNotMatch(code, /'PROCESSED'|settlement_runs|payouts|cron/);

    const page = read('app/admin/settlements/page.js');
    assert.match(page, /export const dynamic = 'force-dynamic'/, 'read fresh on every load');
    for (const column of ['Vendor share', 'Paystack fee', 'Subaccount credit', 'Campus Dash net']) {
      assert.match(page, new RegExp(`'${column}'`));
    }
    assert.doesNotMatch(page, /Fee on store share/);
    assert.match(page, /borne by Campus Dash/);
    assert.match(page, /Automatically split by Paystack\. MoMo settlement not tracked here\./);
  });
});

describe('payout honesty: the screens say what happens', () => {
  test('no admin control claims to send money that it does not send', () => {
    const controls = read('app/admin/settlements/settlement-controls.js');
    const manual = read('app/admin/settlements/manual-settlement.js');
    const page = read('app/admin/settlements/page.js');

    // The vendor run is labelled by what it does when transfers are off.
    assert.match(controls, /Gather payouts for stores without a split/);
    assert.equal(/Run vendor settlement \(daily\)/.test(controls), false);
    // Recording is recording: the button names an external payment.
    assert.match(manual, /I have paid this externally/);
    assert.match(manual, /Record payment/);
    assert.match(manual, /Campus Dash does not send this money/);
    // A FAILED payout is never offered for recording (the database refuses it).
    assert.match(manual, /p\.status === 'PENDING' \|\| p\.status === 'PROCESSING'/);
    // Split payments are shown as automatic, with no pay action, and MoMo
    // settlement is stated as untracked.
    assert.match(page, /Paid automatically by Paystack split/);
    assert.match(page, /MoMo settlement not tracked here/);
    assert.equal(/settled by transfer, daily/.test(page), false);
  });

  test('Partners are never told a payout is on its way before an administrator has sent it', () => {
    const partner = read('app/partner/page.js');
    assert.equal(/On its way|Payout on its way|Available now/.test(partner), false);
    assert.match(partner, /To be paid by Campus Dash/);
    assert.match(partner, /Paid out \$\{shortDay\(p\.paid_at\)\}/);
  });

  test('vendors are not promised money in their account', () => {
    const profile = read('app/vendor/profile/page.js');
    const actions = read('app/vendor/actions.js');
    assert.equal(/next working day/.test(profile + actions), false);
    assert.equal(/daily run/.test(profile), false);
  });
});

describe('payout honesty: the ledger', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const tomorrow = () => {
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    end.setUTCDate(end.getUTCDate() + 1);
    return end;
  };
  const run = (payeeType) =>
    asService(async (c) => {
      const end = tomorrow();
      const start = new Date(end.getTime() - 8 * 86400000);
      return (
        await c.query('select * from public.create_settlement_run($1, $2, $3)', [
          payeeType,
          start.toISOString(),
          end.toISOString(),
        ])
      ).rows[0];
    });
  const allocationsFor = (orderId) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select payee_type, amount_pesewas, status, settlement_channel, settlement_run_id from public.allocations where order_id = $1 order by payee_type',
            [orderId]
          )
        ).rows
    );
  const payoutsOf = (payeeType, payeeId) =>
    asService(
      async (c) =>
        (
          await c.query(
            'select id, status, amount_pesewas, provider, provider_transfer_id, paid_at from public.payouts where payee_type = $1 and payee_id = $2',
            [payeeType, payeeId]
          )
        ).rows
    );
  const record = (payoutId, reference = 'MOMO-123') =>
    asUser(
      ACTORS.admin,
      async (c) =>
        (
          await c.query('select * from public.admin_settle_payout_manually($1, $2, $3)', [
            payoutId,
            reference,
            'paid externally in test',
          ])
        ).rows[0],
      { commit: true }
    );

  test('a store without a split is owed, not paid — until its payment is recorded', async () => {
    const placed = await submitOrder({
      vendorId: VENDORS.one,
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilment: 'PICKUP',
      destination: null,
    });
    await payOrder(placed.order_id);

    const [platform, vendor] = [...(await allocationsFor(placed.order_id))].sort((a, b) =>
      a.payee_type.localeCompare(b.payee_type)
    );
    assert.equal(vendor.payee_type, 'VENDOR');
    assert.deepEqual(
      [vendor.status, vendor.settlement_channel],
      ['ELIGIBLE', 'TRANSFER'],
      'owed, not split'
    );
    assert.equal(vendor.amount_pesewas, 3500, 'the food only');
    assert.equal(platform.payee_type, 'PLATFORM');

    // Gathering creates a PENDING payout and pays nothing.
    await run('VENDOR');
    const [payout] = await payoutsOf('VENDOR', VENDORS.one);
    assert.equal(payout.status, 'PENDING');
    assert.equal(payout.paid_at, null);
    assert.equal(
      (await allocationsFor(placed.order_id)).find((a) => a.payee_type === 'VENDOR').status,
      'SETTLING'
    );

    // Recorded as paid externally: PAID, with the reference, and the
    // allocation SETTLED through the payout (not through a split).
    const paid = await record(payout.id);
    assert.deepEqual(
      [paid.status, paid.provider, paid.provider_transfer_id],
      ['PAID', 'manual', 'MOMO-123']
    );
    assert.ok(paid.paid_at);
    const settled = (await allocationsFor(placed.order_id)).find((a) => a.payee_type === 'VENDOR');
    assert.deepEqual([settled.status, settled.settlement_channel], ['SETTLED', 'TRANSFER']);

    // Recording again changes nothing and writes no second audit row.
    const again = await record(payout.id, 'MOMO-DIFFERENT');
    assert.equal(again.provider_transfer_id, 'MOMO-123');
    const audits = await asService(
      async (c) =>
        (
          await c.query(
            "select count(*)::int n from public.admin_actions where action = 'PAYOUT_SETTLED_MANUALLY' and target_id = $1",
            [payout.id]
          )
        ).rows[0].n
    );
    assert.equal(audits, 1);

    // And a second run for the same period gathers nobody twice.
    await run('VENDOR');
    assert.equal((await payoutsOf('VENDOR', VENDORS.one)).length, 1);
  });

  test('a split-settled store never reaches a run and can never be paid again', async () => {
    const placed = await submitOrder({
      vendorId: VENDORS.one,
      items: [{ menu_item_id: MENU.jollof, quantity: 1 }],
      fulfilmentType: 'PICKUP',
      fulfilment: 'PICKUP',
      destination: null,
    });
    await asService(async (c) => {
      const intent = (
        await c.query("select * from public.create_payment_intent($1, 'fake', 'split-test')", [
          placed.order_id,
        ])
      ).rows[0];
      await c.query("select public.attach_payment_split($1, 'ACCT_test', 3500)", [intent.id]);
      await c.query('select public.confirm_payment($1, $2, $3)', [
        intent.id,
        'txn-split',
        intent.amount_pesewas,
      ]);
    });

    const vendor = (await allocationsFor(placed.order_id)).find((a) => a.payee_type === 'VENDOR');
    assert.deepEqual(
      [vendor.status, vendor.settlement_channel, vendor.settlement_run_id],
      ['SETTLED', 'SPLIT', null]
    );

    await run('VENDOR');
    assert.equal((await payoutsOf('VENDOR', VENDORS.one)).length, 0, 'nothing to gather');
    const after = (await allocationsFor(placed.order_id)).find((a) => a.payee_type === 'VENDOR');
    assert.deepEqual([after.status, after.settlement_run_id], ['SETTLED', null]);
  });

  test('a Partner is not paid by Sunday, by gathering, or by anything but a recorded payment', async () => {
    await setPartnerPayoutThreshold(1000);
    const earned = [];
    for (let i = 0; i < 2; i += 1) {
      const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
      await partnerAccept(order.order_id, ACTORS.partnerYaw);
      await completeDelivery(order.order_id, ACTORS.partnerYaw);
      earned.push(order.order_id);
    }
    const summary = () =>
      asUser(
        ACTORS.partnerYaw,
        async (c) => (await c.query('select * from public.partner_earnings_summary()')).rows[0]
      );

    let s = await summary();
    assert.deepEqual([s.available_pesewas, s.settled_pesewas], [1000, 0]);

    await run('PARTNER');
    const [payout] = await payoutsOf('PARTNER', ACTORS.partnerYaw);
    assert.equal(payout.status, 'PENDING', 'gathered, not paid');
    s = await summary();
    assert.deepEqual([s.available_pesewas, s.in_progress_pesewas, s.settled_pesewas], [0, 1000, 0]);

    await record(payout.id, 'MOMO-YAW');
    s = await summary();
    assert.deepEqual([s.available_pesewas, s.in_progress_pesewas, s.settled_pesewas], [0, 0, 1000]);
    const history = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.my_partner_payouts()')).rows
    );
    assert.equal(history[0].status, 'PAID');
    assert.ok(history[0].paid_at && history[0].period_start && history[0].period_end);

    // The new week starts at zero and fills from new work only.
    const next = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(next.order_id, ACTORS.partnerYaw);
    await completeDelivery(next.order_id, ACTORS.partnerYaw);
    s = await summary();
    assert.deepEqual([s.available_pesewas, s.settled_pesewas], [500, 1000]);
  });

  test('a Partner under the threshold is held, owed, and never gathered or marked paid', async () => {
    await setPartnerPayoutThreshold(2000);
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    await completeDelivery(order.order_id, ACTORS.partnerYaw);

    await run('PARTNER');
    assert.equal((await payoutsOf('PARTNER', ACTORS.partnerYaw)).length, 0);
    const partner = (await allocationsFor(order.order_id)).find((a) => a.payee_type === 'PARTNER');
    assert.deepEqual([partner.status, partner.settlement_run_id], ['ELIGIBLE', null], 'still owed');
  });

  test('a store waiting for approval can give payout details, which are not registered anywhere yet', async () => {
    const saved = await asUser(
      ACTORS.vendorPendingOwner,
      async (c) =>
        (
          await c.query(
            "select * from public.vendor_set_payout_destination($1, 'MTN', '+233551234567', 'Pending Owner')",
            [VENDORS.pending]
          )
        ).rows[0],
      { commit: true }
    );
    assert.equal(saved.account_number, '0551234567');
    assert.equal(saved.provider_subaccount_code, null, 'no Paystack subaccount at sign-up');

    // Somebody else's store: refused.
    await assert.rejects(
      asUser(ACTORS.vendorPendingOwner, (c) =>
        c.query("select public.vendor_set_payout_destination($1, 'MTN', '0551234567', 'X')", [
          VENDORS.one,
        ])
      ),
      /do not own that store/
    );
    await asService((c) =>
      c.query('delete from public.payout_destinations where payee_id = $1', [VENDORS.pending])
    );
  });
});
