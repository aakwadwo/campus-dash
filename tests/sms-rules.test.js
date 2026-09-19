import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSms } from '../lib/notifications/templates.js';
import { NOTIFICATION_EVENT as E, AUDIENCE as A } from '../lib/notifications/events.js';

/**
 * WHO GETS TEXTED, AS A SPECIFICATION.
 *
 * Every other notification test asks whether a message renders. This one asks
 * whether it should exist at all, because the failure being guarded against is
 * not a broken template — it is a working template nobody wanted.
 *
 * THE RULE. A message is sent only when somebody has to DO something they would
 * not otherwise know about, and only to the person who has to do it. Everything
 * else is on the screen belonging to that person, live, and a text duplicating a
 * screen they are already watching is noise they pay attention for.
 *
 * The lists below are the whole policy. A new template that quietly adds an
 * audience fails here, which is the point: SMS is the one part of this product
 * that reaches somebody whether or not they asked, and it should be hard to add
 * to by accident.
 */
const context = {
  orderNumber: '007',
  vendorName: 'Test Kitchen One',
  partnerName: 'Kwame',
  customerName: 'Ama',
  orderSummary: '2x Jollof Rice',
  itemCount: 2,
  totalPesewas: 9700,
  earningsPesewas: 500,
  amountPesewas: 2000,
  deliveryCode: '4821',
  destinationLabel: 'Hostel A',
  appUrl: 'https://example.test',
  storeName: 'Test Kitchen One',
};

const notifySource = readFileSync(new URL('../lib/orders/notify.js', import.meta.url), 'utf8');

/** The audience list configured for one event, read from the source of truth. */
function audiencesFor(event) {
  const marker = `[NOTIFICATION_EVENT.${event}]:`;
  const start = notifySource.indexOf(marker);
  assert.notEqual(start, -1, `${event} has no audience entry at all`);
  const line = notifySource.slice(start + marker.length, notifySource.indexOf(',\n', start) + 1);
  return ['CUSTOMER', 'VENDOR', 'PARTNER'].filter((a) => line.includes(`AUDIENCE.${a}`));
}

describe('SMS rules', () => {
  // =========================================================================
  // THE PARTNER
  // =========================================================================
  describe('the Partner', () => {
    /**
     * THREE MESSAGES, AND ONLY THREE. Approval and the offer broadcast are
     * sent from lib/notifications/dispatch.js rather than from an order
     * transition, so they are asserted by their templates existing.
     */
    test('is told they are approved, that work exists, and that their order is ready', () => {
      assert.ok(renderSms(E.PARTNER_APPROVED, A.PARTNER, context), 'approved');
      assert.ok(renderSms(E.DELIVERY_AVAILABLE, A.PARTNER, context), 'work is available');
      assert.ok(
        renderSms(E.ORDER_READY, A.PARTNER, { ...context, isPickup: false }),
        'an order they hold is ready to collect'
      );
    });

    test('is NOT told about their own accept, collect or complete', () => {
      // Each of these is something the Partner just did, on a screen, in front
      // of the other party. Being texted about your own tap is the purest form
      // of the noise this policy exists to remove.
      assert.equal(audiencesFor('PARTNER_ASSIGNED').includes('PARTNER'), false, 'accepting');
      assert.deepEqual(audiencesFor('PARTNER_PICKED_UP'), [], 'collecting — nobody at all');
      assert.deepEqual(audiencesFor('DELIVERY_COMPLETED'), [], 'completing — nobody at all');
    });

    test('is NOT told that GH5 landed, because a balance belongs on a dashboard', () => {
      assert.equal(renderSms(E.DELIVERY_COMPLETED, A.PARTNER, context), null);
    });

    /**
     * NOR IS THEY TOLD WHEN THE WEEK IS SETTLED. A vendor is a business
     * reconciling a bank account and wants the notice; a Partner is a student
     * who is paid weekly and has every delivery and the running total on the
     * dashboard they already look at. The message could not even say how the
     * money arrived — an administrator settles Partners by hand.
     */
    test('is NOT texted about a payout, though a store still is', () => {
      assert.equal(renderSms(E.PAYOUT_SENT, A.PARTNER, context), null, 'no Partner template');
      assert.ok(renderSms(E.PAYOUT_SENT, A.VENDOR, context), 'the store keeps theirs');
    });

    /**
     * And the removal is in the TEMPLATES, not in a branch at the call site.
     * notifyPayoutSent() still addresses whichever payee the payout names and
     * lets the missing template drop it, so there is one place that decides who
     * hears about what.
     */
    test('and the dispatcher was not taught a second copy of that rule', () => {
      const dispatch = readFileSync(
        new URL('../lib/notifications/dispatch.js', import.meta.url),
        'utf8'
      );
      const start = dispatch.indexOf('export async function notifyPayoutSent(');
      const body = dispatch.slice(start, dispatch.indexOf('\n}', start));

      assert.doesNotMatch(body, /PARTNER/, 'it does not branch on the payee type');
      assert.match(body, /recipient\.payee_type/, 'it addresses whoever the payout names');
    });

    test('is NOT told when they cancel — the order is re-offered instead', () => {
      // partner_cancel_delivery used to announce ORDER_CANCELLED, whose
      // audience is the customer and the store. See lib/partner/index.js.
      const partnerSource = readFileSync(
        new URL('../lib/partner/index.js', import.meta.url),
        'utf8'
      );
      const start = partnerSource.indexOf('export async function cancelDelivery(');
      const body = partnerSource.slice(start, partnerSource.indexOf('\n}', start));

      assert.doesNotMatch(
        body,
        /ORDER_CANCELLED/,
        'a Partner changing their mind does not cancel anybody’s lunch'
      );
      assert.match(body, /notifyPartnersOfOffer/, 'it re-broadcasts to everyone eligible');
    });
  });

  // =========================================================================
  // THE CUSTOMER
  // =========================================================================
  describe('the customer', () => {
    test('is NOT texted that a payment succeeded', () => {
      assert.equal(audiencesFor('PAYMENT_CONFIRMED').includes('CUSTOMER'), false);
      assert.equal(renderSms(E.PAYMENT_CONFIRMED, A.CUSTOMER, context), null);
    });

    test('is NOT texted that a Partner order is ready, or on the way, or delivered', () => {
      assert.equal(
        renderSms(E.ORDER_READY, A.CUSTOMER, { ...context, isPickup: false }),
        null,
        'ready — they are not walking anywhere'
      );
      assert.deepEqual(audiencesFor('PARTNER_PICKED_UP'), [], 'on the way');
      assert.deepEqual(audiencesFor('DELIVERY_COMPLETED'), [], 'delivered');
    });

    /**
     * A COLLECTION IS THE EXCEPTION, and the only one. Somebody about to walk
     * to a counter genuinely does not know when to set off, and the code they
     * will be asked for does not exist until this moment.
     */
    test('IS texted when their own collection is ready', () => {
      const message = renderSms(E.ORDER_READY, A.CUSTOMER, { ...context, isPickup: true });
      assert.ok(message);
      assert.match(message, /ready/i);
      assert.match(message, /4-digit code/, 'and how the handoff will work');
    });

    /**
     * The one Partner-order message that survives, and it survives for the fact
     * rather than for the code. Until somebody accepts, nothing on the tracking
     * page moves and there is nothing to look at; "Kwame has accepted" is the
     * thing the customer cannot know without being told.
     *
     * IT CARRIES NO CODE. It used to end "Your code is 4821", which put a
     * handoff secret in a message that is forwardable, screenshottable and
     * permanent, and that outlives the delivery by months. The delivery code is
     * on the tracking screen, behind the customer's own session.
     */
    test('IS texted when a Partner accepts, and told only that it was accepted', () => {
      assert.deepEqual(audiencesFor('PARTNER_ASSIGNED'), ['CUSTOMER']);
      const message = renderSms(E.PARTNER_ASSIGNED, A.CUSTOMER, context);
      assert.match(message, /Kwame/, 'a first name');
      assert.match(message, /accepted/i, 'and what happened');
      // THE LINK, not the words "the app". It is the same appUrl every other
      // message that sends somebody to a screen already carries, and on a phone
      // it is the difference between a tap and going to look for the app.
      assert.match(message, /Open https:\/\/example\.test to view/, 'and a tappable way there');
      assert.ok(message.includes(context.appUrl), 'the URL comes from the context');
      assert.doesNotMatch(message, /\b4821\b/, 'NEVER the delivery code');
      assert.doesNotMatch(message, /\bcode\b/i, 'and no mention of one to forward');
      assert.doesNotMatch(message, /\+233/, 'never a phone number');
    });

    /**
     * The Partner is not texted a second time for having just pressed accept.
     * There is no PARTNER template for this event, so the audience resolves to
     * a skip rather than to a message.
     */
    test('the Partner is NOT texted about their own acceptance', () => {
      assert.equal(audiencesFor('PARTNER_ASSIGNED').includes('PARTNER'), false);
      assert.equal(renderSms(E.PARTNER_ASSIGNED, A.PARTNER, context), null);
    });
  });

  // =========================================================================
  // THE STORE
  // =========================================================================
  describe('the store', () => {
    test('IS texted when a paid order arrives, and told nothing about who collects it', () => {
      assert.deepEqual(audiencesFor('PAYMENT_CONFIRMED'), ['VENDOR']);
      for (const isPickup of [true, false]) {
        const message = renderSms(E.PAYMENT_CONFIRMED, A.VENDOR, { ...context, isPickup });
        assert.match(message, /PAID/);
        assert.doesNotMatch(message, /collection|delivery|partner|customer/i);
      }
    });

    test('is NOT texted when a Partner is assigned or collects', () => {
      assert.equal(audiencesFor('PARTNER_ASSIGNED').includes('VENDOR'), false);
      assert.equal(renderSms(E.PARTNER_ASSIGNED, A.VENDOR, context), null);
      assert.deepEqual(audiencesFor('PARTNER_PICKED_UP'), []);
    });

    test('IS still texted when an order is genuinely cancelled', () => {
      assert.ok(audiencesFor('ORDER_CANCELLED').includes('VENDOR'));
      assert.match(renderSms(E.ORDER_CANCELLED, A.VENDOR, context), /cancelled/i);
    });

    test('is never told a Partner’s earnings on an ORDER message', () => {
      // PAYOUT_SENT is excluded deliberately: that one is about the STORE's own
      // settlement and naming an amount is the whole point of it.
      for (const event of Object.values(E)) {
        if (event === E.PAYOUT_SENT) continue;
        const message = renderSms(event, A.VENDOR, context);
        if (!message) continue;
        assert.doesNotMatch(
          message,
          /earn|GHS 5\.00/i,
          `${event} tells the store something about a Partner's money`
        );
      }
    });
  });

  // =========================================================================
  // THE WHOLE SURFACE
  // =========================================================================
  test('no message carries a phone number, a surname or EITHER handoff code', () => {
    // BOTH CODES, and the delivery one is the addition. It used to be rendered
    // on purpose in PARTNER_ASSIGNED, so the base context's 4821 could not be
    // asserted against here; now that no template may carry either, both are
    // planted and both are checked. All three handoff codes are four digits and
    // none of them belongs in something forwardable.
    const withSecrets = {
      ...context,
      customerPhone: '+233201234567',
      pickupCode: '1234',
      deliveryCode: '4821',
      partnerName: 'Kwame',
    };

    for (const event of Object.values(E)) {
      for (const audience of Object.values(A)) {
        const message = renderSms(event, audience, withSecrets);
        if (!message) continue;
        assert.doesNotMatch(message, /\+233\d/, `${event} -> ${audience} carries a phone number`);
        // A four-digit secret, not the words. "your pickup code is no longer
        // valid" names no code and is the right thing to say.
        assert.doesNotMatch(
          message,
          /\b(pickup|handoff|delivery) code is \d{4}\b/i,
          `${event} -> ${audience} carries a handoff code`
        );
        assert.doesNotMatch(message, /\b1234\b/, `${event} -> ${audience} leaked the pickup code`);
        assert.doesNotMatch(
          message,
          /\b4821\b/,
          `${event} -> ${audience} leaked the delivery code`
        );
      }
    }
  });

  /**
   * The whole point of the trim, stated as a number. One Partner order used to
   * generate eight order-scoped messages across three people. It now generates
   * three, and each one tells somebody something they could not otherwise know:
   * the store that money arrived, the customer that somebody has taken their
   * order, and the Partner that the order they are already holding is ready to
   * collect.
   */
  test('one Partner order generates three order-scoped messages, not eight', () => {
    const events = [
      'PAYMENT_CONFIRMED',
      'ORDER_READY',
      'PARTNER_ASSIGNED',
      'PARTNER_PICKED_UP',
      'DELIVERY_COMPLETED',
    ];

    let total = 0;
    for (const event of events) {
      for (const audience of audiencesFor(event)) {
        // A Partner order: isPickup false, and a Partner exists.
        const message = renderSms(E[event], A[audience], { ...context, isPickup: false });
        if (message) total += 1;
      }
    }

    assert.equal(
      total,
      3,
      'the store hears it is paid, the customer hears it was accepted, the Partner hears it is ready'
    );
  });
});
