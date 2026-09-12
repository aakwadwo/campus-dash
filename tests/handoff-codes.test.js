import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  LOCATIONS,
} from './helpers/db.js';
import {
  acceptedOrder,
  orderReadyForDispatch,
  partnerAccept,
  partnerConfirmPickup,
  tryTransition,
  getOrder,
  getSecrets,
  payOrder,
  vendorReady,
  expectRejection,
} from './helpers/flow.js';

/**
 * The three handoff codes.
 *
 * ALL FOUR DIGITS, all generated server-side, all compared server-side, and all
 * travelling in the SAME direction from the same rule: the person who holds the
 * secret is never the person who performs the act.
 *
 *   VENDOR reads out   -> PARTNER types in   (collection)
 *   CUSTOMER reads out -> PARTNER types in   (delivery)
 *   CUSTOMER reads out -> VENDOR types in    (self-collection)
 *
 * Four digits is ten thousand guesses, which is minutes of scripted requests —
 * so each side counts its failures and locks out. That counter is the other
 * half of the argument for four digits, and most of this file is about it.
 */
describe('four-digit handoff codes', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  const FOUR_DIGITS = /^\d{4}$/;

  async function setAttemptLimit(limit, lockoutSeconds = 300) {
    await asService((c) =>
      c.query(
        'update public.pricing_config set code_attempt_limit = $1, code_lockout_seconds = $2',
        [limit, lockoutSeconds]
      )
    );
  }

  function secretsRow(orderId) {
    return asService(
      async (c) =>
        (await c.query('select * from public.order_secrets where order_id = $1', [orderId])).rows[0]
    );
  }

  /** A paid, READY pickup order — the third handoff direction. */
  async function readyPickupOrder() {
    const order = await acceptedOrder({ fulfilment: 'PICKUP' });
    await payOrder(order.order_id);
    await vendorReady(order.order_id);
    return order;
  }

  // =========================================================================
  // Shape
  // =========================================================================

  test('every generated code is exactly four digits', async () => {
    // A hundred draws, because a generator that occasionally drops a leading
    // zero produces a three-digit code roughly one time in ten.
    const codes = await asService(async (c) =>
      (
        await c.query('select public.generate_numeric_code(4) as code from generate_series(1, 100)')
      ).rows.map((r) => r.code)
    );

    for (const code of codes) assert.match(code, FOUR_DIGITS);
    assert.ok(
      codes.some((code) => code.startsWith('0')),
      'leading zeros are kept, not trimmed into a three-digit code'
    );
  });

  test('the columns refuse anything that is not four digits', async () => {
    const order = await orderReadyForDispatch();
    for (const bad of ['123', '12345', 'abcd', '12 4', '']) {
      const error = await expectRejection(
        asService((c) =>
          c.query('update public.order_secrets set pickup_code = $1 where order_id = $2', [
            bad,
            order.order_id,
          ])
        )
      );
      assert.match(error.message, /pickup_code_format/, `refused ${JSON.stringify(bad)}`);
    }
  });

  test('assignment issues four digits for both directions', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const secrets = await getSecrets(order.order_id);
    assert.match(secrets.pickup_code, FOUR_DIGITS);
    assert.match(secrets.delivery_code, FOUR_DIGITS);
    assert.notEqual(secrets.pickup_code, secrets.delivery_code, 'two secrets, not one');
  });

  test('a self-collection code is four digits, held by the STORE', async () => {
    const order = await readyPickupOrder();

    const code = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as c', [order.order_id])).rows[0].c
    );
    assert.match(code, FOUR_DIGITS);

    // And the CUSTOMER is the one who types it in — the same rule as the
    // Partner handoff, with the store on the holding side.
    const wrong = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_complete_pickup($1, $2)',
      [order.order_id, code === '0000' ? '1111' : '0000']
    );
    assert.equal(wrong.success, false);

    const right = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_complete_pickup($1, $2)',
      [order.order_id, code]
    );
    assert.equal(right.success, true);
    assert.equal((await getOrder(order.order_id)).order_status, 'COMPLETED');
  });

  test('the collector is never shown their own code, on either side', async () => {
    const collection = await readyPickupOrder();

    // A customer collecting has no function that returns the code they are
    // about to be asked for. If they had one, the code would prove nothing.
    const asCustomer = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.vendor_handoff_code($1)', [collection.order_id])
      )
    );
    assert.match(asCustomer.message, /not authorised for this order/);

    const view = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select * from public.customer_order_detail($1)', [collection.order_id]))
          .rows[0]
    );
    assert.ok(!('pickup_code' in view), 'not in the read model either');
  });

  // =========================================================================
  // Wrong codes
  // =========================================================================

  test('a reversed pickup code is refused, and the order does not move', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const { pickup_code: code } = await getSecrets(order.order_id);

    const reversed = code.split('').reverse().join('');
    if (reversed !== code) {
      const result = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, reversed);
      assert.equal(result.success, false);
      assert.match(result.reason, /does not match/i);
      assert.equal((await getOrder(order.order_id)).delivery_status, 'ASSIGNED');
    }
  });

  test('a reversed delivery code is refused, and the order does not complete', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, secrets.pickup_code);

    const reversed = secrets.delivery_code.split('').reverse().join('');
    if (reversed !== secrets.delivery_code) {
      const result = await tryTransition(
        ACTORS.partnerYaw,
        'select public.partner_complete_delivery($1, $2)',
        [order.order_id, reversed]
      );
      assert.equal(result.success, false);
      assert.equal((await getOrder(order.order_id)).order_status, 'READY', 'nothing completed');
    }
  });

  test('the other order’s code does not open this one', async () => {
    const mine = await orderReadyForDispatch();
    const theirs = await orderReadyForDispatch();
    await partnerAccept(mine.order_id, ACTORS.partnerYaw);
    await partnerAccept(theirs.order_id, ACTORS.partnerYaw);

    const theirSecrets = await getSecrets(theirs.order_id);
    const result = await partnerConfirmPickup(
      mine.order_id,
      ACTORS.partnerYaw,
      theirSecrets.pickup_code
    );
    // A collision is possible one time in ten thousand; the assertion is about
    // the code being checked per order, not about two random draws differing.
    const mineSecrets = await getSecrets(mine.order_id);
    if (theirSecrets.pickup_code !== mineSecrets.pickup_code) {
      assert.equal(result.success, false);
    }
  });

  // =========================================================================
  // Brute force
  // =========================================================================

  test('repeated wrong pickup codes lock the handoff out', async () => {
    await setAttemptLimit(3);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const { pickup_code: real } = await getSecrets(order.order_id);

    const wrong = (n) => String((Number(real) + n + 1) % 10000).padStart(4, '0');

    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, wrong(i));
      assert.equal(last.success, false);
    }
    assert.match(last.reason, /too many wrong codes/i, 'the third failure locks it');

    // AND THE RIGHT CODE IS NOW REFUSED TOO. A lockout that let the correct
    // answer through would be an oracle: an attacker would learn they had
    // guessed right from the fact that it worked.
    const withReal = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, real);
    assert.equal(withReal.success, false);
    assert.match(withReal.reason, /too many wrong codes/i);
    assert.equal((await getOrder(order.order_id)).delivery_status, 'ASSIGNED');
  });

  test('the lockout expires, and the count starts again', async () => {
    await setAttemptLimit(3, 30);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const { pickup_code: real } = await getSecrets(order.order_id);
    const wrong = (n) => String((Number(real) + n + 1) % 10000).padStart(4, '0');

    for (let i = 0; i < 3; i += 1) {
      await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, wrong(i));
    }
    assert.ok((await secretsRow(order.order_id)).pickup_locked_until, 'locked');

    // Wind the clock rather than waiting five minutes.
    await asService((c) =>
      c.query(
        "update public.order_secrets set pickup_locked_until = now() - interval '1 second' where order_id = $1",
        [order.order_id]
      )
    );

    const result = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, real);
    assert.equal(result.success, true, 'the genuine Partner is not locked out forever');

    const after = await secretsRow(order.order_id);
    assert.equal(after.pickup_attempts, 0, 'success clears the count');
    assert.equal(after.pickup_locked_until, null);
  });

  test('a correct code clears the failures before it', async () => {
    await setAttemptLimit(5);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const { pickup_code: real } = await getSecrets(order.order_id);
    const wrong = String((Number(real) + 7) % 10000).padStart(4, '0');

    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, wrong);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, wrong);
    assert.equal((await secretsRow(order.order_id)).pickup_attempts, 2);

    const ok = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, real);
    assert.equal(ok.success, true);
    assert.equal((await secretsRow(order.order_id)).pickup_attempts, 0);
  });

  test('the delivery code has its own budget, independent of the pickup code', async () => {
    await setAttemptLimit(3);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const secrets = await getSecrets(order.order_id);
    await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, secrets.pickup_code);

    const wrong = (n) => String((Number(secrets.delivery_code) + n + 1) % 10000).padStart(4, '0');

    for (let i = 0; i < 3; i += 1) {
      const result = await tryTransition(
        ACTORS.partnerYaw,
        'select public.partner_complete_delivery($1, $2)',
        [order.order_id, wrong(i)]
      );
      assert.equal(result.success, false);
    }

    const row = await secretsRow(order.order_id);
    assert.equal(row.delivery_attempts, 3, 'the delivery side counted');
    assert.equal(row.pickup_attempts, 0, 'and the pickup side is untouched');
    assert.ok(row.delivery_locked_until);
    assert.equal(row.pickup_locked_until, null);
  });

  test('a new assignment starts a new Partner on a clean slate', async () => {
    await setAttemptLimit(3);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const { pickup_code: first } = await getSecrets(order.order_id);
    const wrong = (n) => String((Number(first) + n + 1) % 10000).padStart(4, '0');

    for (let i = 0; i < 3; i += 1) {
      await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, wrong(i));
    }
    assert.ok((await secretsRow(order.order_id)).pickup_locked_until, 'locked out');

    // The first Partner gives up; a second takes the order.
    await asUser(
      ACTORS.partnerYaw,
      (c) => c.query('select public.partner_cancel_delivery($1, $2)', [order.order_id, 'gave up']),
      { commit: true }
    );
    await partnerAccept(order.order_id, ACTORS.partnerAdjoa);

    const after = await secretsRow(order.order_id);
    assert.equal(after.pickup_attempts, 0, 'a fresh code brings a fresh budget');
    assert.equal(after.pickup_locked_until, null);
    assert.notEqual(after.pickup_code, first, 'and the old code is dead');

    const ok = await partnerConfirmPickup(order.order_id, ACTORS.partnerAdjoa, after.pickup_code);
    assert.equal(ok.success, true, 'the new Partner is not paying for the old one’s mistakes');
  });

  test('the self-collection code is rate limited too', async () => {
    await setAttemptLimit(3);
    const order = await readyPickupOrder();
    const code = await asUser(
      ACTORS.vendor1Staff,
      async (c) =>
        (await c.query('select public.vendor_handoff_code($1) as c', [order.order_id])).rows[0].c
    );
    const wrong = (n) => String((Number(code) + n + 1) % 10000).padStart(4, '0');

    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await tryTransition(
        ACTORS.customerAma,
        'select public.customer_complete_pickup($1, $2)',
        [order.order_id, wrong(i)]
      );
      assert.equal(last.success, false);
    }
    assert.match(last.reason, /too many wrong codes/i);
    assert.equal((await getOrder(order.order_id)).order_status, 'READY', 'nothing completed');

    // THE LOCKOUT REFUSES THE CORRECT CODE TOO. One that let it through would
    // be an oracle telling an attacker they had finally guessed right.
    const correct = await tryTransition(
      ACTORS.customerAma,
      'select public.customer_complete_pickup($1, $2)',
      [order.order_id, code]
    );
    assert.equal(correct.success, false);
    assert.match(correct.reason, /too many wrong codes/i);
  });

  // =========================================================================
  // Who may attempt at all
  // =========================================================================

  test('an unassigned Partner cannot even spend an attempt', async () => {
    await setAttemptLimit(3);
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    // Adjoa is a real, approved Partner — and not this order's. The refusal
    // comes BEFORE the code is compared, so she cannot lock Yaw out of a
    // delivery he is carrying by guessing at it.
    for (let i = 0; i < 5; i += 1) {
      const error = await expectRejection(
        asUser(ACTORS.partnerAdjoa, (c) =>
          c.query('select public.partner_confirm_pickup($1, $2)', [order.order_id, '0000'])
        )
      );
      assert.match(error.message, /not assigned to you/i);
    }

    const row = await secretsRow(order.order_id);
    assert.equal(row.pickup_attempts, 0, 'a stranger never touches the counter');
    assert.equal(row.pickup_locked_until, null);

    const { pickup_code } = await getSecrets(order.order_id);
    const ok = await partnerConfirmPickup(order.order_id, ACTORS.partnerYaw, pickup_code);
    assert.equal(ok.success, true, 'and the real Partner is unaffected');
  });

  test('no client role can read a code out of the table', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    for (const actor of [ACTORS.partnerYaw, ACTORS.customerAma, ACTORS.vendor1Staff]) {
      const error = await expectRejection(
        asUser(actor, (c) => c.query('select * from public.order_secrets'))
      );
      assert.match(error.message, /permission denied/i);
    }
  });

  test('there is no function that shows a Partner a pickup code', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    // The one function that returns a handoff code is the STORE'S, behind
    // is_vendor_staff. A Partner asking for it is refused.
    const asVendorCode = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select public.vendor_handoff_code($1)', [order.order_id])
      )
    );
    assert.match(asVendorCode.message, /not authorised|insufficient/i);

    // And the read model a Partner DOES have carries no code at all.
    const job = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.partner_active_delivery()')).rows[0]
    );
    assert.ok(!JSON.stringify(job).includes('code'), 'nothing code-shaped reaches a Partner');
  });

  test('a customer sees the delivery code only while a Partner is carrying it', async () => {
    const order = await orderReadyForDispatch({ destination: LOCATIONS.room204 });

    const beforeAssignment = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query('select public.get_my_delivery_code($1)', [order.order_id])
      )
    );
    assert.match(beforeAssignment.message, /no delivery code available/i);

    await partnerAccept(order.order_id, ACTORS.partnerYaw);
    const code = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (await c.query('select public.get_my_delivery_code($1) as c', [order.order_id])).rows[0].c
    );
    assert.match(code, FOUR_DIGITS);

    // Somebody else's order tells them nothing.
    const notMine = await expectRejection(
      asUser(ACTORS.customerKwesi, (c) =>
        c.query('select public.get_my_delivery_code($1)', [order.order_id])
      )
    );
    assert.match(notMine.message, /no delivery code available/i);
  });

  test('the attempt counter itself is unreachable and unwritable by a client', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('update public.order_secrets set pickup_attempts = 0 where order_id = $1', [
          order.order_id,
        ])
      )
    );
    assert.match(error.message, /permission denied/i);

    // And the comparison function is server-only: a client that could call it
    // would have an oracle for the code it is supposed to be told out loud.
    const callable = await asService(
      async (c) =>
        (
          await c.query(
            `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as ok
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'check_handoff_code'`
          )
        ).rows[0].ok
    );
    assert.equal(callable, false);
  });
});
