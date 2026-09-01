import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Credentials that must never reach a browser.
 *
 * The Arkesel API key is a bearer credential for an account with real money in
 * it: anyone holding it can send SMS at our cost, to numbers they choose. The
 * webhook secret is what stops anyone who finds the callback URL writing into
 * the notification log. Neither has any reason to exist client-side, and the
 * cheapest moment to catch one leaking is here.
 */

const ROOT = new URL('..', import.meta.url).pathname;

/** Every file Next.js would send to a browser. */
function clientBundleFiles() {
  const staticDir = join(ROOT, '.next', 'static');
  if (!existsSync(staticDir)) return null;

  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|css|map|json)$/.test(entry)) files.push(full);
    }
  };
  walk(staticDir);
  return files;
}

describe('server-only credentials', () => {
  const SERVER_ONLY = [
    'ARKESEL_API_KEY',
    'ARKESEL_WEBHOOK_SECRET',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SEND_SMS_HOOK_SECRET',
  ];

  test('none of them is ever read under a NEXT_PUBLIC_ name', () => {
    // A NEXT_PUBLIC_ prefix is what inlines a value into the browser bundle.
    // Naming one of these that way would ship it, silently and permanently.
    const config = readFileSync(join(ROOT, 'lib', 'config.js'), 'utf8');
    for (const name of SERVER_ONLY) {
      assert.doesNotMatch(config, new RegExp(`NEXT_PUBLIC_${name}`), name);
    }
  });

  test('each is reached only through the server-only accessor', () => {
    const config = readFileSync(join(ROOT, 'lib', 'config.js'), 'utf8');
    for (const name of ['ARKESEL_API_KEY', 'ARKESEL_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.match(
        config,
        new RegExp(`serverOnly\\('${name}'`),
        `${name} must go through serverOnly(), which throws in browser code`
      );
    }
  });

  test('the Arkesel environment is READ in exactly one module', () => {
    // The whole guarantee rests on there being one auditable place. A direct
    // process.env read anywhere else bypasses serverOnly() entirely.
    //
    // Naming a variable in a log line or a comment is fine and useful — the
    // webhook diagnostic tells you which one to set. Only a read counts.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) {
          const source = readFileSync(full, 'utf8');
          if (
            /process\.env\.(ARKESEL_|SUPABASE_SERVICE_ROLE_KEY|SEND_SMS_HOOK_SECRET)/.test(source)
          ) {
            offenders.push(full.replace(ROOT, ''));
          }
        }
      }
    };
    for (const dir of ['app', 'lib']) walk(join(ROOT, dir));

    assert.deepEqual(
      offenders.sort(),
      ['lib/config.js'],
      'server-only credentials must only be read in lib/config.js'
    );
  });

  test('no client component imports the SMS adapter or the webhook verifier', () => {
    // Both hold or handle secrets. A `'use client'` file importing either would
    // pull it into the browser bundle.
    const clientFiles = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.js')) {
          const source = readFileSync(full, 'utf8');
          if (/^['"]use client['"]/m.test(source)) clientFiles.push([full, source]);
        }
      }
    };
    walk(join(ROOT, 'app'));

    for (const [file, source] of clientFiles) {
      for (const forbidden of ['lib/sms', '@/lib/sms', 'arkesel', 'supabase/admin']) {
        assert.doesNotMatch(
          source,
          new RegExp(`from\\s+['"][^'"]*${forbidden}`),
          `${file.replace(ROOT, '')} must not import ${forbidden}`
        );
      }
    }
  });

  test('the built client bundle contains no secret value', (t) => {
    const files = clientBundleFiles();
    if (!files) return t.skip('no .next/static — run `npm run build` first');

    // Real values from the environment when there are any, so this catches the
    // actual credential and not merely its name.
    const values = SERVER_ONLY.map((name) => process.env[name]).filter(
      (value) => typeof value === 'string' && value.length >= 12
    );

    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const name of SERVER_ONLY) {
        assert.doesNotMatch(contents, new RegExp(name), `${name} named in ${file}`);
      }
      for (const value of values) {
        assert.equal(contents.includes(value), false, `a secret VALUE appears in ${file}`);
      }
    }
  });

  test('.env files are gitignored and only the example is tracked', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.env$/m);
    assert.match(gitignore, /^\.env\.local$/m);
  });

  test('.env.example carries names and never values', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const name of ['ARKESEL_API_KEY', 'ARKESEL_SENDER_ID', 'ARKESEL_WEBHOOK_SECRET']) {
      assert.match(example, new RegExp(`^#?\\s*${name}=`, 'm'), `${name} should be documented`);
    }
    // Every assignment must be empty or an obvious placeholder.
    for (const line of example.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) continue;
      const [, name, value] = match;
      if (!value) continue;
      assert.match(
        value,
        /^(fake|https?:\/\/|<|your-|sb_publishable_$)/,
        `${name} in .env.example looks like a real value`
      );
    }
  });
});
