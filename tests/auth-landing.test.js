import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { landingFor, safeNext } from '../lib/auth/landing.js';

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
