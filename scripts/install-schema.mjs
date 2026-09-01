#!/usr/bin/env node
/**
 * Installs supabase/schema.sql into a database.
 *
 *   SUPABASE_DB_URL=postgresql://… npm run db:install
 *
 * Intended for a hosted Supabase project. The local stack does not need it —
 * `npm run db:reset` applies the migrations and the seed.
 *
 * The whole file is sent as one statement batch, so Postgres runs it in a
 * single implicit transaction: either the entire schema installs or nothing
 * does. A half-installed schema is the one outcome worth ruling out, because
 * the missing half is usually the grants.
 *
 * schema.sql ends with assertions that check its own work — RLS on every table,
 * no client DML, deny-by-default privileges — so a silent partial success
 * cannot report as a clean install.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SUPABASE_DB_URL;

if (!url) {
  console.error(
    'Set SUPABASE_DB_URL to the target database.\n\n' +
      '  Hosted: dashboard → Connect → Session pooler. It contains the database\n' +
      '  password, so keep it in .env.local and never commit it.\n'
  );
  process.exit(1);
}

const local = /(?:localhost|127\.0\.0\.1)/.test(url);
const client = new pg.Client({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  // Some of these statements are slow on a cold hosted project.
  statement_timeout: 0,
});

const sql = readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8');

await client.connect();
// The install-time assertions RAISE NOTICE on success. Surface them.
client.on('notice', (n) => console.log(`  ${n.message}`));

try {
  const { rows } = await client.query('select current_database() db, current_user usr');
  console.log(`Installing supabase/schema.sql into ${rows[0].db} as ${rows[0].usr}…`);
  await client.query(sql);
  console.log('\n  Done. Verify with: npm run db:snapshot\n');
} catch (error) {
  console.error(`\n  Install failed and rolled back: ${error.message}`);
  if (error.position) console.error(`  (at character ${error.position})`);
  if (/pg_cron/.test(error.message)) {
    console.error(
      '\n  pg_cron must be enabled for the expiry sweeps. Turn it on in the\n' +
        '  dashboard under Database → Extensions, then run this again.'
    );
  }
  process.exitCode = 1;
} finally {
  await client.end();
}
