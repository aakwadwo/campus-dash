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
  /**
   * ONE VENDOR TRANSITION IS LEFT. Accept, reject and "start preparing" went
   * with the doorbell: an order reaches a store already paid for, and the only
   * thing the store says about it is that it is made.
   */
  test('every vendor transition announces its event', () => {
    const expected = {
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
    for (const event of ['ORDER_READY', 'PAYMENT_CONFIRMED', 'ORDER_CANCELLED']) {
      assert.match(
        notifySource,
        new RegExp(`NOTIFICATION_EVENT\\.${event}\\]:`),
        `${event} has no audience, so it would be emitted into nothing`
      );
    }
  });

  test('every configured audience has copy that renders', () => {
    const cases = [
      [NOTIFICATION_EVENT.ORDER_ACCEPTED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_REJECTED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.PAYMENT_CONFIRMED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.PAYMENT_CONFIRMED, AUDIENCE.VENDOR],
      [NOTIFICATION_EVENT.ORDER_PREPARING, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.PARTNER],
      [NOTIFICATION_EVENT.ORDER_CANCELLED, AUDIENCE.CUSTOMER],
      [NOTIFICATION_EVENT.ORDER_CANCELLED, AUDIENCE.VENDOR],
    ];

    // THE QUEUE NUMBER, which is what notifyOrderEvent now puts here. A store
    // calls out "007"; CD-01234 is a database key nobody reads down a phone.
    const context = {
      orderNumber: '007',
      vendorName: 'Test Kitchen One',
      totalPesewas: 9700,
      itemCount: 2,
      orderSummary: 'Jollof Rice and 1 more item',
      appUrl: 'https://example.test',
      isPickup: false,
    };

    for (const [event, audience] of cases) {
      const message = renderSms(event, audience, context);
      assert.ok(message, `${event} -> ${audience} must have copy`);
      // EVERY MESSAGE SAYS WHICH ORDER IT IS ABOUT — but not all of them do it
      // with the number. The payment confirmation names the FOOD, because a
      // queue number on a lock screen is a thing to go and look up while
      // "your Jollof Rice" is a thing you recognise. The number is still the
      // identifier inside the app, where the store is calling it out.
      const identifiesTheOrder = message.includes('007') || message.includes(context.orderSummary);
      assert.ok(identifiesTheOrder, `${event} -> ${audience} does not identify the order`);
      assert.ok(!message.includes('undefined'), `${event} -> ${audience} rendered "undefined"`);
      assert.ok(
        message.length <= 320,
        `${event} -> ${audience} is ${message.length} chars (2 segments max)`
      );
    }
  });

  /**
   * NOBODY IS TEXTED WHEN AN ORDER IS CREATED. It is not a ticket yet: nothing
   * has been paid, and the customer is looking at the pay button as it would
   * arrive. The store hears about it when the money does.
   */
  test('creating an order texts nobody, and paying for it texts the store', () => {
    assert.equal(
      renderSms(NOTIFICATION_EVENT.ORDER_SUBMITTED, AUDIENCE.VENDOR, { orderNumber: '007' }),
      null
    );
    assert.equal(
      renderSms(NOTIFICATION_EVENT.ORDER_SUBMITTED, AUDIENCE.CUSTOMER, { orderNumber: '007' }),
      null
    );

    const vendor = renderSms(NOTIFICATION_EVENT.PAYMENT_CONFIRMED, AUDIENCE.VENDOR, {
      orderNumber: '007',
      itemCount: 2,
      isPickup: false,
      appUrl: 'https://example.test',
    });
    assert.match(vendor, /PAID/);
    assert.match(vendor, /007/);
    assert.match(vendor, /https:\/\/example\.test\/vendor/, 'the store gets a way in');
    assert.doesNotMatch(vendor, /accept|reject/i, 'there is nothing left to accept');
  });

  test('READY copy differs for pickup and delivery', () => {
    const base = { orderNumber: '007', vendorName: 'Kitchen', totalPesewas: 100 };
    const pickup = renderSms(NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER, {
      ...base,
      isPickup: true,
    });
    const delivery = renderSms(NOTIFICATION_EVENT.ORDER_READY, AUDIENCE.CUSTOMER, {
      ...base,
      isPickup: false,
    });
    // A collection now ends with the customer typing in a code the store reads
    // out, and the message that says the food is ready is the one place to
    // explain that before they walk to a counter expecting to be handed it.
    assert.match(pickup, /4-digit code/);
    assert.match(delivery, /Partner is collecting/);
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
