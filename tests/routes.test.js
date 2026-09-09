import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools, ACTORS, VENDORS } from './helpers/db.js';

/**
 * Every major route, actually requested.
 *
 * WHY THIS EXISTS. The suite below it proves the database refuses the wrong
 * things; it cannot prove a page renders. A route can compile, pass every SQL
 * test, and still 500 in a browser because a server component called a function
 * that is not in the schema it is pointed at, or a client component imported
 * something server-only, or a query returned null where the page assumed a row.
 * Those failures are invisible to every other test in this repository and they
 * are exactly what a person reports as "the page does not load".
 *
 * WHAT COUNTS AS PASSING. A route may legitimately answer:
 *
 *   200  it rendered
 *   3xx  it redirected somewhere deliberate — a sign-in, usually
 *   404  the id in the URL does not exist, which is the honest answer
 *
 * What it may never do is 500, and — the one that hides in a 200 — it may never
 * render the error boundary. Next.js serves `app/error.js` with a 200, so a
 * status check alone would call a broken page healthy. The body is checked too.
 *
 * SIGNED OUT, DELIBERATELY. Reaching an authenticated route without a session
 * still executes the route file: its imports resolve, its layout runs, and its
 * guard decides. A redirect to sign-in is therefore a real assertion that the
 * page is intact, and it needs no session to make. Behaviour behind the guard is
 * covered by the SQL suites, which can reach it directly.
 */
const APP = process.env.TEST_APP_URL || 'http://127.0.0.1:3000';

async function appIsRunning() {
  try {
    const res = await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const running = await appIsRunning();

/** The copy `app/error.js` and `app/admin/error.js` render. */
const ERROR_BOUNDARY = /Something went wrong|This screen did not load/i;

describe('route health', { skip: running ? false : `dev server not running at ${APP}` }, () => {
  after(closePools);

  /** A real id for each dynamic segment, so those routes get a real render. */
  const ids = {};

  before(async () => {
    ids.vendor = VENDORS.one;
    ids.customer = ACTORS.customerAma;
    ids.partner = ACTORS.partnerYaw;
    ids.order = await asService(
      async (c) => (await c.query('select id from public.orders limit 1')).rows[0]?.id ?? null
    );
  });

  async function check(path, { allow404 = false } = {}) {
    const res = await fetch(`${APP}${path}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    if (res.status >= 300 && res.status < 400) return { status: res.status, redirected: true };
    if (res.status === 404 && allow404) return { status: 404 };

    assert.ok(
      res.status < 500,
      `${path} answered ${res.status}; a route must never fail on the server`
    );
    assert.ok(res.status < 400, `${path} answered ${res.status}`);

    const body = await res.text();
    assert.ok(
      !ERROR_BOUNDARY.test(body),
      `${path} rendered the error boundary, which Next serves with a 200 — a status check alone would have called this healthy`
    );
    return { status: res.status, body };
  }

  // =====================================================================
  // Public
  // =====================================================================

  test('the landing page renders', async () => {
    const { body } = await check('/');
    assert.match(body, /Campus Dash/);
  });

  test('Browse Food renders, and lists the catalogue', async () => {
    // THE ONE THAT BROKE. It is the first authenticated-optional page that
    // actually queries the database, so it is the first to fail when the
    // schema the app is pointed at is behind the code.
    const { body } = await check('/order');
    assert.match(body, /Browse food/i);
    assert.ok(
      /Test Kitchen One|Test Grill Two|No stores yet|nothing here/i.test(body),
      'the vendor query returned something the page could render'
    );
  });

  test('every store link on the landing page points at a real store', async () => {
    // THE BUG THIS CATCHES. The landing strip read `vendor.id` while
    // storefront_vendors() returns `vendor_id`, so every card linked to
    // /order/undefined. The page rendered, the names were right, the status
    // was 200 — and every link was dead. A route check that only asks
    // "did it render" would have called that healthy.
    const { body } = await check('/');
    const links = [...body.matchAll(/href=\\?"\/order\/([^"\\]+)\\?"/g)].map((m) => m[1]);
    const targets = links.filter((v) => v !== '');
    assert.ok(targets.length > 0, 'the landing page offers at least one store');
    for (const target of targets) {
      assert.match(
        target,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        `the landing page links to /order/${target}`
      );
    }
  });

  test('a store page renders its menu', async () => {
    const { body } = await check(`/order/${ids.vendor}`);
    assert.match(body, /Test Kitchen One/i);
  });

  test('an unknown store renders the not-found page, not an error', async () => {
    // The STATUS is not the assertion. Next's dev server answers a
    // notFound() with 200 and the production build answers 404, and neither
    // is what a person experiences — what they experience is which page they
    // are shown. An id that does not exist must produce the honest "we could
    // not find that", never the error boundary.
    const res = await fetch(`${APP}/order/00000000-0000-4000-8000-0000000000ff`, {
      redirect: 'manual',
    });
    assert.ok(res.status < 500, `answered ${res.status}`);
    if (res.status === 200) {
      const body = await res.text();
      assert.match(body, /could not find that/i);
      assert.ok(!ERROR_BOUNDARY.test(body), 'a missing store is not an error');
    }
  });

  for (const path of [
    '/scan',
    '/terms',
    '/suspended',
    '/login/admin',
    '/login/vendor',
    '/vendor/signup',
  ]) {
    test(`${path} renders or redirects deliberately`, async () => {
      await check(path);
    });
  }

  test('/signup renders the whole customer sign-up form', async () => {
    // NOT A STATUS CHECK. /signup answering 200 says nothing about whether a
    // student can sign up: the page could render an empty card, be missing the
    // level options, or have lost the terms checkbox, and a status assertion
    // would call all three healthy. Every field the flow requires is named.
    const { body } = await check('/signup');

    for (const field of [
      'name="first_name"',
      'name="last_name"',
      'name="email"',
      'name="student_id_number"',
      'name="level"',
      'name="phone"',
      'name="accept_terms"',
    ]) {
      assert.ok(body.includes(field), `the sign-up form is missing ${field}`);
    }

    // All four levels. A missing one is a whole year group that cannot sign
    // up, and nothing else in the suite would notice.
    for (const level of ['100', '200', '300', '400']) {
      assert.ok(new RegExp(`value=\\"${level}\\"`).test(body), `level ${level} is not offered`);
    }

    assert.match(body, /@acity\.edu\.gh/, 'the school domain is stated on the form');
    assert.match(body, /Send verification code/i, 'the next step is a code, not a password');
    assert.match(body, /customer terms/i, 'the terms are linked before acceptance');
  });

  test('/signup asks for a CODE, never a magic link or a password', async () => {
    const { body } = await check('/signup');
    assert.ok(!/type=\\?"password\\?"/i.test(body), 'customers do not have passwords');
    assert.ok(
      !/magic link|sign-?in link|confirmation link/i.test(body),
      'the flow is a typed code; a link opens in whichever browser the mail app picks'
    );
  });

  test('/signup offers no student ID upload', async () => {
    // Signing up to order lunch requires no document. The ID photograph
    // belongs to the Partner application, the only review that looks at one.
    const { body } = await check('/signup');
    assert.ok(!/type=\\?"file\\?"/i.test(body), 'no upload control on customer sign-up');
  });

  test('/login sends a code to a school address, and links to sign-up', async () => {
    const { body } = await check('/login');
    assert.ok(body.includes('name="email"'), 'the address is the identity');
    assert.ok(!/type=\\?"password\\?"/i.test(body), 'customers sign in with a code');
    assert.match(body, /@acity\.edu\.gh/);
    assert.match(body, /\/signup/, 'somebody without an account is offered one');
  });

  test('the health endpoint reports its configuration', async () => {
    const res = await fetch(`${APP}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body, 'object');
  });

  // =====================================================================
  // Customer
  // =====================================================================

  for (const path of ['/account', '/orders', '/partner/apply']) {
    test(`${path} is intact and guarded`, async () => {
      const r = await check(path);
      assert.ok(r.redirected || r.status === 200, `${path} answered ${r.status}`);
    });
  }

  test('an order detail route is intact', async () => {
    await check(`/orders/${ids.order ?? '00000000-0000-4000-8000-0000000000ff'}`, {
      allow404: true,
    });
  });

  // =====================================================================
  // Vendor
  // =====================================================================

  for (const path of ['/vendor', '/vendor/application', '/vendor/profile']) {
    test(`${path} is intact and guarded`, async () => {
      await check(path);
    });
  }

  test('a vendor order board route is intact', async () => {
    await check(`/vendor/${ids.vendor}`, { allow404: true });
  });

  // =====================================================================
  // Partner
  // =====================================================================

  for (const path of ['/partner', '/partner/offers', '/partner/delivery']) {
    test(`${path} is intact and guarded`, async () => {
      await check(path);
    });
  }

  // =====================================================================
  // Admin
  // =====================================================================

  const ADMIN = [
    '/admin',
    '/admin/orders',
    '/admin/orders?type=SCAN',
    '/admin/disputes',
    '/admin/vendors',
    '/admin/customers',
    '/admin/partners',
    '/admin/community',
    '/admin/payments',
    '/admin/finance',
    '/admin/settlements',
    '/admin/locations',
    '/admin/notifications',
    '/admin/pilot',
    '/admin/audit',
    '/admin/system',
    '/admin/money',
  ];

  for (const path of ADMIN) {
    test(`${path} is intact and guarded`, async () => {
      await check(path);
    });
  }

  test('admin detail routes are intact', async () => {
    await check(`/admin/customers/${ids.customer}`, { allow404: true });
    await check(`/admin/partners/${ids.partner}`, { allow404: true });
    await check(`/admin/vendors/${ids.vendor}`, { allow404: true });
    await check(`/admin/orders/${ids.order ?? '00000000-0000-4000-8000-0000000000ff'}`, {
      allow404: true,
    });
  });

  test('no admin route is reachable without a session', async () => {
    // The layout guard, asserted once rather than in every case above. It is
    // a convenience, not the boundary: every admin_* function re-checks
    // is_admin() in SQL, which the schema suite proves.
    for (const path of ['/admin', '/admin/settlements', '/admin/pilot']) {
      const res = await fetch(`${APP}${path}`, { redirect: 'manual' });
      assert.ok(
        res.status >= 300 && res.status < 400,
        `${path} answered ${res.status} to a signed-out request; it must redirect`
      );
    }
  });
});
