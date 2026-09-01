#!/usr/bin/env node
/**
 * Regenerates supabase/schema.sql — the canonical, from-empty bootstrap of the
 * Campus Dash database.
 *
 * WHY THIS IS GENERATED, NOT HAND-MAINTAINED
 * ------------------------------------------
 * supabase/migrations/ is the history: 40-odd files that add a column, replace
 * a function body, tighten a grant, drop something a later phase made wrong.
 * Concatenating them is not the schema — it is a recording of how we got here,
 * and it would install the mistakes as well as the corrections.
 *
 * So the canonical schema is derived from a database that has actually applied
 * every migration in order, which resolves dropped columns, replaced functions,
 * altered policies and changed grants to their final state by construction.
 *
 * WHAT THIS SCRIPT ADDS ON TOP OF pg_dump
 * ---------------------------------------
 * 1. DEFAULT PRIVILEGES. pg_dump reports the resulting ACL in positive form
 *    ("GRANT ALL ON FUNCTIONS TO postgres, service_role"). Replaying that onto
 *    a fresh Supabase project does NOT reproduce our state: Supabase ships
 *    default ACLs that name anon and authenticated explicitly, and a GRANT does
 *    not remove them. The revokes have to run FIRST, before anything is
 *    created, or every table and function is born reachable by anon.
 * 2. Objects outside `public`: the auth.users provisioning triggers, the
 *    private storage bucket, and the pg_cron schedules.
 * 3. Reference data the product cannot run without — the pricing_config
 *    singleton and the placeholder terms documents. Development actors stay in
 *    supabase/seed.sql, which this file never touches.
 *
 * Usage:  npm run db:reset && node scripts/build-schema.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'supabase', 'schema.sql');

const work = mkdtempSync(join(tmpdir(), 'campus-dash-schema-'));
const dumpPath = join(work, 'public.sql');

try {
  execFileSync('npx', ['supabase', 'db', 'dump', '--local', '--schema', 'public', '-f', dumpPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const dump = readFileSync(dumpPath, 'utf8');

  // Drop pg_dump's preamble through `COMMENT ON SCHEMA public`. We re-issue the
  // session settings ourselves, and re-owning or re-commenting the public
  // schema is not ours to do on a hosted project.
  const marker = 'COMMENT ON SCHEMA "public" IS \'standard public schema\';';
  const at = dump.indexOf(marker);
  if (at === -1) throw new Error('unexpected pg_dump layout: schema comment not found');
  let body = dump.slice(at + marker.length);

  // pg_dump renders the FINAL default-ACL as grants. Applied to a fresh
  // Supabase project those are additive no-ops that leave anon/authenticated in
  // place, so they are misleading at best. The authoritative revokes are in the
  // preamble below instead.
  body = body.replace(/^ALTER DEFAULT PRIVILEGES[^\n]*\n/gm, '');
  body = body.replace(/\n{4,}/g, '\n\n\n').trimEnd();

  const preamble = readFileSync(join(ROOT, 'supabase', 'schema', '00-preamble.sql'), 'utf8');
  const epilogue = readFileSync(join(ROOT, 'supabase', 'schema', '99-epilogue.sql'), 'utf8');

  writeFileSync(OUT, `${preamble.trimEnd()}\n\n${body}\n\n${epilogue.trimEnd()}\n`);
  console.log(`Wrote ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
