import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { areasFor, landingFor, safeNext } from '../lib/auth/landing.js';

/**
 * One sign-in form serves four kinds of person, so the destination is derived
 * rather than chosen. These assert the derivation, including the cases that
 * are easy to get subtly wrong: an account with two capabilities, an applicant
 * who is not a Partner yet, and a suspended account that must not be routed by
 * capability at all.
 *
 * Getting this wrong sends someone somewhere useless. It cannot send them
 * somewhere they are not entitled to — every route re-checks on arrival and the
 * data underneath is filtered by RLS regardless — which is exactly why this can
 * be a pure function with no database in the way.
 */

const base = {
  authenticated: true,
  is_admin: false,
  is_suspended: false,
  can_order: true,
  is_partner: false,
  partner_status: 'NOT_APPLIED',
  vendor_ids: [],
};

describe('where a signed-in account lands', () => {
  test('a customer goes to the order screen', () => {
    assert.equal(landingFor(base), '/order');
  });

  test('vendor staff go to the vendor area', () => {
    assert.equal(
      landingFor({ ...base, vendor_ids: ['20000000-0000-4000-8000-000000000001'] }),
      '/vendor'
    );
  });

  test('an approved Partner goes to the Partner area', () => {
    assert.equal(landingFor({ ...base, is_partner: true, partner_status: 'APPROVED' }), '/partner');
  });

  test('an admin goes to admin', () => {
    assert.equal(landingFor({ ...base, is_admin: true }), '/admin');
  });

  test('an applicant awaiting review goes to their application, not the Partner area', () => {
    // /partner would show them nothing they can act on, and /admin/partners is
    // somebody else's screen.
    assert.equal(landingFor({ ...base, partner_status: 'PENDING_REVIEW' }), '/partner/apply');
  });

  test('a rejected or suspended applicant also sees their application', () => {
    assert.equal(landingFor({ ...base, partner_status: 'REJECTED' }), '/partner/apply');
    assert.equal(landingFor({ ...base, partner_status: 'SUSPENDED' }), '/partner/apply');
  });

  test('one account holding several capabilities lands by precedence', () => {
    const both = { ...base, is_partner: true, partner_status: 'APPROVED', vendor_ids: ['v'] };
    assert.equal(landingFor(both), '/vendor', 'vendor work outranks Partner work');
    assert.equal(landingFor({ ...both, is_admin: true }), '/admin', 'admin outranks everything');
  });

  test('an account with no Customer capability goes to onboarding', () => {
    // A verified phone is an identity. Ordering is a capability, and this is
    // where it is acquired — so someone who holds none of the other
    // capabilities is sent to the one thing that unlocks the rest.
    assert.equal(landingFor({ ...base, can_order: false }), '/onboarding');
  });

  test('onboarding never outranks a capability the account already holds', () => {
    // An administrator or vendor with no student profile still lands in their
    // own area. Sending them to onboarding would imply their account is
    // incomplete, when it is complete for what it does.
    assert.equal(landingFor({ ...base, can_order: false, is_admin: true }), '/admin');
    assert.equal(landingFor({ ...base, can_order: false, vendor_ids: ['v'] }), '/vendor');
    assert.equal(
      landingFor({ ...base, can_order: false, is_partner: true, partner_status: 'APPROVED' }),
      '/partner'
    );
  });

  test('a suspended account is stopped, not routed', () => {
    // Suspension has to win over every capability, including admin. Routing a
    // suspended admin to /admin would hand the account back its own off switch.
    assert.equal(landingFor({ ...base, is_suspended: true, is_admin: true }), '/suspended');
    assert.equal(landingFor({ ...base, is_suspended: true, vendor_ids: ['v'] }), '/suspended');
  });

  test('no session goes to the login page', () => {
    assert.equal(landingFor({ authenticated: false }), '/login');
    assert.equal(landingFor(null), '/login');
    assert.equal(landingFor(undefined), '/login');
  });
});

describe('honouring a requested destination', () => {
  test('an in-app path is kept', () => {
    assert.equal(safeNext('/vendor/123/orders/456'), '/vendor/123/orders/456');
  });

  test('an absolute URL is refused', () => {
    // Sign-in that follows a caller-supplied URL is an open redirect, and a
    // convincing one: the victim really did just authenticate.
    assert.equal(safeNext('https://evil.example/steal'), null);
    assert.equal(safeNext('http://evil.example'), null);
  });

  test('a protocol-relative or backslash-prefixed path is refused', () => {
    assert.equal(safeNext('//evil.example'), null);
    assert.equal(safeNext('/\\evil.example'), null);
  });

  test('nothing supplied means nothing requested', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      assert.equal(safeNext(value), null);
    }
  });
});

/**
 * The switcher is the other half of the precedence chain. landingFor() picks
 * ONE destination; this is what stops that reading as "the account became an
 * admin account and lost the rest", which is exactly how the capability model
 * came to look mutually exclusive.
 */
describe('the areas an account may enter', () => {
  test('a plain customer gets ordering and their account', () => {
    assert.deepEqual(
      areasFor(base).map((a) => a.href),
      ['/order', '/account']
    );
  });

  test('every held capability appears, in the same precedence order', () => {
    const everything = {
      ...base,
      is_admin: true,
      vendor_ids: ['v'],
      is_partner: true,
      partner_status: 'APPROVED',
    };
    assert.deepEqual(
      areasFor(everything).map((a) => a.href),
      ['/admin', '/vendor', '/partner', '/order', '/account']
    );
  });

  test('a capability the account lacks is never offered', () => {
    const adminOnly = { ...base, is_admin: true, can_order: false };
    assert.deepEqual(
      areasFor(adminOnly).map((a) => a.href),
      ['/admin', '/account'],
      'an admin who is not a customer is not sent to a checkout they cannot use'
    );
  });

  test('a suspended or signed-out account is offered nothing', () => {
    assert.deepEqual(areasFor({ ...base, is_suspended: true }), []);
    assert.deepEqual(areasFor({ authenticated: false }), []);
    assert.deepEqual(areasFor(null), []);
  });
});
