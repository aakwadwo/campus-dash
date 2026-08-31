import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  asService,
  asUser,
  asAnon,
  resetTransactionalState,
  closePools,
  ACTORS,
} from './helpers/db.js';
import { expectRejection } from './helpers/flow.js';

/**
 * Terms acceptance.
 *
 * The point is that a checkbox proves nothing later. What matters is WHICH
 * version somebody agreed to, and when — so a new version makes the acceptance
 * outstanding again, and only that.
 */
describe('terms and conditions', () => {
  before(resetTransactionalState);
  beforeEach(async () => {
    await resetTransactionalState();
    // Undo anything a previous test published or accepted.
    await asService(async (c) => {
      await c.query('delete from public.terms_acceptances where version > 1');
      await c.query('delete from public.terms_documents where version > 1');
      await c.query(`
        insert into public.terms_acceptances (user_id, terms_id, audience, version)
        select u.id, t.id, t.audience, t.version
          from public.users u cross join public.terms_documents t
         where t.audience = 'CUSTOMER'
        on conflict do nothing
      `);
      await c.query(`
        insert into public.terms_acceptances (user_id, terms_id, audience, version)
        select p.user_id, t.id, t.audience, t.version
          from public.partner_profiles p cross join public.terms_documents t
         where t.audience = 'PARTNER' and p.status = 'APPROVED'
        on conflict do nothing
      `);
      await c.query(`
        insert into public.terms_acceptances (user_id, terms_id, audience, version)
        select vu.user_id, t.id, t.audience, t.version
          from public.vendor_users vu cross join public.terms_documents t
         where t.audience = 'VENDOR'
        on conflict do nothing
      `);
    });
  });
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const outstanding = (userId) =>
    asUser(
      userId,
      async (c) => (await c.query('select * from public.my_outstanding_terms()')).rows
    );

  const current = (audience) =>
    asService(
      async (c) => (await c.query('select * from public.current_terms($1)', [audience])).rows[0]
    );

  test('the current terms are readable, including before signing in', async () => {
    const rows = await asAnon(
      async (c) => (await c.query("select * from public.current_terms('CUSTOMER')")).rows
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /customer terms/i);
    assert.ok(rows[0].body.length > 50, 'the actual text is available to read');
  });

  test('an accepted user is not asked again on the next visit', async () => {
    assert.deepEqual(await outstanding(ACTORS.customerAma), [], 'nothing outstanding');
    assert.deepEqual(await outstanding(ACTORS.customerAma), [], 'and still nothing');
  });

  test('a user is asked for exactly the roles they hold', async () => {
    await asService((c) => c.query('delete from public.terms_acceptances'));

    const customer = await outstanding(ACTORS.customerAma);
    assert.deepEqual(
      customer.map((t) => t.audience),
      ['CUSTOMER']
    );

    const vendor = await outstanding(ACTORS.vendor1Staff);
    assert.deepEqual(vendor.map((t) => t.audience).sort(), ['CUSTOMER', 'VENDOR']);

    const partner = await outstanding(ACTORS.partnerYaw);
    assert.deepEqual(partner.map((t) => t.audience).sort(), ['CUSTOMER', 'PARTNER']);

    // An applicant is not yet a Partner, so is not asked for Partner terms.
    const applicant = await outstanding(ACTORS.applicantKofi);
    assert.deepEqual(
      applicant.map((t) => t.audience),
      ['CUSTOMER']
    );
  });

  test('accepting records the version, and clears the prompt', async () => {
    await asService((c) => c.query('delete from public.terms_acceptances'));
    const doc = await current('CUSTOMER');

    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.accept_terms($1)', [doc.terms_id]),
      {
        commit: true,
      }
    );

    const stored = await asService(
      async (c) =>
        (
          await c.query('select * from public.terms_acceptances where user_id = $1', [
            ACTORS.customerAma,
          ])
        ).rows
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].version, 1);
    assert.equal(stored[0].audience, 'CUSTOMER');
    assert.ok(stored[0].accepted_at);

    assert.deepEqual(await outstanding(ACTORS.customerAma), []);
  });

  test('accepting twice is one fact, not two', async () => {
    const doc = await current('CUSTOMER');
    await asUser(
      ACTORS.customerAma,
      (c) => c.query('select public.accept_terms($1)', [doc.terms_id]),
      {
        commit: true,
      }
    );

    const count = await asService(async (c) =>
      Number(
        (
          await c.query(
            "select count(*)::int as n from public.terms_acceptances where user_id = $1 and audience = 'CUSTOMER'",
            [ACTORS.customerAma]
          )
        ).rows[0].n
      )
    );
    assert.equal(count, 1);
  });

  test('publishing a NEW version asks everyone again — and only for that audience', async () => {
    assert.deepEqual(await outstanding(ACTORS.customerAma), []);

    await asService((c) =>
      c.query(`
        insert into public.terms_documents (audience, version, title, body, published_at)
        values ('CUSTOMER', 2, 'Customer terms v2 (PLACEHOLDER)', 'Updated placeholder text.', now())
      `)
    );

    const asked = await outstanding(ACTORS.customerAma);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].version, 2, 'the new version is what is outstanding');

    // A Partner is asked for the customer update, but their Partner terms are
    // untouched.
    const partner = await outstanding(ACTORS.partnerYaw);
    assert.deepEqual(
      partner.map((t) => t.audience),
      ['CUSTOMER']
    );
  });

  test('an unpublished draft is never presented or acceptable', async () => {
    const draft = await asService(
      async (c) =>
        (
          await c.query(`
        insert into public.terms_documents (audience, version, title, body)
        values ('CUSTOMER', 9, 'Draft', 'Not published yet')
        returning *
      `)
        ).rows[0]
    );

    assert.deepEqual(await outstanding(ACTORS.customerAma), [], 'a draft asks nothing');

    const error = await expectRejection(
      asUser(ACTORS.customerAma, (c) => c.query('select public.accept_terms($1)', [draft.id]))
    );
    assert.match(error.message, /not available to accept/);

    const visible = await asAnon(
      async (c) =>
        (await c.query('select * from public.terms_documents where id = $1', [draft.id])).rows
    );
    assert.equal(visible.length, 0, 'and it is not readable either');
  });

  test("a user cannot forge an acceptance or read anyone else's", async () => {
    const write = await expectRejection(
      asUser(ACTORS.customerAma, (c) =>
        c.query(
          `insert into public.terms_acceptances (user_id, terms_id, audience, version)
           values ($1, (select id from public.terms_documents limit 1), 'PARTNER', 1)`,
          [ACTORS.customerAma]
        )
      )
    );
    assert.match(write.message, /permission denied/i);

    const others = await asUser(
      ACTORS.customerAma,
      async (c) =>
        (
          await c.query('select * from public.terms_acceptances where user_id <> $1', [
            ACTORS.customerAma,
          ])
        ).rows
    );
    assert.equal(others.length, 0);
  });

  test('nobody but an admin can publish terms', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.vendor1Staff, ACTORS.partnerYaw]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query(`
            insert into public.terms_documents (audience, version, title, body, published_at)
            values ('CUSTOMER', 99, 'Forged', 'Forged', now())
          `)
        )
      );
      assert.match(error.message, /permission denied/i);
    }
  });
});
