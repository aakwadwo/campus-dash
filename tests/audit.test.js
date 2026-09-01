import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  resetTransactionalState,
  closePools,
  ACTORS,
  VENDORS,
} from './helpers/db.js';
import {
  submitOrder,
  partnerAccept,
  orderReadyForDispatch,
  expectRejection,
} from './helpers/flow.js';

describe('audit trail', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(closePools);

  // --- 12 ------------------------------------------------------------------
  test('an admin override writes an audit record with who, what, when and why', async () => {
    const order = await submitOrder();

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [
          order.order_id,
          'customer called: vendor closed early',
        ]),
      { commit: true }
    );

    const actions = await asService(
      async (c) =>
        (await c.query('select * from public.admin_actions order by created_at desc')).rows
    );
    assert.equal(actions.length, 1);
    const [action] = actions;

    assert.equal(action.admin_user_id, ACTORS.admin, 'WHO');
    assert.equal(action.action, 'ORDER_CANCEL', 'WHAT');
    assert.equal(action.target_type, 'order');
    assert.equal(action.target_id, order.order_id, 'WHICH');
    assert.equal(action.reason, 'customer called: vendor closed early', 'WHY');
    assert.ok(action.created_at, 'WHEN');
    assert.equal(action.before_state.order_status, 'SUBMITTED');
    assert.equal(action.after_state.order_status, 'CANCELLED');
  });

  test('every admin override type is audited', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    await asUser(
      ACTORS.admin,
      async (c) => {
        await c.query('select public.admin_reassign_delivery($1, $2)', [
          order.order_id,
          'partner unreachable',
        ]);
        await c.query('select public.admin_set_vendor_status($1, $2, $3)', [
          VENDORS.two,
          'SUSPENDED',
          'hygiene complaint under review',
        ]);
        await c.query('select public.admin_review_partner($1, $2, $3)', [
          ACTORS.applicantKofi,
          'APPROVED',
          'ID photo matches the live face photograph',
        ]);
        await c.query('select public.admin_complete_order($1, $2)', [
          order.order_id,
          'customer confirmed by phone',
        ]);
      },
      { commit: true }
    );

    const actions = await asService(async (c) =>
      (await c.query('select action from public.admin_actions order by id')).rows.map(
        (r) => r.action
      )
    );
    assert.deepEqual(actions, [
      'DELIVERY_REASSIGN',
      'VENDOR_STATUS_SUSPENDED',
      'PARTNER_APPROVED',
      'ORDER_COMPLETE',
    ]);
  });

  test('an override without a reason is refused by the database', async () => {
    const order = await submitOrder();
    const error = await expectRejection(
      asUser(ACTORS.admin, (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [order.order_id, 'x'])
      )
    );
    assert.match(error.message, /admin_actions_reason_check/);
  });

  test('the audit log is append-only: even a superuser cannot rewrite or delete it', async () => {
    const order = await submitOrder();
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_cancel_order($1, $2)', [
          order.order_id,
          'audit immutability test',
        ]),
      { commit: true }
    );

    const update = await expectRejection(
      asService((c) => c.query("update public.admin_actions set reason = 'rewritten'"))
    );
    assert.match(update.message, /append-only/);

    const del = await expectRejection(
      asService((c) => c.query('delete from public.admin_actions'))
    );
    assert.match(del.message, /append-only/);
  });

  test('the notification log accepts a delivery report and nothing else', async () => {
    // notification_events is append-only, and it stays that way — it is the
    // record of who was told what, and when. A provider delivery report is the
    // one exception: new information about a row that already exists, arriving
    // minutes later. The guard was narrowed to exactly that, so this pins down
    // what "narrowed" is allowed to mean.
    const id = await asService(async (c) => {
      const { rows } = await c.query(
        `insert into public.notification_events
           (event, audience, channel, recipient, succeeded, provider, correlation_id)
         values ('ORDER_ACCEPTED', 'CUSTOMER', 'SMS', '+233200000021', true, 'arkesel', $1)
         returning id`,
        [`audit-${Date.now()}`]
      );
      return rows[0].id;
    });

    // Permitted: the delivery report.
    await asService((c) =>
      c.query(
        `update public.notification_events
            set delivery_status = 'DELIVERED', delivery_updated_at = now(),
                provider_message_id = 'sms_1'
          where id = $1`,
        [id]
      )
    );

    // Forbidden: rewriting what was actually recorded about the send.
    for (const [column, value] of [
      ['recipient', "'+233209999999'"],
      ['succeeded', 'false'],
      ['event', "'ORDER_CANCELLED'"],
      ['error', "'invented'"],
    ]) {
      const rejected = await asService((c) =>
        c
          .query(`update public.notification_events set ${column} = ${value} where id = $1`, [id])
          .then(() => null)
          .catch((e) => e)
      );
      assert.ok(rejected, `${column} must not be rewritable`);
      assert.match(rejected.message, /append-only/);
    }

    // Forbidden: changing a provider id that was already recorded.
    const rewritten = await asService((c) =>
      c
        .query(
          `update public.notification_events set provider_message_id = 'sms_other' where id = $1`,
          [id]
        )
        .then(() => null)
        .catch((e) => e)
    );
    assert.ok(rewritten, 'provider_message_id must be write-once');
    assert.match(rewritten.message, /append-only/);

    // Forbidden: deletion, as before.
    const deleted = await asService((c) =>
      c
        .query('delete from public.notification_events where id = $1', [id])
        .then(() => null)
        .catch((e) => e)
    );
    assert.ok(deleted);
    assert.match(deleted.message, /append-only/);

    await asService((c) => c.query('truncate table public.notification_events'));
  });

  test('the order event log is append-only too', async () => {
    await submitOrder();
    const update = await expectRejection(
      asService((c) => c.query('update public.order_events set accepted = true'))
    );
    assert.match(update.message, /append-only/);
  });

  test('the full lifecycle of an order is reconstructable from its events', async () => {
    const order = await orderReadyForDispatch();
    await partnerAccept(order.order_id, ACTORS.partnerYaw);

    const events = await asService(async (c) =>
      (
        await c.query('select event from public.order_events where order_id = $1 order by id', [
          order.order_id,
        ])
      ).rows.map((r) => r.event)
    );

    assert.deepEqual(events, [
      'ORDER_SUBMITTED',
      'VENDOR_ACCEPT',
      'PAYMENT_INTENT_CREATED',
      'PAYMENT_CONFIRMED',
      'VENDOR_PREPARING',
      'VENDOR_READY',
      'DISPATCH_OPENED',
      'PARTNER_ACCEPT',
    ]);
  });

  test('an admin can read the audit log through the dedicated function; a customer cannot', async () => {
    const order = await submitOrder();
    await asUser(
      ACTORS.admin,
      (c) => c.query('select public.admin_cancel_order($1, $2)', [order.order_id, 'reading test']),
      { commit: true }
    );

    const rows = await asUser(
      ACTORS.admin,
      async (c) => (await c.query('select * from public.admin_list_actions(10)')).rows
    );
    assert.equal(rows.length, 1);

    const asCustomer = await asUser(
      ACTORS.customerAma,
      async (c) => (await c.query('select * from public.admin_list_actions(10)')).rows
    );
    assert.equal(asCustomer.length, 0, 'the function returns nothing for a non-admin');
  });

  test('approving a Partner records the reviewer and sets a document retention deadline', async () => {
    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3, $4)', [
          ACTORS.applicantKofi,
          'APPROVED',
          'ID matches face photo',
          'verified in person',
        ]),
      { commit: true }
    );

    const profile = await asService(
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.applicantKofi,
          ])
        ).rows[0]
    );
    assert.equal(profile.status, 'APPROVED');
    assert.equal(profile.reviewed_by, ACTORS.admin);
    assert.ok(profile.reviewed_at);
    assert.ok(profile.documents_purge_after, 'verification documents have a deletion deadline');
  });

  test('suspending a Partner stops them receiving offers immediately', async () => {
    const order = await orderReadyForDispatch();

    await asUser(
      ACTORS.admin,
      (c) =>
        c.query('select public.admin_review_partner($1, $2, $3)', [
          ACTORS.partnerYaw,
          'SUSPENDED',
          'reported for repeated no-shows',
        ]),
      { commit: true }
    );

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.equal(offers.length, 0);

    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.partnerYaw));
    assert.match(error.message, /not approved/);
  });
});
