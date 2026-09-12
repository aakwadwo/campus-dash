#!/usr/bin/env node
/**
 * Sets a new password on an EXISTING Campus Dash administrator.
 *
 *   node --env-file-if-exists=.env.local scripts/reset-admin-password.mjs
 *   npm run admin:password
 *
 * WHY THIS IS NOT A PAGE, AND NEVER WILL BE
 * -----------------------------------------
 * `/login/admin` is the one door with no code behind it, because operational
 * access must not depend on a message arriving. The same reasoning forbids the
 * usual "email me a reset link": it would make the console recoverable by
 * whoever holds a mailbox, and put a password-reset form on the public internet
 * in front of the one account that can cancel orders and move money. So the
 * reset runs where the first administrator was created — out-of-band, against
 * the service-role key, which only ever exists on a server.
 *
 * WHAT THIS DELIBERATELY CANNOT DO
 * --------------------------------
 * It sets a password and nothing else. It does not create an account, it does
 * not promote one, it does not touch `is_admin`, an email address, a phone
 * number or a name. If the address does not already belong to an administrator
 * it refuses outright — so this is not a back door onto a customer's, a
 * vendor's or a Partner's account, and a stolen service-role key gains nothing
 * here that it did not already have.
 *
 * Creating the FIRST administrator is still scripts/create-admin.mjs. Two
 * scripts, because promoting somebody and helping somebody back in are
 * different acts and the second one should not be able to perform the first.
 *
 * NOTHING IS COMMITTED, LOGGED OR ECHOED
 * --------------------------------------
 * The password is read from a hidden prompt, or from CAMPUS_DASH_ADMIN_PASSWORD
 * for non-interactive use. It is never taken as a command-line argument,
 * because that would put it in shell history and in the process table. It is
 * never printed back.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createClient } from '@supabase/supabase-js';

const URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '')
  .trim()
  .replace(/\/(rest|auth|storage|realtime)\/v1\/?$/, '')
  .replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Run through npm (`npm run admin:password`) so .env.local is loaded.'
  );
  process.exit(1);
}

// Same two input modes as create-admin.mjs: a person at a terminal, or a setup
// script on a pipe. Sequential readline prompts are unreliable against a pipe,
// so a non-interactive run reads every line up front and answers from a queue.
const interactive = stdin.isTTY;
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;

const piped = interactive
  ? []
  : (
      await new Promise((resolve) => {
        let buffer = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (chunk) => (buffer += chunk));
        stdin.on('end', () => resolve(buffer));
        stdin.on('error', () => resolve(buffer));
      })
    ).split('\n');

async function ask(question) {
  if (interactive) return rl.question(question);
  const next = piped.shift();
  if (next === undefined) throw new Error(`No input supplied for: ${question.trim()}`);
  stdout.write(`${question}${next}\n`);
  return next;
}

/** Reads a line without echoing it. */
async function secret(question) {
  if (!interactive) {
    const next = piped.shift();
    if (next === undefined) throw new Error('No password supplied.');
    stdout.write(`${question}\n`);
    return next;
  }
  stdout.write(question);
  const previous = rl.output;
  rl.output = { write: () => {} };
  const answer = await rl.question('');
  rl.output = previous;
  stdout.write('\n');
  return answer;
}

/**
 * Walks every page rather than assuming one. listUsers caps its page size, and
 * "the administrator was not found" is the single most confusing thing this
 * script could say wrongly.
 */
async function findByEmail(admin, email) {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users ?? [];
    const match = users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (match) return match;
    if (users.length < 200) return null;
  }
  return null;
}

try {
  console.log('\nCampus Dash — set an administrator password');
  console.log(`Project: ${URL}\n`);

  const email = (await ask('Administrator email address: ')).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That is not an email address.');

  const admin = createClient(URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const account = await findByEmail(admin, email);
  if (!account) {
    throw new Error(
      `No account exists for ${email}. This script only sets a password on an ` +
        'administrator that already exists — use `npm run admin:create` to make one.'
    );
  }

  // THE GATE. is_admin lives on public.users, and it is read here rather than
  // inferred from anything the auth record says, because it is the same column
  // my_capabilities() and every admin_* function consult. An address that is
  // not already an administrator gets nothing from this script.
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('id, full_name, is_admin, is_suspended')
    .eq('id', account.id)
    .maybeSingle();
  if (profileError) throw profileError;

  if (!profile) {
    throw new Error(
      `${email} has no public.users row, so it is not an administrator. ` +
        'Use `npm run admin:create`.'
    );
  }
  if (!profile.is_admin) {
    throw new Error(
      `${email} is not an administrator. This script will not set a password on ` +
        'an ordinary account — promoting one is `npm run admin:create`, deliberately.'
    );
  }
  if (profile.is_suspended) {
    throw new Error(
      `${email} is suspended. Lift the suspension in the console first; a new ` +
        'password would not let this account in.'
    );
  }

  console.log(`\nAdministrator found: ${profile.full_name ?? email}`);

  const password =
    process.env.CAMPUS_DASH_ADMIN_PASSWORD ?? (await secret('New password (hidden): '));
  if (password.length < 12) {
    throw new Error('Use at least 12 characters. This account can cancel orders and move money.');
  }
  if (!process.env.CAMPUS_DASH_ADMIN_PASSWORD) {
    const again = await secret('Confirm new password: ');
    if (again !== password) throw new Error('The passwords did not match.');
  }

  // ONLY the password. Not the email, not the phone, not the name — passing any
  // of those would make this script able to reshape the identity it is meant
  // only to let back in. `is_admin` is not reachable from here at all.
  const { error: updateError } = await admin.auth.admin.updateUserById(account.id, { password });
  if (updateError) throw updateError;

  console.log('\n  Password set.');
  console.log(`  Sign in at /login/admin with ${email} and the new password.`);
  console.log('  Nothing else about the account changed.\n');
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
