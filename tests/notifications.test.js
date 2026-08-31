import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSms } from '../lib/notifications/templates.js';
import { NOTIFICATION_EVENT, AUDIENCE } from '../lib/notifications/events.js';

/**
 * Notification wiring.
 *
 * The source-level checks below exist because of a real bug: the call that
 * announces a vendor transition was lost during an edit and nothing failed —
 * the app simply stopped telling customers their order had been accepted. No
 * database test could catch that, because the database was working perfectly.
 */
const transitionsSource = readFileSync(
  new URL('../lib/orders/transitions.js', import.meta.url),
  'utf8'
);
const notifySource = readFileSync(new URL('../lib/orders/notify.js', import.meta.url), 'utf8');

describe('order notifications', () => {
  test('every vendor transition announces its event', () => {
    const expected = {
      vendorAcceptOrder: 'ORDER_ACCEPTED',
      vendorRejectOrder: 'ORDER_REJECTED',
      vendorMarkPreparing: 'ORDER_PREPARING',
      vendorMarkReady: 'ORDER_READY',
    };

    for (const [fn, event] of Object.entries(expected)) {
      const start = transitionsSource.indexOf(`export async function ${fn}(`);
      assert.notEqual(start, -1, `${fn} should exist`);
      const body = transitionsSource.slice(start, transitionsSource.indexOf('\n}', start));
      assert.match(
        body,
        new RegExp(`announce\\([^)]*NOTIFICATION_EVENT\\.${event}`),
        `${fn} must announce ${event} — losing this call fails silently`
      );
    }
  });

  test('confirming a payment announces it', () => {
    const start = transitionsSource.indexOf('export async function confirmPayment(');
    const body = transitionsSource.slice(start, transitionsSource.indexOf('\n}', start));
    assert.match(body, /notifyOrderEvent\(NOTIFICATION_EVENT\.PAYMENT_CONFIRMED/);
  });

  test('announcing is conditional on the transition having actually happened', () => {
    const start = transitionsSource.indexOf('async function announce(');
    const body = transitionsSource.slice(start, transitionsSource.indexOf('\n}', start));
    assert.match(
      body,
      /if \(result\.success\)/,
      'a rejected transition must not tell the customer it succeeded'
    );
  });

  test('every event the vendor flow emits has an audience', () => {
    for (const event of [
      'ORDER_SUBMITTED',
      'ORDER_ACCEPTED',
      'ORDER_REJECTED',
      'ORDER_PREPARING',
      'ORDER_READY',
      'PAYMENT_CONFIRMED',
      'ORDER_CANCELLED',
    ]) {
      assert.match(
        notifySource,
        new RegExp(`NOTIFICATION_EVENT\\.${event}\\]:`),
        `${event} has no audience, so it would be emitted into nothing`
      );
    }
  });

  test('every configured audience has copy that renders', () => {
    const cases = [
      [NOTIFICATION_EVENT.ORDER_SUBMITTED, AUDIENCE.VENDOR],
      [NOTIFICATION_EVENT.ORDER_SUBMITTED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_ACCEPTED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_REJECTED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.PAYMENT_CONFIRMED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.PAYMENT_CONFIRMED, AUDIENCE.VENDOR],
      [NOTIFICATION_EVENT.ORDER_PREPARING, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_CANCELLED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_CANCELLED, AUDIENCE.VENDOR],
    ];

    const context = {
      orderNumber: 'CD-01234',
      vendorName: 'Test Kitchen One',
      totalPesewas: 9700,
      isPickup: false,
    };

    for (const [event, audience] of cases) {
      const message = renderSms(event, audience, context);
      assert.ok(message, `${event} -> ${audience} must have copy`);
      assert.ok(message.includes('CD-01234'), 'every message names the order');
      assert.ok(!message.includes('undefined'), `${event} -> ${audience} rendered "undefined"`);
      assert.ok(
        message.length <= 320,
        `${event} -> ${audience} is ${message.length} chars (2 segments max)`
      );
    }
  });

  test('READY copy differs for pickup and delivery', () => {
    const base = { orderNumber: 'CD-1', vendorName: 'Kitchen', totalPesewas: 100 };
    const pickup = renderSms(NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER, {
      ...base,
      isPickup: true,
    });
    const delivery = renderSms(NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER, {
      ...base,
      isPickup: false,
    });
    assert.match(pickup, /READY for pickup/);
    assert.match(delivery, /Finding a Partner/);
  });

  test('the vendor is never told a pickup code by SMS', () => {
    const templates = readFileSync(
      new URL('../lib/notifications/templates.js', import.meta.url),
      'utf8'
    );
    const start = templates.indexOf('[E.PARTNER_ASSIGNED]');
    const block = templates.slice(start, templates.indexOf('},', start));
    const vendorLine = block.slice(block.indexOf('[A.VENDOR]'), block.indexOf('[A.PARTNER]'));
    assert.ok(
      !vendorLine.includes('pickupCode'),
      'a vendor who knows the code could confirm a handoff that never happened'
    );
  });
});
