import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, asUser, resetTransactionalState, closePools, ACTORS } from './helpers/db.js';
import { expectRejection, orderReadyForDispatch, partnerAccept } from './helpers/flow.js';

describe('admin — Partner approval and suspension', () => {
  before(resetTransactionalState);
  beforeEach(resetTransactionalState);
  after(async () => {
    await resetTransactionalState();
    await closePools();
  });

  const admin = (sql, params) =>
    asUser(ACTORS.admin, async (c) => (await c.query(sql, params)).rows[0], { commit: true });

  const adminRows = (sql, params) =>
    asUser(ACTORS.admin, async (c) => (await c.query(sql, params)).rows);

  const auditFor = (targetId) =>
    asService(
      async (c) =>
        (
          await c.query('select * from public.admin_actions where target_id = $1 order by id', [
            targetId,
          ])
        ).rows
    );

  // --- the review queue -----------------------------------------------------
  test('the review queue puts applications waiting on a human first', async () => {
    const rows = await adminRows('select * from public.admin_list_partner_applications()');
    assert.equal(rows.length, 5, 'three approved, two pending');
    // Applications waiting on a human lead, oldest first.
    assert.equal(rows[0].status, 'PENDING_REVIEW');
    assert.equal(rows[1].status, 'PENDING_REVIEW');
    assert.ok(rows.slice(2).every((r) => r.status !== 'PENDING_REVIEW'));
  });

  test('the queue exposes document PATHS, never URLs', async () => {
    const rows = await adminRows(
      "select * from public.admin_list_partner_applications('PENDING_REVIEW')"
    );
    const [application] = rows;
    assert.match(application.student_id_image_path, /^partner-docs\//);
    assert.match(application.face_image_path, /^partner-docs\//);
    assert.ok(!JSON.stringify(application).includes('http'), 'no URL is ever returned from SQL');
  });

  test('the queue can be filtered by status', async () => {
    const approved = await adminRows(
      "select * from public.admin_list_partner_applications('APPROVED')"
    );
    assert.equal(approved.length, 3);
    assert.ok(approved.every((a) => a.status === 'APPROVED'));
  });

  test('a non-admin sees an empty queue rather than an error page', async () => {
    for (const actor of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.vendor1Staff]) {
      const rows = await asUser(
        actor,
        async (c) => (await c.query('select * from public.admin_list_partner_applications()')).rows
      );
      assert.equal(rows.length, 0, 'the function returns nothing for a non-admin');
    }
  });

  test("a Partner cannot read another Partner's documents through the table either", async () => {
    const rows = await asUser(
      ACTORS.partnerAdjoa,
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.partnerYaw,
          ])
        ).rows
    );
    assert.equal(rows.length, 0);
  });

  // --- approval ------------------------------------------------------------
  test('approving an applicant grants Partner capability on the same account', async () => {
    const before = await asUser(
      ACTORS.applicantKofi,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(before.is_partner, false);
    assert.equal(before.partner_status, 'PENDING_REVIEW');
    assert.equal(before.can_order, true, 'they could already order as a customer');

    await admin('select * from public.admin_review_partner($1, $2, $3, $4)', [
      ACTORS.applicantKofi,
      'APPROVED',
      'face matches the student ID',
      'checked in person',
    ]);

    const after = await asUser(
      ACTORS.applicantKofi,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(after.is_partner, true);
    assert.equal(after.user_id, before.user_id, 'the SAME account — never a second login');
    assert.equal(after.can_order, true, 'and they can still order');
  });

  test('approval records who decided, when, and sets a document retention deadline', async () => {
    await admin('select * from public.admin_review_partner($1, $2, $3, $4)', [
      ACTORS.applicantKofi,
      'APPROVED',
      'ID verified',
      'note',
    ]);

    const profile = await asService(
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.applicantKofi,
          ])
        ).rows[0]
    );
    assert.equal(profile.reviewed_by, ACTORS.admin);
    assert.ok(profile.reviewed_at);
    assert.equal(profile.review_notes, 'note');
    assert.ok(profile.documents_purge_after, 'verification documents get a deletion deadline');

    const audit = await auditFor(ACTORS.applicantKofi);
    assert.ok(audit.some((a) => a.action === 'PARTNER_APPROVED' && a.reason === 'ID verified'));
  });

  test('an approved Partner starts offline and must opt in', async () => {
    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.applicantKofi,
      'APPROVED',
      'verified',
    ]);
    const profile = await asService(
      async (c) =>
        (
          await c.query('select is_available from public.partner_profiles where user_id = $1', [
            ACTORS.applicantKofi,
          ])
        ).rows[0]
    );
    assert.equal(profile.is_available, false, 'approval does not put someone on shift');
  });

  // --- rejection and suspension --------------------------------------------
  test('rejecting an applicant leaves them able to order but not to deliver', async () => {
    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.applicantKofi,
      'REJECTED',
      'photo does not match the ID',
    ]);

    const caps = await asUser(
      ACTORS.applicantKofi,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.is_partner, false);
    assert.equal(caps.partner_status, 'REJECTED');
    assert.equal(caps.can_order, true, 'a rejected Partner is still a customer');

    const error = await expectRejection(
      asUser(ACTORS.applicantKofi, (c) => c.query('select public.partner_set_availability(true)'))
    );
    assert.match(error.message, /not approved/);
  });

  test('suspending a Partner takes them offline immediately and blocks new deliveries', async () => {
    const order = await orderReadyForDispatch();

    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.partnerYaw,
      'SUSPENDED',
      'repeated no-shows',
    ]);

    const profile = await asService(
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.partnerYaw,
          ])
        ).rows[0]
    );
    assert.equal(profile.status, 'SUSPENDED');
    assert.equal(profile.is_available, false, 'suspension forces them offline');

    const offers = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select * from public.get_delivery_offers()')).rows
    );
    assert.equal(offers.length, 0);

    const error = await expectRejection(partnerAccept(order.order_id, ACTORS.partnerYaw));
    assert.match(error.message, /not approved/);

    const audit = await auditFor(ACTORS.partnerYaw);
    assert.ok(audit.some((a) => a.action === 'PARTNER_SUSPENDED'));
  });

  test('a suspended Partner can be reinstated', async () => {
    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.partnerYaw,
      'SUSPENDED',
      'under investigation',
    ]);
    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.partnerYaw,
      'APPROVED',
      'investigation cleared them',
    ]);

    const caps = await asUser(
      ACTORS.partnerYaw,
      async (c) => (await c.query('select public.my_capabilities() as c')).rows[0].c
    );
    assert.equal(caps.is_partner, true);
    assert.equal(caps.partner_available, false, 'they must go online again themselves');
  });

  // --- authorisation --------------------------------------------------------
  test('nobody but an admin can approve a Partner', async () => {
    for (const actor of [
      ACTORS.customerAma,
      ACTORS.partnerYaw,
      ACTORS.vendor1Staff,
      ACTORS.applicantKofi,
    ]) {
      const error = await expectRejection(
        asUser(actor, (c) =>
          c.query('select public.admin_review_partner($1, $2, $3)', [
            ACTORS.applicantKofi,
            'APPROVED',
            'self approval',
          ])
        )
      );
      assert.match(error.message, /admin privileges required/);
    }

    const profile = await asService(
      async (c) =>
        (
          await c.query('select status from public.partner_profiles where user_id = $1', [
            ACTORS.applicantKofi,
          ])
        ).rows[0]
    );
    assert.equal(profile.status, 'PENDING_REVIEW', 'still awaiting a real decision');
  });

  test('an applicant cannot approve themselves by writing the table directly', async () => {
    const error = await expectRejection(
      asUser(ACTORS.applicantKofi, (c) =>
        c.query("update public.partner_profiles set status = 'APPROVED' where user_id = $1", [
          ACTORS.applicantKofi,
        ])
      )
    );
    assert.match(error.message, /permission denied/i);
  });

  test('a review must be a decision, not a reset to PENDING', async () => {
    const error = await expectRejection(
      admin('select public.admin_review_partner($1, $2, $3)', [
        ACTORS.applicantKofi,
        'PENDING_REVIEW',
        'putting it back',
      ])
    );
    assert.match(error.message, /must be APPROVED, REJECTED or SUSPENDED/);
  });

  test('reviewing someone who never applied is refused', async () => {
    const error = await expectRejection(
      admin('select public.admin_review_partner($1, $2, $3)', [
        ACTORS.customerAma,
        'APPROVED',
        'they never applied',
      ])
    );
    assert.match(error.message, /no partner application for this user/);
  });

  test('an override without a real reason is refused by the audit table', async () => {
    const error = await expectRejection(
      admin('select public.admin_review_partner($1, $2, $3)', [
        ACTORS.applicantKofi,
        'APPROVED',
        'x',
      ])
    );
    assert.match(error.message, /admin_actions_reason_check/);
  });

  // --- document retention ---------------------------------------------------
  test('documents past their retention deadline are reported for purging', async () => {
    await admin('select * from public.admin_review_partner($1, $2, $3)', [
      ACTORS.applicantKofi,
      'APPROVED',
      'verified',
    ]);
    await asService((c) =>
      c.query(
        "update public.partner_profiles set documents_purge_after = now() - interval '1 day' where user_id = $1",
        [ACTORS.applicantKofi]
      )
    );

    const due = await adminRows('select * from public.admin_partner_documents_due_for_purge()');
    assert.equal(due.length, 1);
    assert.equal(due[0].user_id, ACTORS.applicantKofi);
    assert.ok(due[0].face_image_path, 'the Partner document is what is due');

    // THE CUSTOMER'S ID PHOTOGRAPH IS NOT ON THIS LIST, and must not be. The
    // purpose of this function is to hand an administrator a set of objects to
    // delete; a customer's student ID is retained while the account is active,
    // so naming it here would be an invitation to delete it and point a NOT
    // NULL column at a missing file.
    assert.ok(
      !('student_id_image_path' in due[0]),
      'a delete queue names only what may be deleted'
    );
  });

  test('clearing documents removes the paths and is audited', async () => {
    await admin('select * from public.admin_clear_partner_documents($1, $2)', [
      ACTORS.partnerYaw,
      'retention period elapsed',
    ]);

    const profile = await asService(
      async (c) =>
        (
          await c.query('select * from public.partner_profiles where user_id = $1', [
            ACTORS.partnerYaw,
          ])
        ).rows[0]
    );
    assert.equal(profile.face_image_path, null);
    assert.equal(profile.documents_purge_after, null);
    assert.equal(profile.status, 'APPROVED', 'clearing documents does not revoke approval');

    // The student ID photograph is NOT cleared with it. It stopped being a
    // Partner document when Customer became a capability: it is the evidence
    // for a capability this person still holds, and customer_profiles requires
    // it. Purging Partner documents must not quietly revoke someone's ability
    // to order lunch.
    const customer = await asService(
      async (c) =>
        (
          await c.query('select * from public.customer_profiles where user_id = $1', [
            ACTORS.partnerYaw,
          ])
        ).rows[0]
    );
    assert.ok(customer.student_id_image_path, 'the Customer document survives');

    const audit = await auditFor(ACTORS.partnerYaw);
    assert.ok(audit.some((a) => a.action === 'PARTNER_DOCUMENTS_PURGED'));
  });

  test('a non-admin cannot clear or list documents', async () => {
    const error = await expectRejection(
      asUser(ACTORS.partnerYaw, (c) =>
        c.query('select public.admin_clear_partner_documents($1, $2)', [
          ACTORS.partnerYaw,
          'deleting my own evidence',
        ])
      )
    );
    assert.match(error.message, /admin privileges required/);

    const due = await asUser(
      ACTORS.partnerYaw,
      async (c) =>
        (await c.query('select * from public.admin_partner_documents_due_for_purge()')).rows
    );
    assert.equal(due.length, 0);
  });

  test('the documents bucket is private and has no client policies', async () => {
    const bucket = await asService(
      async (c) =>
        (await c.query("select * from storage.buckets where id = 'partner-documents'")).rows[0]
    );
    assert.ok(bucket, 'the bucket exists');
    assert.equal(bucket.public, false, 'a government ID photo is never publicly readable');

    const policies = await asService(
      async (c) =>
        (
          await c.query(
            `select p.polname from pg_policy p
           join pg_class c on c.oid = p.polrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'storage' and c.relname = 'objects'`
          )
        ).rows
    );
    assert.deepEqual(policies, [], 'no storage policy exists, so RLS denies every client read');
  });
});
