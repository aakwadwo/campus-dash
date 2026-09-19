import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recipientOf } from '../lib/sms/hook-recipient.js';

/**
 * Which number the Send SMS Hook texts.
 *
 * The regression: a phone-change code was sent to `user.phone`. For a customer
 * who signs in by email there is no such number, so opening a store could never
 * verify one; for an account that had one, the code went to the OLD handset.
 * Checked against local GoTrue: the payload carries the pending number as
 * `user.new_phone`.
 */
describe('send-sms hook recipient', () => {
  test('a sign-in code goes to the account’s number', () => {
    assert.equal(
      recipientOf({ user: { phone: '233200000011' }, sms: { otp: '1' } }),
      '233200000011'
    );
  });

  test('a phone change on an email account goes to the new number', () => {
    assert.equal(
      recipientOf({ user: { phone: '', new_phone: '233200000779' }, sms: { otp: '1' } }),
      '233200000779'
    );
  });

  test('a phone change named as one goes to the new number even with an old one', () => {
    assert.equal(
      recipientOf({
        user: { phone: '233200000021', new_phone: '233200000778' },
        sms: { otp: '1', sms_type: 'phone_change' },
      }),
      '233200000778'
    );
  });

  test('nothing to send to is null, not a guess', () => {
    assert.equal(recipientOf({ user: {}, sms: { otp: '1' } }), null);
    assert.equal(recipientOf(null), null);
  });
});
