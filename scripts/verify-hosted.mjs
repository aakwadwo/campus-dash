#!/usr/bin/env node
/**
 * Checks a Supabase project from the outside, over HTTPS, using only the two
 * API keys — no database password.
 *
 *   npm run verify:hosted
 *
 * It exists because "the schema installed" and "the security model survived the
 * install" are different claims. The dangerous failure is not a missing table,
 * which is obvious; it is a table or function that came out reachable by
 * `anon`, which looks like nothing at all until somebody finds it.
 *
 * So the client-side checks here do not read a grant and trust it. They send
 * the request — the INSERT, the SELECT on the secrets table, the call to
 * confirm_payment — with the publishable key, exactly as a browser would, and
 * assert it is refused.
 *
 * Run it against the local stack first to see what a healthy project says:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   node scripts/verify-hosted.mjs
 */

const URL_ = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/(rest|auth|storage|realtime)\/v1\/?$/, '')
  .replace(/\/+$/, '');
const CLIENT_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !CLIENT_KEY || !SERVICE_KEY) {
  console.error('Missing Supabase URL, publishable key or service-role key.');
  process.exit(1);
}

const results = [];
function record(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/**
 * Credentials WITHOUT a content-type.
 *
 * Storage runs on Fastify, which rejects a request that declares
 * `content-type: application/json` and then sends no body:
 *
 *   {"statusCode":"400","error":"FastifyError",
 *    "message":"Body cannot be empty when content-type is set to 'application/json'"}
 *
 * Every bodyless GET and DELETE below must therefore use this rather than
 * headers(). The cleanup DELETE used headers(), so it failed on every single
 * run — silently, because nobody looked at the response.
 */
function auth(key) {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function req(path, { key = CLIENT_KEY, method = 'GET', body } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: headers(key),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** PostgREST answers a missing privilege with 401 or 403 and a pg error code. */
const REFUSED = new Set([401, 403, 404]);

console.log(`\nCampus Dash — verifying ${URL_}\n`);

// --- Reachability -----------------------------------------------------------
console.log('Connectivity');
{
  const r = await req('/rest/v1/', { key: SERVICE_KEY });
  record(r.status === 200, 'REST API answers');

  const settings = await req('/auth/v1/settings');
  record(settings.status === 200, 'Auth API answers');
  record(
    settings.json?.external?.phone === true,
    'phone sign-in is enabled',
    settings.json?.external?.phone === true
      ? ''
      : 'Authentication → Sign In / Providers → Phone → enable'
  );
  record(settings.json?.external?.email === true, 'email sign-in is enabled (administrators)');
}

// --- Schema present ---------------------------------------------------------
console.log('\nSchema');
const spec = await req('/rest/v1/', { key: SERVICE_KEY });
const paths = Object.keys(spec.json?.paths ?? {});
const tables = paths.filter((p) => /^\/[a-z_]+$/.test(p) && p !== '/').map((p) => p.slice(1));
const rpcs = paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5));

const EXPECTED_TABLES = [
  'admin_actions',
  'allocations',
  'idempotency_keys',
  'locations',
  'menu_items',
  'notification_events',
  'order_events',
  'order_items',
  'order_secrets',
  'orders',
  'partner_profiles',
  'payments',
  'payouts',
  'pricing_config',
  'settlement_runs',
  'terms_acceptances',
  'terms_documents',
  'users',
  'vendor_users',
  'vendors',
  'webhook_events',
];
const missingTables = EXPECTED_TABLES.filter((t) => !tables.includes(t));
record(
  missingTables.length === 0,
  `all ${EXPECTED_TABLES.length} tables exist`,
  missingTables.length ? `missing: ${missingTables.join(', ')}` : `found ${tables.length}`
);

const KEY_FUNCTIONS = [
  'submit_order',
  'quote_order',
  'vendor_accept_order',
  'vendor_mark_ready',
  'partner_accept_delivery',
  'partner_complete_delivery',
  'confirm_payment',
  'create_order_allocations',
  'create_settlement_run',
  'my_capabilities',
  'expire_stale_orders',
  'expire_partner_search',
  'expire_stale_payments',
];
const missingFns = KEY_FUNCTIONS.filter((f) => !rpcs.includes(f));
record(
  missingFns.length === 0,
  'the core functions exist',
  missingFns.length ? `missing: ${missingFns.join(', ')}` : `found ${rpcs.length} functions`
);

// --- Reference data ---------------------------------------------------------
console.log('\nReference data');
{
  const cfg = await req('/rest/v1/rpc/platform_config', { method: 'POST', body: {} });
  const row = Array.isArray(cfg.json) ? cfg.json[0] : cfg.json;
  record(
    row?.service_fee_bps === 1000,
    'service fee is 10% (1000 bps)',
    `got ${row?.service_fee_bps}`
  );
  record(
    row?.delivery_fee_pesewas === 500,
    'delivery fee is GH₵5.00 (500 pesewas)',
    `got ${row?.delivery_fee_pesewas}`
  );

  // current_terms() takes the audience, so ask for each of the three.
  const published = [];
  for (const audience of ['CUSTOMER', 'VENDOR', 'PARTNER']) {
    const r = await req('/rest/v1/rpc/current_terms', {
      method: 'POST',
      body: { p_audience: audience },
    });
    if (Array.isArray(r.json) && r.json.length > 0) published.push(audience);
  }
  record(
    published.length === 3,
    'terms documents are published for all three audiences',
    published.join(', ') || 'none'
  );
}

// --- What a browser can do --------------------------------------------------
console.log('\nClient privileges (sent with the publishable key, as a browser would)');
{
  const read = await req('/rest/v1/vendors?select=id&limit=1');
  record(read.status === 200, 'a client can read the vendor catalogue');

  const write = await req('/rest/v1/vendors', {
    method: 'POST',
    body: { name: 'verify-hosted probe', phone: '+233200000999', status: 'ACTIVE' },
  });
  record(REFUSED.has(write.status), 'a client CANNOT insert a vendor', `HTTP ${write.status}`);

  for (const table of ['order_secrets', 'webhook_events', 'idempotency_keys', 'admin_actions']) {
    const r = await req(`/rest/v1/${table}?select=*&limit=1`);
    record(REFUSED.has(r.status), `a client CANNOT read ${table}`, `HTTP ${r.status}`);
  }

  for (const fn of [
    'confirm_payment',
    'create_order_allocations',
    'create_settlement_run',
    'expire_stale_orders',
    'admin_pilot_metrics',
    'submit_order_for',
  ]) {
    const r = await req(`/rest/v1/rpc/${fn}`, { method: 'POST', body: {} });
    record(REFUSED.has(r.status), `a client CANNOT call ${fn}()`, `HTTP ${r.status}`);
  }
}

// --- Storage ----------------------------------------------------------------
console.log('\nStorage');
{
  const bucket = await req('/storage/v1/bucket/partner-documents', { key: SERVICE_KEY });
  record(bucket.status === 200, 'the partner-documents bucket exists');
  record(bucket.json?.public === false, 'it is private', `public=${bucket.json?.public}`);

  // An empty listing proves nothing — an empty bucket returns [] too. So put a
  // real object in with the service role and try to reach it as a browser.
  //
  // The mime type matters: uploading text/plain is rejected for being the wrong
  // type, which would have made this pass for entirely the wrong reason.
  //
  // The name is unique per run and the upload upserts. Both matter: Storage's
  // POST is create-only, so a fixed name plus one failed cleanup wedges this
  // check permanently. That is exactly what happened, and the symptom was a
  // baffling HTTP 400 carrying a "statusCode":"409" body.
  const probe = `verify-hosted-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const objectUrl = `${URL_}/storage/v1/object/partner-documents/${probe}`;

  const upload = (key) =>
    fetch(objectUrl, {
      method: 'POST',
      headers: { ...auth(key), 'content-type': 'image/jpeg', 'x-upsert': 'true' },
      body: 'probe',
    });

  // Asserting on the BODY as well as the status, here and below. A non-200 on
  // its own is not evidence of a security control — a malformed request is also
  // a non-200, and that is precisely how this section came to contain a check
  // that passed for the wrong reason.
  const clientUpload = await upload(CLIENT_KEY);
  const clientUploadBody = await clientUpload.text();
  record(
    clientUpload.status !== 200 && /row-level security|Unauthorized/i.test(clientUploadBody),
    'a client cannot upload into the private bucket',
    clientUploadBody.slice(0, 80)
  );

  const seeded = await upload(SERVICE_KEY);
  if (seeded.status !== 200) {
    record(
      false,
      'could not place a probe object to test document privacy',
      `HTTP ${seeded.status} ${(await seeded.text()).slice(0, 120)}`
    );
  } else {
    try {
      // A signed URL is the only way an admin ever sees one of these, and it is
      // minted server-side. A client must not be able to mint its own.
      const sign = await fetch(`${URL_}/storage/v1/object/sign/partner-documents/${probe}`, {
        method: 'POST',
        headers: headers(CLIENT_KEY),
        body: JSON.stringify({ expiresIn: 60 }),
      });
      const signBody = await sign.text();
      record(
        sign.status !== 200 && /not_found|NoSuchKey|Unauthorized/i.test(signBody),
        'a client cannot mint a signed URL for a document that DOES exist',
        signBody.slice(0, 80)
      );

      // Storage answers a client with "NoSuchKey" rather than a 403: RLS hides
      // the row, so the object does not exist as far as the caller is concerned.
      // That is the right behaviour — a 403 would confirm the file is there.
      const download = await fetch(objectUrl, { headers: auth(CLIENT_KEY) });
      const downloadBody = await download.text();
      record(
        download.status !== 200 && /not_found|NoSuchKey|Unauthorized/i.test(downloadBody),
        'a client cannot download it directly',
        downloadBody.slice(0, 80)
      );

      // And the server genuinely can, which is what makes the two refusals
      // above evidence about permission rather than about a missing file.
      const serviceRead = await fetch(objectUrl, { headers: auth(SERVICE_KEY) });
      record(
        serviceRead.status === 200,
        'the server CAN read it, so those refusals are about permission',
        `HTTP ${serviceRead.status}`
      );
    } finally {
      // Runs whatever happened above. This used to sit on the happy path only,
      // and it used to send a JSON content-type with no body, so it failed
      // silently and orphaned the probe object on every run.
      const cleanup = await fetch(objectUrl, { method: 'DELETE', headers: auth(SERVICE_KEY) });
      record(cleanup.status === 200, 'the probe object was cleaned up', `HTTP ${cleanup.status}`);
    }
  }
}

// --- Summary ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ''}`);
  console.log(
    '\nThe scheduled sweeps cannot be checked from out here — pg_cron is not\n' +
      'reachable over the API. Confirm them at /admin/pilot once you can sign in.\n'
  );
  process.exitCode = 1;
} else {
  console.log(
    '\nThe scheduled sweeps cannot be checked from out here — pg_cron is not\n' +
      'reachable over the API. Confirm them at /admin/pilot once you can sign in.\n'
  );
}
