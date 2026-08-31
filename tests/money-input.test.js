import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pesewasFromCedisInput, cedisInputFromPesewas, formatPesewas } from '../lib/util/money.js';

/**
 * Price entry is where a human types money into the system. It is the one place
 * a float could sneak in, so it gets its own tests.
 */
describe('price input parsing', () => {
  test('whole cedis, one decimal and two decimals all work', () => {
    assert.equal(pesewasFromCedisInput('35'), 3500);
    assert.equal(pesewasFromCedisInput('35.5'), 3550);
    assert.equal(pesewasFromCedisInput('35.50'), 3550);
    assert.equal(pesewasFromCedisInput('0.05'), 5);
  });

  test('currency symbols, spaces and thousands separators are tolerated', () => {
    assert.equal(pesewasFromCedisInput('GH₵35.35'), 3535);
    assert.equal(pesewasFromCedisInput(' 35.35 '), 3535);
    assert.equal(pesewasFromCedisInput('1,200.99'), 120099);
  });

  test('THE FLOAT TRAP: prices that Math.floor(parseFloat(x) * 100) gets wrong', () => {
    // Each of these underprices the item by a pesewa under the naive approach.
    for (const [input, expected] of [
      ['0.29', 29],
      ['1.15', 115],
      ['2.55', 255],
      ['4.35', 435],
      ['19.99', 1999],
    ]) {
      assert.equal(pesewasFromCedisInput(input), expected, `${input} must parse exactly`);
      assert.notEqual(
        Math.floor(parseFloat(input) * 100),
        expected,
        `${input} is only a useful test case while the naive version still gets it wrong`
      );
    }
  });

  test('nonsense, negatives, zero and sub-pesewa precision are refused', () => {
    for (const bad of [
      '',
      '  ',
      'abc',
      '35.555',
      '-5',
      '0',
      '0.00',
      '3.5.2',
      '.5',
      null,
      undefined,
    ]) {
      assert.throws(
        () => pesewasFromCedisInput(bad),
        `${JSON.stringify(bad)} must be refused rather than coerced`
      );
    }
  });

  test('parsing and formatting round-trip exactly', () => {
    for (const pesewas of [1, 5, 99, 100, 3500, 3550, 120099, 999999]) {
      assert.equal(pesewasFromCedisInput(cedisInputFromPesewas(pesewas)), pesewas);
    }
  });

  test('every parsed value is a safe integer', () => {
    for (const input of ['35', '35.5', '0.01', '99999.99']) {
      const result = pesewasFromCedisInput(input);
      assert.ok(Number.isSafeInteger(result), `${input} produced ${result}`);
    }
  });

  test('display formatting matches what was entered', () => {
    assert.equal(formatPesewas(pesewasFromCedisInput('35.50')), 'GH₵35.50');
    assert.equal(formatPesewas(pesewasFromCedisInput('0.05')), 'GH₵0.05');
    assert.equal(formatPesewas(pesewasFromCedisInput('19.99')), 'GH₵19.99');
  });
});
