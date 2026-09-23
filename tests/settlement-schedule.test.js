import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  settlementDay,
  payoutOutlook,
  payoutDayLabel,
  ghanaDayKey,
  isWorkingDay,
} from '@/lib/settlement/schedule';
import { ghanaHolidays, isGhanaHoliday } from '@/lib/settlement/ghana-holidays';

/**
 * WHEN A STORE'S MONEY ARRIVES.
 *
 * Paystack settles Ghana cedis to a subaccount on the next WORKING day, and a
 * working day is neither a weekend nor a Ghana public holiday. These are the
 * cases a store owner would check against their phone on a Monday.
 *
 * 2026 is used throughout because its dates are known: Friday 18 September,
 * Founders' Day on Monday 21 September, Good Friday 3 April and Easter Monday
 * 6 April.
 */
describe('the next working day', () => {
  test('Friday, Saturday and Sunday all settle on Monday', () => {
    assert.equal(settlementDay('2026-09-25'), '2026-09-28', 'Friday');
    assert.equal(settlementDay('2026-09-26'), '2026-09-28', 'Saturday');
    assert.equal(settlementDay('2026-09-27'), '2026-09-28', 'Sunday');
  });

  test('a weekday settles the next day', () => {
    assert.equal(settlementDay('2026-09-22'), '2026-09-23', 'Tuesday → Wednesday');
    assert.equal(settlementDay('2026-09-24'), '2026-09-25', 'Thursday → Friday');
  });

  test("a Monday public holiday moves the weekend's money to Tuesday", () => {
    // Founders' Day, Monday 21 September 2026.
    assert.ok(isGhanaHoliday('2026-09-21'));
    for (const day of ['2026-09-18', '2026-09-19', '2026-09-20']) {
      assert.equal(settlementDay(day), '2026-09-22', day);
    }
  });

  test('Easter: Thursday runs past Good Friday, the weekend and Easter Monday', () => {
    assert.ok(isGhanaHoliday('2026-04-03'), 'Good Friday');
    assert.ok(isGhanaHoliday('2026-04-06'), 'Easter Monday');
    assert.equal(settlementDay('2026-04-02'), '2026-04-07');
  });

  test('a holiday nobody has declared yet can be supplied, and is honoured', () => {
    // A hypothetical declaration: Monday 28 September 2026.
    const declared = { 2026: { add: { '2026-09-28': 'Declared holiday' } } };
    assert.equal(isWorkingDay('2026-09-28', declared), false);
    assert.equal(settlementDay('2026-09-25', declared), '2026-09-29');
  });

  test('a moved holiday is observed where it was moved to, not where it was', () => {
    // Constitution Day 2026 was declared for Friday 9 January.
    assert.equal(isGhanaHoliday('2026-01-07'), false);
    assert.equal(isGhanaHoliday('2026-01-09'), true);
  });

  test('a weekend holiday is observed on the next free weekday', () => {
    // Boxing Day 2026 is a Saturday.
    const days = ghanaHolidays(2026);
    assert.ok(days.has('2026-12-26'));
    assert.ok(days.has('2026-12-28'), 'observed on Monday');
    // Christmas Friday → Boxing Day Saturday → observed Monday → Tuesday.
    assert.equal(settlementDay('2026-12-24'), '2026-12-29');
  });

  test("Farmers' Day is the first Friday of December", () => {
    assert.ok(isGhanaHoliday('2026-12-04'));
    assert.ok(isGhanaHoliday('2027-12-03'));
  });
});

describe('what the store is shown', () => {
  // Saturday 26 September 2026, midday in Accra.
  const saturday = new Date('2026-09-26T12:00:00Z');

  test("Ghana's day is the calendar day in Accra", () => {
    assert.equal(ghanaDayKey(saturday), '2026-09-26');
    assert.equal(ghanaDayKey(new Date('2026-09-26T23:59:59Z')), '2026-09-26');
    assert.equal(ghanaDayKey(new Date('2026-09-27T00:00:01Z')), '2026-09-27');
  });

  test('Friday and Saturday sales are pending together, due Monday morning', () => {
    const outlook = payoutOutlook(
      [
        { paid_day: '2026-09-25', settlement_channel: 'SPLIT', amount_pesewas: 12000 },
        { paid_day: '2026-09-26', settlement_channel: 'SPLIT', amount_pesewas: 12000 },
      ],
      saturday
    );
    assert.equal(outlook.pendingPesewas, 24000, 'GH₵240.00');
    assert.equal(outlook.nextPayoutDay, '2026-09-28');
    assert.equal(payoutDayLabel(outlook.nextPayoutDay, saturday), 'Monday morning');
  });

  test('money due this morning or earlier is no longer pending', () => {
    // Monday 28 September: the weekend's money was due this morning.
    const monday = new Date('2026-09-28T10:00:00Z');
    const outlook = payoutOutlook(
      [
        { paid_day: '2026-09-25', settlement_channel: 'SPLIT', amount_pesewas: 5000 },
        { paid_day: '2026-09-27', settlement_channel: 'SPLIT', amount_pesewas: 5000 },
        { paid_day: '2026-09-28', settlement_channel: 'SPLIT', amount_pesewas: 3000 },
      ],
      monday
    );
    assert.equal(outlook.pendingPesewas, 3000, "only Monday's own sales");
    assert.equal(payoutDayLabel(outlook.nextPayoutDay, monday), 'Tomorrow morning');
  });

  test('ledger-owed money is reported apart, and never given a morning', () => {
    const outlook = payoutOutlook(
      [
        { paid_day: '2026-09-20', settlement_channel: 'TRANSFER', amount_pesewas: 4000 },
        { paid_day: '2026-09-26', settlement_channel: 'SPLIT', amount_pesewas: 1000 },
      ],
      saturday
    );
    assert.equal(outlook.heldPesewas, 4000);
    assert.equal(outlook.pendingPesewas, 1000);
    assert.equal(outlook.nextPayoutDay, '2026-09-28');

    const onlyHeld = payoutOutlook(
      [{ paid_day: '2026-09-20', settlement_channel: 'TRANSFER', amount_pesewas: 4000 }],
      saturday
    );
    assert.equal(onlyHeld.nextPayoutDay, null);
    assert.equal(onlyHeld.pendingPesewas, 0);
  });

  test('a morning more than a week away names the date', () => {
    const label = payoutDayLabel('2026-10-12', saturday);
    assert.match(label, /12 Oct, morning$/);
  });

  test('money is integer pesewas throughout', () => {
    const outlook = payoutOutlook(
      [{ paid_day: '2026-09-26', settlement_channel: 'SPLIT', amount_pesewas: '2085' }],
      saturday
    );
    assert.equal(outlook.pendingPesewas, 2085);
    assert.ok(Number.isInteger(outlook.pendingPesewas));
  });
});
