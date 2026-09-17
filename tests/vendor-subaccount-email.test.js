import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  notifyAdminSubaccountCreated,
  renderSubaccountCreatedEmail,
  maskAccountNumber,
} from '../lib/notifications/admin-email.js';
import { NOTIFICATION_EVENT, AUDIENCE, CHANNEL } from '../lib/notifications/events.js';
import { FakeEmailProvider } from '../lib/email/fake.js';
import { ResendEmailProvider } from '../lib/email/resend.js';

/**
 * The administrator is told when a vendor's Paystack subaccount is created.
 *
 * WHAT THIS GUARDS. The message is a consequence of a payout registration, and
 * the registration is the thing that matters: a vendor whose account is set up
 * is set up whether or not anybody was emailed about it. So the assertions run
 * in both directions — that the email goes out exactly once on a real creation,
 * and that no failure of the mail path can reach the caller.
 *
 * The provider and the dedup table are injected. That is the same choice notify()
 * made and for the same reason: without it the send path could not be executed
 * by a test at all, only inspected.
 */

/** A provider that records what it was asked to send, and never leaves the process. */
function recordingEmail({ fail = false, throws = false } = {}) {
  const sent = [];
  return {
    sent,
    name: 'recording',
    async send(message) {
      sent.push(message);
      if (throws) throw new Error('mail server unreachable');
      if (fail) return { ok: false, providerMessageId: null, error: 'rejected' };
      return { ok: true, providerMessageId: `msg_${sent.length}` };
    },
  };
}

/** The dedup table, in memory: a key is "already sent" once a SUCCESS is recorded. */
function memoryDb() {
  const rows = [];
  return {
    rows,
    async alreadySent(key) {
      return rows.some((row) => row.dedupeKey === key && row.succeeded);
    },
    async record(entry) {
      rows.push(entry);
    },
  };
}

const SUBACCOUNT = {
  vendorName: 'Asumadu Specials',
  accountName: 'Kwadwo Amoah Asumadu',
  subaccountCode: 'ACCT_testsubaccount01',
  momoNetwork: 'MTN',
  accountNumber: '0551234217',
  settlementSchedule: 'AUTO',
  createdAt: '2026-09-17T17:51:00.000Z',
};

const RECIPIENT = 'ops@campusdash.test';

describe('the admin subaccount email', () => {
  /**
   * Fixtures are built PER TEST, never shared.
   *
   * node:test runs the subtests of a suite concurrently, so a `let` in this
   * scope assigned from a beforeEach is a race between them — which is exactly
   * how this file first failed. Each test gets its own provider and its own
   * dedup table, and nothing here is reachable from another test.
   */
  function fixture({ fail = false, throws = false } = {}) {
    const email = recordingEmail({ fail, throws });
    const db = memoryDb();
    const notify = (overrides = {}) =>
      notifyAdminSubaccountCreated({
        ...SUBACCOUNT,
        ...overrides,
        deps: { email, db, recipient: RECIPIENT, ...(overrides.deps ?? {}) },
      });
    return { email, db, notify };
  }

  test('a successful creation sends exactly one email, with the required facts', async () => {
    const { email, notify } = fixture();
    const result = await notify();

    assert.equal(email.sent.length, 1, 'exactly one email');
    assert.equal(result.ok, true);
    assert.equal(result.channel, CHANNEL.EMAIL);

    const [message] = email.sent;
    assert.equal(message.to, RECIPIENT);
    assert.equal(message.subject, 'Campus Dash: Vendor Paystack Subaccount Created');

    // Every fact the brief asked for, present in the body.
    assert.match(message.text, /Asumadu Specials/, 'store name');
    assert.match(message.text, /Kwadwo Amoah Asumadu/, 'account name');
    assert.match(message.text, /ACCT_testsubaccount01/, 'subaccount code');
    assert.match(message.text, /MTN/, 'settlement network');
    assert.match(message.text, /AUTO/, 'settlement schedule');
    assert.match(message.text, /2026-09-17T17:51:00\.000Z/, 'created at');
    assert.match(message.text, /Paystack confirmed it/, 'says plainly that it succeeded');
  });

  test('the account number is masked, never sent in full', async () => {
    const { email, notify } = fixture();
    await notify();
    const [message] = email.sent;

    assert.doesNotMatch(message.text, /0551234217/, 'the full number must never be in the email');
    assert.match(message.text, /…217/, 'the last three digits are enough to recognise it');

    assert.equal(maskAccountNumber('0551234217'), '…217');
    assert.equal(maskAccountNumber('12'), '…12');
    assert.equal(maskAccountNumber(null), 'not on file');
  });

  test('it is recorded on the notification ledger as an ADMIN email', async () => {
    const { db, notify } = fixture();
    await notify();

    assert.equal(db.rows.length, 1);
    const [row] = db.rows;
    assert.equal(row.event, NOTIFICATION_EVENT.VENDOR_SUBACCOUNT_CREATED);
    assert.equal(row.recipient, RECIPIENT);
    assert.equal(row.succeeded, true);
    assert.equal(
      row.dedupeKey,
      `${NOTIFICATION_EVENT.VENDOR_SUBACCOUNT_CREATED}:${AUDIENCE.ADMIN}:${SUBACCOUNT.subaccountCode}:${RECIPIENT}`,
      'keyed on the subaccount code, so a retry finds it'
    );
  });

  test('a repeat for the SAME subaccount sends nothing more', async () => {
    const { email, notify } = fixture();
    await notify();
    const again = await notify();

    assert.equal(email.sent.length, 1, 'still one email after a second call');
    assert.equal(again.skipped, 'already_sent');
  });

  test('a genuinely NEW subaccount is a new email', async () => {
    // Changing a payout number clears the old code and registers a fresh one.
    // That is a different fact and an administrator should hear it.
    const { email, notify } = fixture();
    await notify();
    await notify({ subaccountCode: 'ACCT_adifferentcode99' });

    assert.equal(email.sent.length, 2);
    assert.match(email.sent[1].text, /ACCT_adifferentcode99/);
  });

  test('a FAILED send is recorded and does not block a later retry', async () => {
    const failing = fixture({ fail: true });
    const result = await failing.notify();

    assert.equal(result.ok, false);
    assert.equal(failing.db.rows.length, 1);
    assert.equal(failing.db.rows[0].succeeded, false, 'recorded as a failure');

    // alreadySent() only counts successes, so the next attempt genuinely tries
    // — against the SAME dedup table, with a working provider.
    const working = recordingEmail();
    const retried = await notifyAdminSubaccountCreated({
      ...SUBACCOUNT,
      deps: { email: working, db: failing.db, recipient: RECIPIENT },
    });
    assert.equal(retried.ok, true, 'a failed notification is not deduplicated away');
    assert.equal(working.sent.length, 1);
  });

  test('a provider that THROWS is recorded, and still does not throw at the caller', async () => {
    const { db, notify } = fixture({ throws: true });

    const result = await notify();
    assert.equal(result.ok, false);
    assert.match(result.error, /unreachable/);
    assert.equal(db.rows[0].succeeded, false);
  });

  test('no configured admin address means no email and no ledger row', async () => {
    const { email, db } = fixture();
    const result = await notifyAdminSubaccountCreated({
      ...SUBACCOUNT,
      deps: { email, db, recipient: null },
    });

    assert.equal(result.skipped, 'no_admin_email');
    assert.equal(email.sent.length, 0);
    assert.equal(db.rows.length, 0, 'nothing to key a notification on');
  });

  test('a malformed admin address is refused before the provider is called', async () => {
    const { email, db } = fixture();
    const result = await notifyAdminSubaccountCreated({
      ...SUBACCOUNT,
      deps: { email, db, recipient: '0551234217' },
    });

    assert.equal(result.skipped, 'bad_admin_email');
    assert.equal(email.sent.length, 0);
  });

  test('missing facts are named as missing rather than invented', () => {
    const text = renderSubaccountCreatedEmail({
      vendorName: 'A vendor',
      accountName: null,
      subaccountCode: 'ACCT_x',
      momoNetwork: null,
      accountNumber: null,
      settlementSchedule: null,
      createdAt: '2026-09-17T00:00:00.000Z',
    });

    assert.match(text, /Account name\s+: not on file/);
    assert.match(text, /Settlement\s+: not reported by Paystack/);
    assert.doesNotMatch(text, /null|undefined/, 'a missing value must never render as null');
  });
});

/**
 * THE TRIGGER POINT ITSELF.
 *
 * syncPayoutSubaccount() is the only function that creates a subaccount, and it
 * has four exits. Only one of them is a creation, and the assertions below pin
 * that down at the source: an email on the success path, and none on any of the
 * three that are not.
 *
 * Checked at the SOURCE rather than by executing the function, because executing
 * it means a Paystack adapter, a Supabase service client and a database — none
 * of which is what this is about. What matters is WHICH branch carries the call.
 */
describe('where the email is triggered', () => {
  const source = new URL('../lib/settlement/destinations.js', import.meta.url);
  const text = readFileSync(source, 'utf8');

  test('the notification is sent through the deferred mechanism', () => {
    assert.match(text, /deferNotification\(/, 'must not block the vendor saving their details');
    assert.match(text, /notifyAdminSubaccountCreated\(/);
  });

  test('it sits AFTER the subaccount has been attached, on the success path only', () => {
    const attach = text.indexOf('await attachPayoutSubaccount({');
    const notifyAt = text.indexOf('notifyAdminSubaccountCreated(');
    const success = text.indexOf('return { ok: true, subaccountCode: created.subaccountCode };');

    assert.ok(attach > 0 && notifyAt > 0 && success > 0, 'all three landmarks exist');
    assert.ok(notifyAt > attach, 'the email comes after Paystack confirmed and we stored the code');
    assert.ok(notifyAt < success, 'and before the success is returned');
  });

  test('neither early return nor the failure path can reach it', () => {
    const notifyAt = text.indexOf('notifyAdminSubaccountCreated(');

    // The already-registered short-circuit, which is what a retry hits.
    const unchanged = text.indexOf('unchanged: true');
    assert.ok(unchanged > 0 && unchanged < notifyAt, 'a retry returns before the email');

    // The catch that records a Paystack refusal.
    const failure = text.indexOf('await recordFailure(');
    assert.ok(failure > 0 && failure < notifyAt, 'a failed creation returns before the email');

    // The branch that runs when a provider has no subaccounts at all.
    const noSubaccounts = text.indexOf('has no subaccounts');
    assert.ok(noSubaccounts > 0 && noSubaccounts < notifyAt);
  });
});

/** The adapters, against a stub fetch. No account, no network, no cost. */
describe('the email adapters', () => {
  test('the fake provider reports success and invents a message id', async () => {
    const provider = new FakeEmailProvider();
    assert.equal(provider.name, 'fake');

    const result = await provider.send({ to: 'a@b.test', subject: 'x', text: 'y' });
    assert.equal(result.ok, true);
    assert.match(result.providerMessageId, /^fake_email_/);
  });

  test('Resend is sent one POST with the address, subject and text', async () => {
    const calls = [];
    const provider = new ResendEmailProvider({
      apiKey: 'test-key-never-real',
      fromAddress: 'Campus Dash <notify@example.test>',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ id: 'resend_123' }) };
      },
    });

    const result = await provider.send({
      to: 'ops@example.test',
      subject: 'Campus Dash: Vendor Paystack Subaccount Created',
      text: 'body',
      tag: 'VENDOR_SUBACCOUNT_CREATED',
    });

    assert.equal(result.ok, true);
    assert.equal(result.providerMessageId, 'resend_123');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/emails$/);

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ['ops@example.test']);
    assert.equal(body.subject, 'Campus Dash: Vendor Paystack Subaccount Created');
    assert.equal(body.text, 'body');
  });

  test('a rejection is returned, never thrown', async () => {
    const provider = new ResendEmailProvider({
      apiKey: 'test-key-never-real',
      fromAddress: 'a@b.test',
      fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: 'nope' }) }),
    });

    const result = await provider.send({ to: 'x@y.test', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'nope');
  });

  test('an unreachable provider is returned as a failure, never thrown', async () => {
    const provider = new ResendEmailProvider({
      apiKey: 'test-key-never-real',
      fromAddress: 'a@b.test',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await provider.send({ to: 'x@y.test', subject: 's', text: 't' });
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
  });
});
