import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The hosted upgrade path applies what is pending, and only that.
 *
 * WHY THIS EXISTS. The script once carried a fixed list and replayed all of it
 * on every run. The first time that list fell behind, the hosted database never
 * got seven migrations and the vendor's ON switch failed. The next time, it
 * re-ran migrations hosted already had, and put older versions of functions
 * back over the ones later migrations had written. It now reads what has been
 * applied from supabase_migrations.schema_migrations.
 *
 * RUN AGAINST THE LOCAL STACK ONLY. The test runner loads .env.local, which may
 * point SUPABASE_DB_URL at a hosted project, so the child is given the local
 * URL explicitly and the script honours it over the file.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_PGPORT || 54322}/postgres`;

const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort();
const newest = migrations[migrations.length - 1];
const previous = migrations[migrations.length - 2];
const versionOf = (base) => base.split('_')[0];
const nameOf = (base) => base.slice(base.indexOf('_') + 1);

const db = new pg.Client({ connectionString: LOCAL });
await db.connect();

const recorded = async () =>
  (await db.query('select version from supabase_migrations.schema_migrations')).rows.map(
    (r) => r.version
  );

const forget = (base) =>
  db.query('delete from supabase_migrations.schema_migrations where version = $1', [
    versionOf(base),
  ]);

const remember = (base) =>
  db.query(
    `insert into supabase_migrations.schema_migrations (version, name, statements)
     values ($1, $2, '{}') on conflict (version) do nothing`,
    [versionOf(base), nameOf(base)]
  );

function deploy(...args) {
  assert.match(LOCAL, /127\.0\.0\.1/, 'never anything but the local stack');
  try {
    const out = execFileSync('bash', ['scripts/deploy-hosted-migrations.sh', ...args], {
      cwd: ROOT,
      env: { ...process.env, SUPABASE_DB_URL: LOCAL },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
}

describe('deploy-hosted-migrations.sh', () => {
  after(async () => {
    for (const base of migrations) await remember(base);
    await db.end();
  });

  test('with every migration recorded, nothing is pending and verification passes', async () => {
    assert.equal((await recorded()).length, migrations.length, 'local history is complete');

    const dry = deploy('--dry-run');
    assert.equal(dry.code, 0, dry.out);
    assert.match(dry.out, /pending: none/);

    const run = deploy();
    assert.equal(run.code, 0, run.out);
    assert.doesNotMatch(run.out, /^--> \d{14}_/m, 'it applied nothing');
    assert.doesNotMatch(run.out, /= 0$/m, 'and every check passed');
    // Every check is reported, not only the last one psql happened to print.
    assert.equal(run.out.match(/ = 1$/gm)?.length, 8, run.out);
  });

  test('applies only what is not recorded, and records it in the same transaction', async () => {
    await forget(newest);

    const dry = deploy('--dry-run');
    assert.match(dry.out, new RegExp(`pending: ${newest}$`, 'm'));
    assert.equal(
      (await recorded()).includes(versionOf(newest)),
      false,
      'a dry run changes nothing'
    );

    const run = deploy();
    assert.equal(run.code, 0, run.out);
    const applied = [...run.out.matchAll(/^--> (\d{14}_\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(applied, [newest], 'that one and no other');
    assert.ok((await recorded()).includes(versionOf(newest)), 'and it is recorded');
  });

  test('refuses to apply out of order, and changes nothing', async () => {
    await forget(previous);
    const before = await recorded();

    const run = deploy();
    assert.notEqual(run.code, 0);
    assert.match(run.out, /Refusing to apply out of order/);
    assert.deepEqual(await recorded(), before);

    await remember(previous);
  });
});
