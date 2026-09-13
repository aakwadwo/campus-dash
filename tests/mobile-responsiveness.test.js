import './helpers/local-supabase.js';

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { withRequestCookies } from './helpers/stubs/next-headers.mjs';
import {
  otpSession,
  sessionCookies,
  temporaryCustomer,
  temporaryVendor,
} from './helpers/sessions.js';
import { asService, resetTransactionalState, closePools, ACTORS, MENU } from './helpers/db.js';
import { submitOrder, payOrder, vendorReady, customerCollect } from './helpers/flow.js';

import { deferNotification } from '@/lib/notifications/defer';
import { processPaymentWebhook, resetPaymentWebhookThrottle } from '@/lib/payments/webhook';
import { resetPaymentProvider } from '@/lib/payments';
import { resetSmsProvider } from '@/lib/sms';
import { getCapabilities, getUser } from '@/lib/auth/session';
import { GET as orderStatus } from '@/app/api/vendor/orders/[orderId]/status/route.js';

/**
 * The mobile performance work, held to what it promised and to what it must
 * not have changed.
 *
 *   * Notifications left the critical path — and still go out, still once.
 *   * The vendor order screen has a narrow status read to watch — and it tells
 *     nobody but the store anything, and tells the store nothing about money.
 *   * Sign-in and capabilities are read once per render — and never shared
 *     between two requests.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

after(closePools);

// ============================================================================
// 1. Notifications run after the response
// ============================================================================
describe('notification work is deferred, not dropped', () => {
  test('outside a request it runs inline and is awaited, exactly as before', async () => {
    const calls = [];
    await deferNotification('TEST', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      calls.push('sent');
    });
    assert.deepEqual(calls, ['sent'], 'the caller waited for the task to finish');
  });

  test('a failing notification never fails the action that scheduled it', async () => {
    await assert.doesNotReject(
      deferNotification('TEST', async () => {
        throw new Error('Arkesel is down');
      })
    );
  });

  test('every SMS on a user-facing path is sent from inside deferNotification()', () => {
    // A call to one of the senders, not its import or its own definition.
    const call =
      /(?<![\w.])(notifyOrderEvent|notifyPartnersOfOffer|notifyVendorDecision|notifyPartnerDecision|notifyPayoutSent)\(/g;
    for (const path of [
      'lib/orders/transitions.js',
      'lib/partner/index.js',
      'lib/admin/index.js',
      'lib/payments/webhook.js',
    ]) {
      const source = read(path);
      const sites = [...source.matchAll(call)].filter(
        (m) =>
          !/(import|function)\s[^\n]*$/.test(
            source.slice(source.lastIndexOf('\n', m.index), m.index)
          )
      );
      assert.ok(sites.length > 0, `${path} still notifies somebody`);
      for (const site of sites) {
        // The nearest deferNotification( before the call, with no function
        // boundary in between, is the one it runs inside.
        const before = source.slice(0, site.index);
        const deferredAt = before.lastIndexOf('deferNotification(');
        const announcer = before.lastIndexOf('function announceAfter(');
        const insideDeferral =
          (deferredAt !== -1 && !/\n\}\n/.test(source.slice(deferredAt, site.index))) ||
          (announcer !== -1 && !/\n\}\n/.test(source.slice(announcer, site.index)));
        const line = source.slice(0, site.index).split('\n').length;
        assert.ok(insideDeferral, `${path}:${line} sends ${site[1]} before the response`);
      }
    }
  });

  test('deferral is still gated on the transition having succeeded', () => {
    const source = read('lib/orders/transitions.js');
    const announce = source.slice(source.indexOf('async function announce('));
    assert.match(
      announce.slice(0, announce.indexOf('\n}')),
      /if \(result\.success\) await deferNotification\(/
    );
  });
});

describe('a payment webhook still confirms first and notifies once', () => {
  const ORIGINAL = { payment: process.env.PAYMENT_PROVIDER, sms: process.env.SMS_PROVIDER };

  before(() => {
    process.env.PAYMENT_PROVIDER = 'fake';
    process.env.SMS_PROVIDER = 'fake';
    resetPaymentProvider();
    resetSmsProvider();
  });
  afterEach(resetTransactionalState);
  after(() => {
    for (const [name, value] of [
      ['PAYMENT_PROVIDER', ORIGINAL.payment],
      ['SMS_PROVIDER', ORIGINAL.sms],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetPaymentProvider();
    resetSmsProvider();
    resetPaymentWebhookThrottle();
  });

  test('PAID, then the store and the customer are told, and a replay tells nobody again', async () => {
    const order = await submitOrder({ fulfilment: 'PICKUP', destination: null });
    const payment = await asService(async (c) => {
      const { rows } = await c.query("select * from public.create_payment_intent($1, 'fake', $2)", [
        order.order_id,
        `mobile-${order.order_id}`,
      ]);
      return rows[0];
    });

    const event = JSON.stringify({
      eventId: `evt-${order.order_id}`,
      status: 'SUCCEEDED',
      providerTransactionId: `fake_txn_${payment.id}`,
      reference: payment.id,
      amountPesewas: payment.amount_pesewas,
    });
    const deliver = () =>
      processPaymentWebhook({
        provider: 'fake',
        rawBody: event,
        headers: { 'x-fake-signature': 'fake-signature' },
      });

    const first = await deliver();
    assert.equal(first.status, 200);

    const state = async () =>
      asService(async (c) => {
        const { rows: orders } = await c.query(
          'select payment_status, order_status from public.orders where id = $1',
          [order.order_id]
        );
        const { rows: sent } = await c.query(
          `select audience from public.notification_events
            where order_id = $1 and event = 'PAYMENT_CONFIRMED' and succeeded
            order by audience`,
          [order.order_id]
        );
        return { ...orders[0], audiences: sent.map((r) => r.audience) };
      });

    const afterFirst = await state();
    assert.equal(afterFirst.payment_status, 'PAID');
    assert.equal(afterFirst.order_status, 'PREPARING');
    assert.deepEqual(afterFirst.audiences, ['CUSTOMER', 'VENDOR']);

    const replay = await deliver();
    assert.equal(replay.status, 200, 'a redelivery is acknowledged');
    assert.deepEqual((await state()).audiences, ['CUSTOMER', 'VENDOR'], 'and sends nothing twice');
  });
});

// ============================================================================
// 2. The vendor order-status read
// ============================================================================
describe('the vendor order status endpoint', () => {
  let vendorCookies;
  let otherVendor;
  let otherVendorCookies;
  let customer;
  let customerCookies;

  before(async () => {
    const vendorEmail = await asService(async (c) => {
      const { rows } = await c.query('select email from auth.users where id = $1', [
        ACTORS.vendor1Staff,
      ]);
      return rows[0].email;
    });
    vendorCookies = sessionCookies(await otpSession(vendorEmail));
    otherVendor = await temporaryVendor();
    otherVendorCookies = sessionCookies(await otpSession(otherVendor.email));
    customer = await temporaryCustomer();
    customerCookies = sessionCookies(await otpSession(customer.email));
  });

  afterEach(resetTransactionalState);
  after(async () => {
    await otherVendor?.remove();
    await customer?.remove();
  });

  const ask = (cookies, orderId) =>
    withRequestCookies(cookies, async () => {
      const response = await orderStatus(new Request('http://local/status'), {
        params: Promise.resolve({ orderId }),
      });
      return { status: response.status, body: await response.json(), response };
    });

  async function orderAtTheCounter() {
    const order = await submitOrder({
      fulfilment: 'PICKUP',
      destination: null,
      items: [{ menu_item_id: MENU.jollof, quantity: 2 }],
    });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);
    return order.order_id;
  }

  test('the store reads four state fields, and no money at all', async () => {
    const orderId = await orderAtTheCounter();
    const { status, body, response } = await ask(vendorCookies, orderId);

    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      'delivery_status',
      'handoff_code_available',
      'order_status',
      'payment_status',
    ]);
    assert.equal(body.order_status, 'READY');
    assert.equal(body.handoff_code_available, true);
    assert.doesNotMatch(JSON.stringify(body), /pesewas|total|fee|earning|code"\s*:\s*"\d/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('server-timing') ?? '', /db;dur=.*total;dur=/);
  });

  test('it moves when the customer collects, which is what the screen waits for', async () => {
    const orderId = await orderAtTheCounter();
    await customerCollect(orderId);
    const { body } = await ask(vendorCookies, orderId);
    assert.equal(body.order_status, 'COMPLETED');
    assert.equal(body.handoff_code_available, false);
  });

  test('another store, the customer and a stranger are all refused', async () => {
    const orderId = await orderAtTheCounter();

    const other = await ask(otherVendorCookies, orderId);
    assert.equal(other.status, 404, 'another vendor cannot see it exists');

    const own = await ask(customerCookies, orderId);
    assert.equal(own.status, 404, 'a customer is not staff of this store');

    const stranger = await ask({}, orderId);
    assert.notEqual(stranger.status, 200);
    assert.equal(stranger.body.order_status, undefined);
  });
});

// ============================================================================
// 3. Once per render, never across requests
// ============================================================================
describe('request-scoped sign-in', () => {
  test('two requests with different sessions never share an answer', async () => {
    const one = await temporaryCustomer();
    const two = await temporaryVendor();
    try {
      const oneCookies = sessionCookies(await otpSession(one.email));
      const twoCookies = sessionCookies(await otpSession(two.email));

      const first = await withRequestCookies(oneCookies, () => getUser());
      const second = await withRequestCookies(twoCookies, () => getUser());
      const signedOut = await withRequestCookies({}, () => getCapabilities());

      assert.equal(first.id, one.id);
      assert.equal(second.id, two.id, 'the second request is not handed the first session');
      assert.equal(signedOut.authenticated, false, 'nor is a request with no session at all');

      const caps = await withRequestCookies(twoCookies, () => getCapabilities());
      assert.ok(caps.vendor_ids.includes(two.vendorId));
      assert.equal(Boolean(caps.can_order), false, 'a vendor is still not a shopper');
    } finally {
      await one.remove();
      await two.remove();
    }
  });
});

// ============================================================================
// 4. The request paths that were cut
// ============================================================================
describe('work removed from the tap path', () => {
  test('Mark Ready no longer reads the order back to choose a sentence', () => {
    const source = read('app/vendor/actions.js');
    const body = source.slice(source.indexOf('export async function markReadyAction('));
    assert.doesNotMatch(body.slice(0, body.indexOf('\n}')), /getOrderDetail/);
  });

  test('a won Partner accept redirects in the same response; a lost one still explains', () => {
    const source = read('app/partner/actions.js');
    const body = source.slice(source.indexOf('export async function acceptDeliveryAction('));
    const fn = body.slice(0, body.indexOf('\n}'));
    assert.match(fn, /if \(!result\.success\) return outcome\(result\)/);
    assert.match(fn, /redirect\(`\/partner\/delivery\?order=/);
    assert.ok(
      fn.indexOf('redirect(') > fn.indexOf('return fail(error);'),
      'redirect() throws, so it must come after the try/catch, not inside it'
    );
    assert.doesNotMatch(read('app/partner/offers/offer-list.js'), /router\.push\(/);
  });

  test('the vendor order screen watches the order while it is at the counter', () => {
    const source = read('app/vendor/[vendorId]/orders/[orderId]/order-actions.js');
    assert.match(source, /useStatusWatch\(/);
    assert.match(source, /\/api\/vendor\/orders\/\$\{order\.order_id\}\/status/);
    // Collection is shown from the server's answer, never optimistically.
    assert.match(source, /status\.order_status === 'COMPLETED'\) setCollected\(true\)/);

    const watch = read('app/use-status-watch.js');
    assert.match(watch, /visibilitychange/, 'paused while hidden, checked on return');
    assert.match(watch, /document\.hidden/);
  });

  test('Vercel runs the functions next to the database', () => {
    const vercel = JSON.parse(read('vercel.json'));
    assert.deepEqual(vercel.regions, ['dub1']);
  });
});
