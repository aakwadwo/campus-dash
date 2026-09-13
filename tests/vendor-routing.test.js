import './helpers/local-supabase.js';

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect.js';
import { asService, closePools, ACTORS } from './helpers/db.js';

/**
 * Student vendors browse; non-student vendors go to their store.
 *
 * "Student" is the Customer capability, read from my_capabilities() exactly as
 * a request reads it. The seeded vendor1Staff owns an ACTIVE store and holds no
 * customer_profiles row, which is a non-student vendor. Giving the same account
 * a customer profile, inside a transaction that is rolled back, makes it a
 * student vendor without touching the seed.
 */

const { redirectVendorOnlyAccount } = await import('../lib/auth/session.js');

after(closePools);

/** my_capabilities() for a user, optionally as though they held a customer profile. */
async function capabilitiesOf(userId, { asStudent = false } = {}) {
  return asService(async (c) => {
    await c.query('begin');
    try {
      if (asStudent) {
        await c.query(
          `insert into public.customer_profiles (user_id, level) values ($1, '100')
           on conflict (user_id) do nothing`,
          [userId]
        );
      }
      await c.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const { rows } = await c.query('select public.my_capabilities() as caps');
      return rows[0].caps;
    } finally {
      await c.query('rollback');
    }
  });
}

/** Where redirectVendorOnlyAccount() sends these capabilities, or null. */
async function destination(capabilities) {
  try {
    await redirectVendorOnlyAccount(capabilities);
    return null;
  } catch (error) {
    const url = getURLFromRedirectError(error);
    if (!url) throw error;
    return url;
  }
}

describe('vendor routing on real capabilities', () => {
  test('a non-student vendor is redirected to the vendor dashboard', async () => {
    const caps = await capabilitiesOf(ACTORS.vendor1Staff);
    assert.equal(caps.can_order, false);
    assert.equal(caps.vendor_ids.length, 1);
    assert.equal(await destination(caps), '/vendor');
  });

  test('a student vendor browses and keeps the vendor dashboard', async () => {
    const caps = await capabilitiesOf(ACTORS.vendor1Staff, { asStudent: true });
    assert.equal(caps.can_order, true);
    assert.equal(await destination(caps), null, 'sees the marketplace');
    assert.equal(caps.vendor_ids.length, 1, 'still owns the store');
  });

  test('a non-student applicant is sent to their application', async () => {
    assert.equal(
      await destination(await capabilitiesOf(ACTORS.vendorPendingOwner)),
      '/vendor/application'
    );
    assert.equal(
      await destination(await capabilitiesOf(ACTORS.vendorRejectedOwner)),
      '/vendor/application'
    );
  });

  test('customers, Partners, admins and signed-out visitors are unaffected', async () => {
    assert.equal(await destination({ authenticated: false }), null);
    for (const id of [ACTORS.customerAma, ACTORS.partnerYaw, ACTORS.admin]) {
      assert.equal(await destination(await capabilitiesOf(id)), null, id);
    }
  });
});

describe('where the rule is applied', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

  test('the homepage and the marketplace segment apply it', () => {
    assert.match(read('app/page.js'), /await redirectVendorOnlyAccount\(/);
    // In the LAYOUT, which covers /order and /order/[vendorId] and renders
    // outside loading.js, so the redirect is a real 307 rather than a stream.
    assert.match(read('app/order/layout.js'), /await redirectVendorOnlyAccount\(/);
  });

  test('the account area applies the same rule rather than its own copy', () => {
    assert.match(read('app/account/layout.js'), /vendorOnlyHome\(me\)/);
  });

  test('no destination it can send to applies it, so there is no loop', () => {
    // vendorOnlyHome only answers /vendor or /vendor/application. Neither, nor
    // anything they redirect onward to, may send a vendor back to a customer page.
    for (const page of [
      'app/vendor/layout.js',
      'app/vendor/page.js',
      'app/vendor/application/page.js',
      'app/(auth)/vendor/signup/page.js',
      'app/suspended/page.js',
      'app/(auth)/login/page.js',
      'app/(auth)/login/admin/page.js',
      'app/admin/layout.js',
    ]) {
      const source = read(page);
      assert.doesNotMatch(source, /redirectVendorOnlyAccount|vendorOnlyHome/, page);
      assert.doesNotMatch(
        source,
        /redirect\(['"`]\/(order)?['"`]\)/,
        `${page} redirects to a customer page`
      );
    }
  });
});
