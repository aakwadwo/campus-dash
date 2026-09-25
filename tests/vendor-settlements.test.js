import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PaystackPaymentProvider } from '../lib/payments/paystack.js';
import { FakePaymentProvider } from '../lib/payments/fake.js';
import {
  locateCharge,
  settlementSummary,
  matchTransactions,
  accraTime,
  SETTLEMENT_LABEL,
  ORDER_SETTLEMENT_LABEL,
} from '../lib/settlement/vendor-settlement.js';
import { splitRecord } from '../lib/settlement/split-record.js';

/**
 * PAYMENT, SPLIT AND SETTLEMENT ARE THREE FACTS.
 *
 * A customer paying proves the payment. Paystack's signed split shares prove
 * the subaccount was credited. Only a Paystack settlement whose own
 * transaction list contains the charge proves the money left Paystack for the
 * store's bank or mobile money. Campus Dash controls none of the last two, so
 * everything here READS, and nothing on an admin screen offers to pay a store
 * that Paystack settles.
 *
 * CD-01087 is the reference order: GH₵10.70 paid, GH₵10.00 split to
 * ACCT_a7377h6ovuem34k. The settlement shapes below are fixtures, not a claim
 * about what production Paystack has done with that money.
 */

const SECRET = 'sk_test_stub_key_for_settlement_tests_only';
const SUB = 'ACCT_a7377h6ovuem34k';
const REF = '18b12cd9-593e-4a5a-9307-27d58a5a950e';
const read = (path) => readFileSync(path, 'utf8');

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, method: options.method });
    const path = url.replace('https://api.paystack.test', '');
    const match = Object.entries(routes).find(([prefix]) => path.startsWith(prefix));
    const next = match ? match[1] : { status: 404, body: { status: false, message: 'Not found' } };
    const response = typeof next === 'function' ? next(path) : next;
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () => JSON.stringify(response.body),
    };
  };
  impl.calls = calls;
  return impl;
}

const provider = (fetchImpl) =>
  new PaystackPaymentProvider({
    secretKey: SECRET,
    apiUrl: 'https://api.paystack.test',
    fetchImpl,
  });

const settlementRow = (over = {}) => ({
  id: 9001,
  status: 'success',
  currency: 'GHS',
  total_amount: 1000,
  effective_amount: 1000,
  total_fees: 0,
  settlement_date: '2026-09-28T09:42:00.000Z',
  createdAt: '2026-09-28T09:00:00.000Z',
  subaccount: { subaccount_code: SUB, settlement_bank: 'MTN', account_number: '0551234567' },
  ...over,
});

// ===========================================================================
// The adapter reads, and only reads
// ===========================================================================

describe('Paystack settlements: the adapter', () => {
  test('lists one subaccount’s settlements with GET, normalised and masked', async () => {
    const fetchImpl = stubFetch({
      '/settlement?': {
        body: { status: true, data: [settlementRow()], meta: { total: 1 } },
      },
    });
    const { settlements, total } = await provider(fetchImpl).listSettlements({
      subaccountCode: SUB,
    });

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].method, 'GET');
    assert.match(fetchImpl.calls[0].url, /\/settlement\?subaccount=ACCT_a7377h6ovuem34k/);
    assert.equal(total, 1);
    assert.deepEqual(settlements[0], {
      id: '9001',
      status: 'SETTLED',
      rawStatus: 'success',
      currency: 'GHS',
      totalAmountPesewas: 1000,
      effectiveAmountPesewas: 1000,
      feesPesewas: 0,
      settlementDate: '2026-09-28T09:42:00.000Z',
      createdAt: '2026-09-28T09:00:00.000Z',
      subaccountCode: SUB,
      destinationBank: 'MTN',
      destinationLast3: '567',
    });
    assert.doesNotMatch(JSON.stringify(settlements), /0551234567/, 'never the whole number');
  });

  test('pending, processing, failed and unrecognised statuses are never read as settled', async () => {
    const rows = ['pending', 'processing', 'failed', 'something-new'].map((status, i) =>
      settlementRow({ id: i + 1, status })
    );
    const fetchImpl = stubFetch({ '/settlement?': { body: { status: true, data: rows } } });
    const { settlements } = await provider(fetchImpl).listSettlements({ subaccountCode: SUB });
    assert.deepEqual(
      settlements.map((s) => s.status),
      ['PENDING', 'PROCESSING', 'FAILED', 'UNKNOWN']
    );
    assert.equal(settlements[3].rawStatus, 'something-new');
  });

  test('another subaccount’s settlement is dropped, even if Paystack returns it', async () => {
    const fetchImpl = stubFetch({
      '/settlement?': {
        body: {
          status: true,
          data: [
            settlementRow({ id: 1 }),
            settlementRow({ id: 2, subaccount: { subaccount_code: 'ACCT_someone_else' } }),
          ],
        },
      },
    });
    const { settlements } = await provider(fetchImpl).listSettlements({ subaccountCode: SUB });
    assert.deepEqual(
      settlements.map((s) => s.id),
      ['1']
    );
  });

  test('an amount that is not GHS is not reported as pesewas', async () => {
    const fetchImpl = stubFetch({
      '/settlement?': { body: { status: true, data: [settlementRow({ currency: 'NGN' })] } },
    });
    const { settlements } = await provider(fetchImpl).listSettlements({ subaccountCode: SUB });
    assert.equal(settlements[0].totalAmountPesewas, null);
  });

  test('a refusal is thrown, so it can never be drawn as "no settlements"', async () => {
    const fetchImpl = stubFetch({
      '/settlement?': { status: 401, body: { status: false, message: 'Invalid key' } },
    });
    await assert.rejects(
      provider(fetchImpl).listSettlements({ subaccountCode: SUB }),
      /Invalid key/
    );
  });

  test('a settlement’s transactions are read across pages, and truncation is reported', async () => {
    const page = (n, count) => ({
      body: {
        status: true,
        data: Array.from({ length: count }, (_, i) => ({
          id: n * 1000 + i,
          reference: `ref-${n}-${i}`,
          amount: 1070,
          currency: 'GHS',
          paid_at: '2026-09-25T00:11:51.000Z',
        })),
        meta: { pageCount: 3 },
      },
    });
    const fetchImpl = stubFetch({
      '/settlement/9001/transactions': (path) => page(Number(/page=(\d+)/.exec(path)[1]), 2),
    });

    const all = await provider(fetchImpl).settlementTransactions('9001', { perPage: 2 });
    assert.equal(all.transactions.length, 6);
    assert.equal(all.truncated, false);
    assert.equal(all.transactions[0].amountPesewas, 1070);

    const bounded = await provider(fetchImpl).settlementTransactions('9001', {
      perPage: 2,
      maxPages: 2,
    });
    assert.equal(bounded.transactions.length, 4);
    assert.equal(bounded.truncated, true, 'not everything was read, and it says so');
  });

  test('a subaccount is read with its destination masked', async () => {
    const fetchImpl = stubFetch({
      [`/subaccount/${SUB}`]: {
        body: {
          status: true,
          data: {
            subaccount_code: SUB,
            active: true,
            is_verified: false,
            settlement_schedule: 'AUTO',
            settlement_bank: 'MTN Mobile Money',
            account_number: '0551234567',
          },
        },
      },
    });
    assert.deepEqual(await provider(fetchImpl).getSubaccount(SUB), {
      code: SUB,
      active: true,
      verified: false,
      schedule: 'AUTO',
      bank: 'MTN Mobile Money',
      last3: '567',
    });
    assert.equal(await provider(stubFetch({})).getSubaccount('ACCT_missing'), null);
  });

  test('the fake provider says it cannot read settlements, rather than reporting none', () => {
    assert.equal(new FakePaymentProvider().canReadSettlements, false);
    assert.equal(provider(stubFetch({})).canReadSettlements, true);
  });

  test('the adapter has no way to create, trigger or pay a settlement', () => {
    const source = read('lib/payments/paystack.js');
    assert.doesNotMatch(source, /'POST',\s*'\/settlement/);
    assert.doesNotMatch(source, /\/settlement[^`'"]*\/(pay|retry|initiate)/);
  });
});

// ===========================================================================
// Tying a charge to a settlement
// ===========================================================================

const paidAt = '2026-09-25T00:11:51.149Z';
const S = (id, status, date) => ({
  id,
  status,
  settlementDate: date,
  createdAt: date,
  totalAmountPesewas: 1000,
});
const lists = (map) => async (id) => ({ transactions: map[id] ?? [], truncated: false });

describe('Paystack settlements: which settlement carried a charge', () => {
  test('a charge in a successful settlement is SETTLED, with that settlement', async () => {
    const found = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'SETTLED', '2026-09-28T09:42:00Z')],
      transactionsFor: lists({ A: [{ reference: REF }] }),
    });
    assert.equal(found.state, 'SETTLED');
    assert.equal(found.settlement.id, 'A');
  });

  test('a charge in a pending settlement is PENDING, not settled', async () => {
    const found = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'PENDING', '2026-09-28T09:42:00Z')],
      transactionsFor: lists({ A: [{ reference: REF }] }),
    });
    assert.equal(found.state, 'PENDING');
  });

  test('a charge in a failed settlement is FAILED', async () => {
    const found = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'FAILED', '2026-09-28T09:42:00Z')],
      transactionsFor: lists({ A: [{ reference: REF }] }),
    });
    assert.equal(found.state, 'FAILED');
  });

  test('no settlement containing the charge is NOT_FOUND, and a split alone never settles it', async () => {
    const found = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'SETTLED', '2026-09-28T09:42:00Z')],
      transactionsFor: lists({ A: [{ reference: 'somebody-elses-charge' }] }),
    });
    assert.equal(found.state, 'NOT_FOUND');
    assert.equal(found.settlement, null);

    const none = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [],
      transactionsFor: lists({}),
    });
    assert.equal(none.state, 'NOT_FOUND');
  });

  test('a settlement of several charges is matched on the charge, and the earliest wins', async () => {
    const found = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [
        S('LATER', 'SETTLED', '2026-10-02T09:00:00Z'),
        S('BEFORE', 'SETTLED', '2026-09-20T09:00:00Z'),
        S('FIRST', 'SETTLED', '2026-09-28T09:00:00Z'),
      ],
      transactionsFor: lists({
        BEFORE: [{ reference: REF }],
        FIRST: [{ reference: 'x-1' }, { reference: REF }, { reference: 'x-2' }],
        LATER: [{ reference: REF }],
      }),
    });
    assert.equal(found.settlement.id, 'FIRST', 'settled before the payment cannot contain it');
    assert.equal(found.state, 'SETTLED');
  });

  test('a list that was not read in full is INCOMPLETE, never NOT_FOUND', async () => {
    const truncated = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'SETTLED', '2026-09-28T09:42:00Z')],
      transactionsFor: async () => ({ transactions: [], truncated: true }),
    });
    assert.equal(truncated.state, 'INCOMPLETE');

    const bounded = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [S('A', 'SETTLED', '2026-09-28T09:00Z'), S('B', 'SETTLED', '2026-09-29T09:00Z')],
      transactionsFor: lists({}),
      maxSettlements: 1,
    });
    assert.equal(bounded.state, 'INCOMPLETE');

    const shortList = await locateCharge({
      reference: REF,
      paidAt,
      settlements: [],
      transactionsFor: lists({}),
      listComplete: false,
    });
    assert.equal(shortList.state, 'INCOMPLETE');
  });

  test('a store’s history summarises its newest settlement and its last successful one', () => {
    const summary = settlementSummary([
      S('OLD', 'SETTLED', '2026-09-21T09:00:00Z'),
      S('NEW', 'PENDING', '2026-09-29T09:00:00Z'),
      S('MID', 'SETTLED', '2026-09-28T09:42:00Z'),
    ]);
    assert.equal(summary.latest.id, 'NEW');
    assert.equal(summary.lastSettled.id, 'MID');
    assert.equal(summary.count, 3);
    assert.deepEqual(settlementSummary([]), { latest: null, lastSettled: null, count: 0 });
  });

  test('settlement transactions are matched to orders, and strangers are kept and marked', () => {
    const rows = matchTransactions(
      [{ reference: REF }, { reference: 'not-ours' }],
      [{ id: REF, order_id: 'o-1', order_number: 'CD-01087', vendor_share_pesewas: 1000 }]
    );
    assert.equal(rows[0].orderNumber, 'CD-01087');
    assert.equal(rows[0].vendorSharePesewas, 1000);
    assert.equal(rows[1].orderId, null);
    assert.equal(rows.length, 2);
  });

  test('times are stated on the Accra clock', () => {
    assert.equal(accraTime('2026-09-28T09:42:00Z'), '28 Sept 2026, 09:42 Accra');
    assert.equal(accraTime(null), null);
  });
});

// ===========================================================================
// Split and settlement are different words
// ===========================================================================

describe('Paystack settlements: split is not settlement', () => {
  test('a confirmed split is a subaccount credit and carries no settlement state', () => {
    const shares = {
      paystack: 16,
      integration: 54,
      subaccounts: [{ subaccount_code: SUB, amount: 1000, fees: 0 }],
    };
    const split = splitRecord(shares, SUB, 1000);
    assert.equal(split.confirmed, true);
    assert.equal(split.subaccountCreditPesewas, 1000);
    assert.equal('settled' in split || 'settlement' in split, false);
  });

  test('the labels for a split and for a settlement never coincide', () => {
    const settlementWords = Object.values(ORDER_SETTLEMENT_LABEL).map((l) => l.label);
    assert.equal(settlementWords.includes('Split confirmed by Paystack'), false);
    assert.equal(SETTLEMENT_LABEL.SETTLED.label, 'Settled');
    assert.equal(ORDER_SETTLEMENT_LABEL.NOT_FOUND.label, 'Not settled yet');
  });
});

// ===========================================================================
// The screens
// ===========================================================================

describe('Paystack settlements: the admin screens', () => {
  const FAKE_ACTIONS =
    /Pay [Vv]endor|Send [Vv]endor|Transfer to [Vv]endor|Mark [Vv]endor [Pp]aid|Initiate [Vv]endor [Ss]ettlement|Complete [Vv]endor [Pp]ayment|Settle now/;

  test('no Paystack screen offers to pay, send, transfer or settle', () => {
    for (const path of [
      'app/admin/settlements/page.js',
      'app/admin/vendors/[id]/page.js',
      'app/admin/vendors/[id]/vendor-money.js',
      'app/admin/vendors/[id]/settlements/[settlementId]/page.js',
      'app/admin/orders/[orderId]/page.js',
    ]) {
      const source = read(path);
      assert.doesNotMatch(source, FAKE_ACTIONS, path);
      // A read-only screen: no form posts anywhere from it.
      if (!path.endsWith('settlements/page.js') && !path.endsWith('[id]/page.js')) {
        assert.doesNotMatch(source, /<form|useActionState/, `${path} has no actions`);
      }
    }
  });

  test('the only control near a Paystack settlement re-reads it', () => {
    const refresh = read('app/admin/refresh-button.js');
    assert.match(refresh, /router\.refresh\(\)/);
    assert.doesNotMatch(refresh, /action=|fetch\(|'use server'/);
    assert.match(read('app/admin/vendors/[id]/vendor-money.js'), /Refresh from Paystack/);
  });

  test('the Money page separates what needs the admin from what Paystack handles', () => {
    const page = read('app/admin/settlements/page.js');
    const needs = page.indexOf('title="Needs you"');
    const paystack = page.indexOf('title="Paystack handles these"');
    assert.ok(needs > -1 && paystack > needs);
    // Every manual control sits above the Paystack half.
    for (const control of ['<SettlementControls', '<ManualSettlement']) {
      assert.ok(page.indexOf(control) < paystack, control);
    }
    assert.match(page, /A split is not a settlement/);
    assert.match(page, /A split, not a settlement\./);
    assert.doesNotMatch(page, /[Pp]aid automatically by Paystack split/);
  });

  test('an order shows split and settlement as two separate facts', () => {
    const page = read('app/admin/orders/[orderId]/page.js');
    assert.match(page, /Split confirmed by Paystack/);
    assert.match(page, /Vendor settlement/);
    assert.match(page, /Split to subaccount/);
    // The split ledger row is not called a settlement.
    assert.doesNotMatch(page, /head=\{\['Payee', 'Amount', 'Status', 'Settled'\]\}/);
  });

  test('a Partner is never offered a Paystack split', () => {
    const destinations = read('app/admin/settlements/payout-destinations.js');
    assert.match(destinations, /row\.payee_type !== 'VENDOR' \|\| row\.provider_subaccount_code/);
    const actions = read('app/admin/actions.js');
    assert.match(actions, /Only a store is paid by Paystack split\./);
  });

  test('destination numbers are masked on the Money page', () => {
    const destinations = read('app/admin/settlements/payout-destinations.js');
    assert.doesNotMatch(destinations, /\{row\.account_number\}/);
    assert.match(destinations, /slice\(-3\)/);
  });

  test('every settlement reader is administrator-only and writes nothing', () => {
    const lib = read('lib/admin/index.js');
    for (const fn of [
      'vendorSettlements',
      'vendorSettlementDetail',
      'orderVendorMoney',
      'paystackVendorSummary',
    ]) {
      const from = lib.indexOf(`export async function ${fn}(`);
      assert.ok(from > -1, fn);
      const body = lib.slice(from, lib.indexOf('\nexport ', from + 1));
      assert.match(body, /^\s*await requireAdmin\(\);/m, `${fn} checks is_admin first`);
      assert.doesNotMatch(body, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|rpc\(/, fn);
    }
    assert.match(lib, /if \(!me\.is_admin\) throw new Error\('admin privileges required'\)/);
  });
});
