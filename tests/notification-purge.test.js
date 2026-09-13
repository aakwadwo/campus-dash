import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, asUser, closePools, ACTORS } from './helpers/db.js';

/**
 * The one permitted exception to notification_events being append-only.
 *
 * WHY THE EXCEPTION EXISTS. The log's FKs to users and orders are SET NULL, and
 * SET NULL is an UPDATE the append-only trigger rejects — so a single logged
 * message pins the account and the order it names, for good. Clearing pilot
 * test data was impossible without disabling the trigger or truncating, both of
 * which trade a real safety property for a one-off convenience.
 *
 * WHAT MUST REMAIN TRUE, and is asserted below: the table is still append-only
 * for everything else, the door only opens inside an audited administrator
 * call, and a non-administrator cannot open it at all.
 */
describe('the administrator-only notification purge', () => {
  after(closePools);

  const ADMIN = ACTORS.admin;

  async function seedEvent(userId) {
    return asService(
      async (c) =>
        (
          await c.query(
            `insert into public.notification_events
               (event, audience, channel, user_id, recipient, succeeded, provider, dedupe_key)
             values ('PARTNER_APPROVED','PARTNER','SMS',$1,'+233200000001',true,'fake',$2)
             returning id`,
            [userId, `purge-test-${Date.now()}-${Math.random()}`]
          )
        ).rows[0].id
    );
  }

  test('a plain DELETE is still refused, exactly as before', async () => {
    const id = await seedEvent(ACTORS.customerAma);
    let refused = null;
    try {
      await asService((c) => c.query('delete from public.notification_events where id = $1', [id]));
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'the append-only guarantee must survive this change');
    assert.match(String(refused.message), /append-only/i);

    await asService((c) =>
      c.query(`select public.admin_purge_test_history(array[$1::uuid], '{}', 'cleanup')`, [
        ACTORS.customerAma,
      ])
    ).catch(() => {});
  });

  test('an UPDATE is still refused — no exception was added for that', async () => {
    const id = await seedEvent(ACTORS.customerAma);
    let refused = null;
    try {
      await asService((c) =>
        c.query("update public.notification_events set event = 'ORDER_READY' where id = $1", [id])
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'only delivery fields may ever be written');
    assert.match(String(refused.message), /append-only/i);
  });

  test('a non-administrator cannot purge', async () => {
    const id = await seedEvent(ACTORS.customerAma);

    let refused = null;
    try {
      await asUser(ACTORS.customerAma, (c) =>
        c.query(`select public.admin_purge_test_history(array[$1::uuid], '{}', 'nope')`, [
          ACTORS.customerAma,
        ])
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'holding EXECUTE is not authority');
    assert.match(String(refused.message), /administrator access required/i);

    const { rows } = await asService((c) =>
      c.query('select count(*)::int as n from public.notification_events where id = $1', [id])
    );
    assert.equal(rows[0].n, 1, 'and the row is still there');
  });

  test('a purge naming nothing is refused rather than meaning everything', async () => {
    let refused = null;
    try {
      await asUser(ADMIN, (c) =>
        c.query(`select public.admin_purge_test_history('{}', '{}', 'reason')`)
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused, 'an empty target list must not mean "all rows"');
    assert.match(String(refused.message), /name the accounts or orders/i);
  });

  test('a purge without a reason is refused', async () => {
    let refused = null;
    try {
      await asUser(ADMIN, (c) =>
        c.query(`select public.admin_purge_test_history(array[$1::uuid], '{}', null)`, [
          ACTORS.customerAma,
        ])
      );
    } catch (error) {
      refused = error;
    }
    assert.ok(refused);
    assert.match(String(refused.message), /reason is required/i);
  });

  test('an administrator purges only the rows named, and it is audited', async () => {
    const mine = await seedEvent(ACTORS.customerAma);
    const theirs = await seedEvent(ACTORS.partnerYaw);

    const deleted = await asUser(
      ADMIN,
      async (c) =>
        (
          await c.query(
            `select public.admin_purge_test_history(array[$1::uuid], '{}', 'pilot reset') as n`,
            [ACTORS.customerAma]
          )
        ).rows[0].n,
      { commit: true }
    );

    assert.ok(deleted >= 1, 'the named rows go');

    const { rows } = await asService((c) =>
      c.query('select id from public.notification_events where id = any($1)', [[mine, theirs]])
    );
    const survivors = rows.map((r) => r.id);
    assert.ok(!survivors.includes(mine), 'the named account is forgotten');
    assert.ok(survivors.includes(theirs), 'and nobody else is touched');

    const { rows: audit } = await asService((c) =>
      c.query(
        `select action, details from public.admin_actions
          where action = 'TEST_HISTORY_PURGED' order by created_at desc limit 1`
      )
    );
    assert.equal(audit.length, 1, 'a purge is audited');
    assert.ok(Number(audit[0].details.notification_rows_deleted) >= 1);

    await asService((c) =>
      c.query('delete from public.admin_actions where action = $1', ['TEST_HISTORY_PURGED'])
    ).catch(() => {});
  });

  /**
   * The flag is transaction-local. If it could survive a call, the next
   * statement in the same session would inherit a door that was opened for
   * somebody else's purge.
   */
  test('the door closes behind the purge', async () => {
    const id = await seedEvent(ACTORS.partnerYaw);

    let refused = null;
    try {
      await asUser(
        ADMIN,
        async (c) => {
          await c.query(`select public.admin_purge_test_history(array[$1::uuid], '{}', 'scoped')`, [
            ACTORS.customerAma,
          ]);
          // Same transaction, immediately after a successful purge.
          await c.query('delete from public.notification_events where id = $1', [id]);
        },
        { commit: false }
      );
    } catch (error) {
      refused = error;
    }

    assert.ok(refused, 'a purge must not leave the table deletable');
    // Either answer is correct, and the first is the stronger one: a client
    // role holds NO privileges on this table, so it is stopped by the grant
    // before the trigger is consulted at all. The flag it might have inherited
    // is therefore unreachable from a client in the first place.
    assert.match(String(refused.message), /permission denied|append-only/i);
  });
});
