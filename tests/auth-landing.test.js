import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { areasFor, landingFor, safeNext, vendorOnlyHome } from '../lib/auth/landing.js';

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

  test('an approved Partner who is also a customer lands on ordering', () => {
    // PARTNER ⇒ CUSTOMER, so this account always holds both — and carrying a
    // delivery is something you go and look for, not something you are doing
    // when you happen to open the app. The Partner area is one tap away in the
    // area switcher, which is why precedence here is not exclusion.
    assert.equal(landingFor({ ...base, is_partner: true, partner_status: 'APPROVED' }), '/order');
  });

  test('a Partner with no Customer capability still lands on the Partner area', () => {
    // Not reachable in practice — the foreign key makes PARTNER ⇒ CUSTOMER —
    // but the precedence has to be total, or an account in an unexpected state
    // lands nowhere.
    assert.equal(
      landingFor({ ...base, can_order: false, is_partner: true, partner_status: 'APPROVED' }),
      '/partner'
    );
  });

  test('an admin goes to admin', () => {
    assert.equal(landingFor({ ...base, is_admin: true }), '/admin');
  });

  test('an applicant awaiting review goes to their application, not the Partner area', () => {
    // /partner would show them nothing they can act on, and /admin/partners is
    // somebody else's screen. A Partner applicant is by definition already a
    // customer, so this only shows once ordering is not the answer either.
    assert.equal(
      landingFor({ ...base, can_order: false, partner_status: 'PENDING_REVIEW' }),
      '/partner/apply'
    );
  });

  test('a rejected or suspended applicant also sees their application', () => {
    for (const status of ['REJECTED', 'SUSPENDED']) {
      assert.equal(
        landingFor({ ...base, can_order: false, partner_status: status }),
        '/partner/apply'
      );
    }
  });

  test('an applicant who can still order lands on ordering, and finds the rest from there', () => {
    // The one thing this must NOT do is strand somebody: every area they hold
    // is in the switcher, so landing on /order never means losing sight of an
    // application under review.
    assert.equal(landingFor({ ...base, partner_status: 'PENDING_REVIEW' }), '/order');
  });

  test('one account holding several capabilities lands by precedence', () => {
    // ADMIN → VENDOR → CUSTOMER → PARTNER. A vendor signs in to run the stall:
    // there is money and a 60-second answer window on that side and neither on
    // the other.
    const both = { ...base, is_partner: true, partner_status: 'APPROVED', vendor_ids: ['v'] };
    assert.equal(landingFor(both), '/vendor', 'vendor work outranks everything but admin');
    assert.equal(landingFor({ ...both, is_admin: true }), '/admin', 'admin outranks everything');
  });

  test('a vendor whose application is still under review sees its status', () => {
    // /vendor would show them a dashboard with no store behind it, and for a
    // REJECTED application the status page is the only place the reason exists.
    for (const status of ['PENDING_APPROVAL', 'REJECTED', 'DRAFT']) {
      assert.equal(
        landingFor({ ...base, can_order: false, vendor_status: status }),
        '/vendor/application'
      );
    }
  });

  test('an account with no capability at all goes to sign-up', () => {
    // A verified identity is an identity. Ordering is a capability, and this is
    // where it is acquired — so someone who holds none of the others is sent to
    // the one thing that unlocks the rest.
    assert.equal(landingFor({ ...base, can_order: false }), '/signup');
  });

  test('sign-up never outranks a capability the account already holds', () => {
    // An administrator or vendor with no student profile still lands in their
    // own area. Sending them to sign-up would imply their account is
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
      ['/admin', '/vendor', '/order', '/partner', '/account']
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

  /**
   * A VENDOR-ONLY ACCOUNT. Somebody who runs a store off campus and has never
   * ordered anything has no order history and no Partner application, and
   * should not be taught that Campus Dash has a capability model at all. Their
   * whole product is the order board.
   */
  test('a vendor who is not a customer is offered the store and nothing else', () => {
    const vendorOnly = {
      ...base,
      can_order: false,
      is_partner: false,
      partner_status: 'NOT_APPLIED',
      vendor_ids: ['v'],
      vendor_status: 'ACTIVE',
    };

    assert.equal(landingFor(vendorOnly), '/vendor');
    assert.deepEqual(
      areasFor(vendorOnly).map((a) => a.href),
      ['/vendor', '/account'],
      'no Order entry, and therefore no switcher inviting them into one'
    );
  });

  test('a vendor who also orders keeps both, and lands on the store', () => {
    const both = { ...base, vendor_ids: ['v'], vendor_status: 'ACTIVE' };
    assert.equal(landingFor(both), '/vendor', 'there is money on that side');
    assert.deepEqual(
      areasFor(both).map((a) => a.href),
      ['/vendor', '/order', '/account'],
      'and ordering lunch is one tap away'
    );
  });

  test('a Partner applicant is still a customer, and lands on ordering', () => {
    const applicant = { ...base, partner_status: 'PENDING_REVIEW' };
    assert.equal(landingFor(applicant), '/order');
    assert.deepEqual(
      areasFor(applicant).map((a) => a.href),
      ['/order', '/account'],
      'a pending application is not a Partner area yet'
    );
  });
});

describe('a vendor opening a customer page', () => {
  const STORE = ['20000000-0000-4000-8000-000000000001'];
  const vendorOnly = {
    ...base,
    can_order: false,
    vendor_ids: STORE,
    vendor_status: 'ACTIVE',
  };

  test('a non-student vendor is sent to their store', () => {
    assert.equal(vendorOnlyHome(vendorOnly), '/vendor');
  });

  test('a student vendor browses, and sign-in still lands them on the store', () => {
    const student = { ...vendorOnly, can_order: true };
    assert.equal(vendorOnlyHome(student), null);
    // Post-login routing is unchanged: vendor before customer.
    assert.equal(landingFor(student), '/vendor');
    assert.ok(areasFor(student).some((area) => area.href === '/vendor'));
  });

  test('a non-student applicant is sent to where their application stands', () => {
    for (const status of ['PENDING_APPROVAL', 'REJECTED', 'DRAFT', 'SUSPENDED']) {
      assert.equal(
        vendorOnlyHome({ ...vendorOnly, vendor_ids: [], vendor_status: status }),
        '/vendor/application',
        status
      );
    }
  });

  test('nobody else is redirected', () => {
    assert.equal(vendorOnlyHome(undefined), null);
    assert.equal(vendorOnlyHome({ authenticated: false }), null, 'signed out');
    assert.equal(vendorOnlyHome(base), null, 'a customer');
    assert.equal(vendorOnlyHome({ ...base, can_order: false, vendor_status: 'NOT_APPLIED' }), null);
    assert.equal(vendorOnlyHome({ ...base, can_order: false, is_admin: true }), null, 'an admin');
    assert.equal(vendorOnlyHome({ ...vendorOnly, is_partner: true }), null, 'a Partner');
    assert.equal(vendorOnlyHome({ ...vendorOnly, is_suspended: true }), null, 'suspended');
  });

  test('only ever answers with a vendor route, so it cannot loop back', () => {
    const shapes = [];
    for (const can_order of [true, false])
      for (const is_partner of [true, false])
        for (const is_suspended of [true, false])
          for (const vendor_ids of [[], STORE])
            for (const vendor_status of [
              'NOT_APPLIED',
              'ACTIVE',
              'PENDING_APPROVAL',
              'REJECTED',
              undefined,
            ])
              shapes.push({
                ...base,
                can_order,
                is_partner,
                is_suspended,
                vendor_ids,
                vendor_status,
              });

    for (const shape of shapes) {
      assert.ok([null, '/vendor', '/vendor/application'].includes(vendorOnlyHome(shape)));
    }
  });
});
