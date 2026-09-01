#!/usr/bin/env node
/**
 * Creates the first Campus Dash administrator, or promotes an existing account.
 *
 *   node --env-file-if-exists=.env.local scripts/create-admin.mjs
 *   npm run admin:create
 *
 * WHY THIS IS A SCRIPT AND NOT A PAGE
 * -----------------------------------
 * `is_admin` is a column on public.users, and there is no statement any client
 * can issue that touches it: `authenticated` holds SELECT and nothing else on
 * that table, and every admin function re-checks is_admin() in its own body. So
 * there is no in-app path to the first administrator, by design — bootstrapping
 * requires the service-role key, which only ever exists on a server.
 *
 * WHY THE ADMIN ALSO GETS A PHONE NUMBER
 * --------------------------------------
 * Administrators sign in with email and password, so that operational access
 * does not depend on an SMS arriving. But public.users is provisioned by a
 * trigger on phone confirmation, and its `phone` column is NOT NULL and unique —
 * one account per person, with one identity. So the account carries both: the
 * phone is the identity, the password is the credential.
 *
 * NOTHING IS COMMITTED, LOGGED OR ECHOED
 * --------------------------------------
 * The password is read from a hidden prompt, or from CAMPUS_DASH_ADMIN_PASSWORD
 * for non-interactive use. It is never taken as a command-line argument, because
 * that would put it in shell history and in the process table. It is never
 * printed back.
 *
 * NOT AUDITED, AND THAT IS DELIBERATE
 * -----------------------------------
 * admin_actions records who did what. The first promotion has no "who": there
 * is no administrator yet to attribute it to. Every later administrative change
 * — including anything this person does — is audited normally.
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
      'Run through npm (`npm run admin:create`) so .env.local is loaded.'
  );
  process.exit(1);
}

/**
 * Two input modes, because this script is run both by a person and by a setup
 * script. Sequential readline prompts are unreliable against a pipe — the
 * stream ends while a later question is still waiting — so a non-interactive
 * run reads every line up front and answers from that queue instead.
 */
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

/** Ghana local or international, normalised to E.164 — same rule as lib/sms. */
function normalisePhone(input) {
  const digits = String(input).replace(/[^\d+]/g, '');
  if (/^\+233\d{9}$/.test(digits)) return digits;
  if (/^233\d{9}$/.test(digits)) return `+${digits}`;
  if (/^0\d{9}$/.test(digits)) return `+233${digits.slice(1)}`;
  return null;
}

try {
  console.log('\nCampus Dash — create an administrator');
  console.log(`Project: ${URL}\n`);

  const email = (await ask('Email address: ')).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That is not an email address.');

  const rawPhone = await ask('Phone number (e.g. 0201234567): ');
  const phone = normalisePhone(rawPhone);
  if (!phone) throw new Error('That is not a Ghanaian phone number.');

  const fullName = (await ask('Full name: ')).trim();
  if (!fullName) throw new Error('A name is required — it is what the audit log shows.');

  const password = process.env.CAMPUS_DASH_ADMIN_PASSWORD ?? (await secret('Password (hidden): '));
  if (password.length < 12) {
    throw new Error('Use at least 12 characters. This account can cancel orders and move money.');
  }
  if (!process.env.CAMPUS_DASH_ADMIN_PASSWORD) {
    const again = await secret('Confirm password: ');
    if (again !== password) throw new Error('The passwords did not match.');
  }

  const admin = createClient(URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // GoTrue stores phone numbers without the leading '+' and matches on that
  // form at sign-in. public.users keeps the '+' — the provisioning trigger adds
  // it back. Getting this wrong creates a second auth user that then collides on
  // public.users' unique phone, and the symptom is an unfindable account.
  const gotruePhone = phone.slice(1);

  let userId;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    phone: gotruePhone,
    email_confirm: true,
    phone_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError) {
    // Already registered: set the password on the existing account rather than
    // making a second identity for the same person.
    const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const existing = list?.users?.find((u) => u.email === email || u.phone === gotruePhone);
    if (!existing) throw createError;

    console.log('\nAn account already exists for that email or phone — updating it.');
    const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, {
      email,
      password,
      phone: gotruePhone,
      email_confirm: true,
      phone_confirm: true,
    });
    if (updateError) throw updateError;
    userId = existing.id;
  } else {
    userId = created.user.id;
  }

  // The profile row is created by the on_auth_user_created trigger. Confirm it
  // landed rather than assuming — if the trigger is missing, the account would
  // otherwise look fine right up until the first sign-in fails.
  const { data: profile, error: profileError } = await admin
    .from('users')
    .select('id, phone, full_name, is_admin')
    .eq('id', userId)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile) {
    throw new Error(
      'No public.users row was provisioned for this account. The on_auth_user_created ' +
        'trigger is missing — install supabase/schema.sql before creating an administrator.'
    );
  }

  const { error: promoteError } = await admin
    .from('users')
    .update({ is_admin: true, full_name: fullName })
    .eq('id', userId);
  if (promoteError) throw promoteError;

  console.log('\n  Administrator ready.');
  console.log(`  ${fullName} <${email}>  ${phone}`);
  console.log('\n  Sign in at /login/admin with the email and password.');
  console.log('  The phone number also works at /login for ordering.\n');
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
