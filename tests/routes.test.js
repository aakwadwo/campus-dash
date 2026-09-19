import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { asService, closePools, resetTransactionalState, ACTORS, VENDORS } from './helpers/db.js';
import { seededVendorSession } from './helpers/sessions.js';
import { paidOrder } from './helpers/flow.js';

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
    '/login/admin/forgot',
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
    // graduation years, or have lost the terms checkbox, and a status assertion
    // would call all three healthy. Every field the flow requires is named.
    const { body } = await check('/signup');

    for (const field of [
      'name="first_name"',
      'name="last_name"',
      'name="email"',
      // A GRADUATION YEAR RATHER THAN A LEVEL. `level` was wrong for three of
      // the four years it described, because nobody comes back in September to
      // move themselves up; this test asked for the field long after the form
      // stopped having it.
      'name="affiliation"',
      'name="gender"',
      'name="phone"',
      'name="accept_terms"',
    ]) {
      assert.ok(body.includes(field), `the sign-up form is missing ${field}`);
    }

    // STUDENT OR STAFF STARTS UNANSWERED, and the graduation year is a
    // student's question, so it is not on the page until "Student" is chosen.
    // Neither radio arrives checked, and no year is asked of somebody who may
    // be staff. (All four cohorts are pinned against GRADUATION_YEARS in
    // tests/customer-signup.test.js, the list the field renders from.)
    assert.ok(!/name="affiliation"[^>]*checked/.test(body), 'student or staff is not preselected');
    assert.ok(
      !body.includes('name="graduation_year" required'),
      'no year is asked before the choice'
    );

    // And both answers to a question that no longer has a third.
    for (const gender of ['MALE', 'FEMALE']) {
      assert.ok(new RegExp(`value=\\"${gender}\\"`).test(body), `${gender} is not offered`);
    }
    assert.ok(!/Prefer not to say/i.test(body), 'there is no third option');

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

  test('/signup offers no student ID upload and asks for no ID number', async () => {
    // Signing up to order lunch requires no document and no number. The ID
    // photograph belongs to the Partner application, the only review that looks
    // at one; the number was a second copy of something the verified school
    // address already established.
    const { body } = await check('/signup');
    assert.ok(!/type=\\?"file\\?"/i.test(body), 'no upload control on customer sign-up');
    assert.ok(!body.includes('student_id_number'), 'and no ID number field anywhere');
    assert.ok(!/student ID number/i.test(body), 'nor a label asking for one');
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

  for (const path of ['/account', '/account/settings', '/orders', '/partner/apply']) {
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

  for (const path of ['/vendor', '/vendor/application', '/vendor/profile', '/vendor/menu']) {
    test(`${path} is intact and guarded`, async () => {
      await check(path);
    });
  }

  test('a vendor order board route is intact', async () => {
    await check(`/vendor/${ids.vendor}`, { allow404: true });
  });

  /**
   * THE BUG THIS CATCHES. Every other test in this repository can be green
   * while this screen 500s, and one was: the store's order detail rendered
   * `handedToPartner`, an identifier a refactor had renamed out of existence,
   * so opening any order from the board threw a ReferenceError and the vendor
   * read "Something went wrong".
   *
   * NOTHING ELSE COULD SEE IT. The SQL suites prove vendor_order_detail()
   * returns the right row, and it always did; the signed-out route checks above
   * only ever reach the sign-in bounce, which is intact whatever the page does
   * afterwards. The failure lived in a CLIENT component, which executes only
   * when the whole pipeline actually renders it for a signed-in store.
   *
   * It was reported as a STUDENT vendor's problem, so both are asserted here.
   * "Student" is the CUSTOMER capability — a customer_profiles row on the same
   * identity — and it is granted below rather than assumed, because the seeded
   * vendor identities hold no such row. The point of the pair is that the
   * screen does not care: a store is a store.
   */
  describe('the store can open an order from its own board', () => {
    const sessions = [];
    let orderId = null;

    before(async () => {
      const order = await paidOrder({ vendorId: VENDORS.one, staff: ACTORS.vendor1Staff });
      orderId = order.order_id;
      // A STUDENT VENDOR: the same identity, plus the Customer capability.
      await asService((c) =>
        c.query(
          `insert into public.customer_profiles (user_id, level) values ($1, '100')
           on conflict (user_id) do nothing`,
          [ACTORS.vendor1Staff]
        )
      );
    });

    after(async () => {
      await asService((c) =>
        c.query('delete from public.customer_profiles where user_id = $1', [ACTORS.vendor1Staff])
      );
      await Promise.all(sessions.map((session) => session.restore()));
      // Orders are not DELETEd — order_events is append-only and the cascade
      // trips its trigger. Truncating is how this suite keeps runs independent.
      await resetTransactionalState();
    });

    /** The route as a signed-in browser would request it. */
    async function checkAs(userId, path) {
      const session = await seededVendorSession(userId);
      sessions.push(session);
      const res = await fetch(`${APP}${path}`, {
        headers: {
          cookie: Object.entries(session.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join('; '),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      });
      const body = res.status === 200 ? await res.text() : '';
      return { status: res.status, body };
    }

    test('a student vendor opens their own order detail', async () => {
      const { status, body } = await checkAs(
        ACTORS.vendor1Staff,
        `/vendor/${VENDORS.one}/orders/${orderId}`
      );
      assert.equal(status, 200, 'the store that owns this order must be able to read it');
      assert.ok(
        !ERROR_BOUNDARY.test(body),
        'the order detail rendered the error boundary, which Next serves with a 200'
      );
      assert.ok(body.includes('Ready for pickup'), 'the one button a store has is missing');
    });

    /**
     * ORDER DETAIL IS STILL SOMEBODY ELSE'S BUSINESS. vendor_order_detail()
     * returns nothing to a store that does not own the order, so the page
     * 404s rather than answering a permissions message that would confirm the
     * order exists. Fixing the render must not have widened that by an inch.
     */
    test('another vendor cannot open it, and is not told it exists', async () => {
      const { status } = await checkAs(
        ACTORS.vendor2Staff,
        `/vendor/${VENDORS.one}/orders/${orderId}`
      );
      assert.equal(status, 404, "a store must not reach another store's order");
    });
  });

  /**
   * THE STEP THAT DID NOT ADVANCE. The store form and the code form used to be
   * derived from two action states that could never agree, so the SMS went out
   * and the screen stayed put. A route test cannot press the button, but it can
   * assert the shape the fix depends on: the details form is what renders
   * first, and every field it carries into the code step is present.
   */
  test('/vendor/signup renders the store form, with description and category apart', async () => {
    const { body } = await check('/vendor/signup');

    for (const field of [
      'name="applicant_name"',
      'name="store_name"',
      'name="is_student"',
      'name="description"',
      'name="category_id"',
      'name="phone"',
      'name="accept_terms"',
    ]) {
      assert.ok(body.includes(field), `the store form is missing ${field}`);
    }

    // TWO DIFFERENT QUESTIONS, labelled as two. "What do you sell?" above a
    // category dropdown reads as one question asked twice.
    assert.match(body, /Business description/i);
    assert.match(body, /Business category/i);

    // The code step is NOT what renders first — it appears only once a code has
    // actually been sent.
    assert.ok(!body.includes('name="token"'), 'the code box is the second screen');
    assert.match(body, /Send verification code/i);
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

  /**
   * THE WHOLE CONSOLE, and it is now the same list as the navigation bar plus
   * settlements.
   *
   * WHAT WENT, AND WHY. /admin/audit, /admin/money, /admin/finance,
   * /admin/system, /admin/notifications, /admin/disputes and /admin/community
   * were all unlinked — trimmed off the bar because an operator running a
   * campus food service does not navigate by them — but still reachable by URL,
   * still rendering, and still four overlapping views of the same money.
   *
   * An unlinked page is worse than a deleted one: it rots, nobody tests it by
   * hand, and it is exactly where a stale read model survives a schema change.
   *
   * THE BACKEND IS UNTOUCHED. admin_actions, admin_list_actions() and every
   * reconciliation function still exist and are still written to — removing a
   * page does not remove an audit trail, and tests/audit.test.js holds that.
   */
  const ADMIN = [
    '/admin',
    '/admin/orders',
    '/admin/orders?type=SCAN',
    '/admin/vendors',
    '/admin/customers',
    '/admin/partners',
    '/admin/payments',
    '/admin/settlements',
    '/admin/locations',
    '/admin/pilot',
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

  test('no admin route is reachable without a session, and it sends them to the ADMIN door', async () => {
    // The layout guard, asserted once rather than in every case above. It is
    // a convenience, not the boundary: every admin_* function re-checks
    // is_admin() in SQL, which the schema suite proves.
    //
    // THE BUG THIS CATCHES. "It redirected" was the whole assertion, and the
    // guard redirected to /login — the CUSTOMER screen, which asks for an
    // @acity.edu.gh address and emails a code. An administrator's credential
    // is a password and the row may have no school address at all, so the
    // console was unreachable while this test stayed green. Where it lands is
    // the assertion.
    for (const path of ['/admin', '/admin/settlements', '/admin/pilot']) {
      const res = await fetch(`${APP}${path}`, { redirect: 'manual' });
      assert.ok(
        res.status >= 300 && res.status < 400,
        `${path} answered ${res.status} to a signed-out request; it must redirect`
      );

      const location = res.headers.get('location') ?? '';
      const target = new URL(location, APP);
      assert.equal(
        target.pathname,
        '/login/admin',
        `${path} sent a signed-out visitor to ${location}; administrators sign in with a password`
      );
      // The console's guard lives in the admin LAYOUT, which is a server
      // component and does not know which of its pages was asked for, so the
      // destination it carries is the console itself rather than the deep
      // link. What matters is that it carries one, and that it is a path
      // inside the console.
      assert.match(
        target.searchParams.get('next') ?? '',
        /^\/admin/,
        `${path} lost the destination on the way to sign-in`
      );
    }
  });

  /**
   * The recovery pages are the one place a password can be SET from a browser,
   * so the things that keep them from being a way in are asserted here rather
   * than left to the reader: the form must not disclose whether an address is
   * an administrator, and the page that sets a password must refuse to render
   * for somebody who simply typed its path with no recovery session.
   */
  test('the reset form does not disclose who is an administrator', async () => {
    const { body } = await check('/login/admin/forgot');
    assert.ok(body.includes('name="email"'), 'recovery starts from an email address');
    assert.ok(
      !/type=\\?"password\\?"/i.test(body),
      'asking for a password here would be asking the locked-out person for the thing they lost'
    );
  });

  test('the password form is unreachable without a recovery session', async () => {
    // Fetched directly rather than through check(), because the assertion is
    // about WHERE it redirects and check() does not surface the header.
    const res = await fetch(`${APP}/login/admin/reset`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(
      res.status >= 300 && res.status < 400,
      'typing the reset path with no recovery link must not render a password form'
    );
    assert.match(
      res.headers.get('location') ?? '',
      /\/login\/admin\/forgot/,
      'it should send them to ask for a link'
    );
  });

  test('the admin door asks for a password, and never for a code', async () => {
    const { body } = await check('/login/admin');
    assert.ok(body.includes('name="email"'), 'the administrator is identified by email');
    assert.ok(
      /type=\\?"password\\?"/i.test(body),
      'the administrator credential is a password, not a code'
    );
    assert.ok(
      !body.includes('name="token"'),
      'the admin door must not turn into the customer OTP screen'
    );
  });
});
