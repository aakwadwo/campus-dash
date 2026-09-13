import './helpers/local-supabase.js';

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withRequestCookies } from './helpers/stubs/next-headers.mjs';
import { asService, closePools } from './helpers/db.js';
import {
  otpSession,
  passwordSession,
  sessionCookies,
  temporaryCustomer,
  temporaryVendor,
  SEEDED_ADMIN,
} from './helpers/sessions.js';

/**
 * Every admin server action refuses a caller who is not operating the console.
 *
 * A server action is a public POST endpoint. The admin layout never runs in
 * front of it, and settlement and payout retries use the service-role client,
 * which bypasses is_admin() in the database. So the refusal has to happen in
 * the action, before anything else, and this file proves it does: by reading
 * every export, and by calling every export as a stranger, a vendor, a
 * customer, and an administrator who signed in without their password.
 */

const SOURCE = readFileSync(new URL('../app/admin/actions.js', import.meta.url), 'utf8');

const actions = await import('../app/admin/actions.js');
const { authoriseAdminAction } = await import('../lib/auth/session.js');
const exported = Object.entries(actions).filter(([, value]) => typeof value === 'function');

after(closePools);

/** Plausible input, so a missing guard would get as far as doing something. */
function formFor(name) {
  const form = new FormData();
  form.set('reason', 'authorisation test');
  form.set('payee_type', 'PARTNER');
  form.set('run_id', '00000000-0000-4000-8000-00000000abcd');
  form.set('order_id', '00000000-0000-4000-8000-00000000abcd');
  form.set('user_id', '00000000-0000-4000-8000-000000000021');
  form.set('suspend', 'true');
  form.set('name', `authorisation test ${name}`);
  return form;
}

async function moneyState() {
  return asService(async (c) => {
    const { rows } = await c.query(
      `select (select count(*) from public.settlement_runs) as runs,
              (select count(*) from public.payouts) as payouts,
              (select count(*) from public.admin_actions) as audit`
    );
    return rows[0];
  });
}

describe('the admin actions file', () => {
  test('exports the actions the console uses, settlement included', () => {
    const names = exported.map(([name]) => name);
    assert.ok(names.length >= 32, `expected every admin action, found ${names.length}`);
    assert.ok(names.includes('runSettlementAction'));
    assert.ok(names.includes('retryPayoutsAction'));
  });

  test('every export begins with the admin guard', () => {
    const bodies = [
      ...SOURCE.matchAll(/^export async function (\w+)\([^)]*\) \{\n([^\n]*)\n([^\n]*)/gm),
    ];
    assert.equal(bodies.length, exported.length, 'every export is an `export async function`');
    for (const [, name, first, second] of bodies) {
      assert.equal(first.trim(), 'const denied = await authoriseAdminAction();', `${name} line 1`);
      assert.equal(second.trim(), 'if (denied) return denied;', `${name} line 2`);
    }
  });
});

describe('calling admin actions without an admin session', () => {
  let customer;
  let vendor;

  before(async () => {
    customer = await temporaryCustomer();
    vendor = await temporaryVendor();
  });

  after(async () => {
    await customer?.remove();
    await vendor?.remove();
  });

  const callers = [
    ['a signed-out visitor', async () => ({}), /session has ended/],
    [
      'a vendor',
      async () => sessionCookies(await otpSession(vendor.email)),
      /does not have administrator access/,
    ],
    [
      'a customer',
      async () => sessionCookies(await otpSession(customer.email)),
      /does not have administrator access/,
    ],
    [
      'an administrator signed in by emailed code',
      async () => sessionCookies(await otpSession(SEEDED_ADMIN.email)),
      /administrator password/,
    ],
  ];

  for (const [who, cookiesFor, message] of callers) {
    test(`${who} is refused by every action, and nothing changes`, async () => {
      const cookies = await cookiesFor();
      const before = await moneyState();

      for (const [name, action] of exported) {
        const result = await withRequestCookies(cookies, () => action({}, formFor(name)));
        assert.equal(result?.ok, false, `${name} must refuse ${who}`);
        assert.equal(result.kind, 'FORBIDDEN', `${name} must refuse ${who} as forbidden`);
        assert.match(result.message, message, `${name}: ${result.message}`);
      }

      assert.deepEqual(await moneyState(), before, 'no settlement run, payout or audit row');
    });
  }

  test('settlement and payout retries specifically refuse a stranger', async () => {
    const before = await moneyState();
    for (const name of ['runSettlementAction', 'retryPayoutsAction']) {
      const result = await withRequestCookies({}, () => actions[name]({}, formFor(name)));
      assert.equal(result.ok, false);
      assert.equal(result.kind, 'FORBIDDEN');
    }
    assert.deepEqual(await moneyState(), before);
  });
});

describe('an administrator on a password session', () => {
  test('passes the guard and reaches the action', async () => {
    const cookies = sessionCookies(await passwordSession(SEEDED_ADMIN));

    assert.equal(await withRequestCookies(cookies, () => authoriseAdminAction()), null);

    // Past the guard, the action's own validation answers. No side effects.
    const result = await withRequestCookies(cookies, () =>
      actions.viewScanAction({}, new FormData())
    );
    assert.deepEqual(result, { ok: false, message: 'No order was named.' });
  });
});
