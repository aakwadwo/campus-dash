import './local-supabase.js';

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createChunks, stringToBase64URL } from '@supabase/ssr';
import { LOCAL_SUPABASE } from './local-supabase.js';
import { asService } from './db.js';

/**
 * REAL Supabase sessions, minted against the local stack.
 *
 * The admin guard reads the `amr` claim from a verified JWT, so a hand-built
 * token would test nothing. These come from GoTrue itself: a password sign-in
 * carries `amr: password`, and a magic-link verification carries `amr: otp`,
 * which is exactly what an emailed customer code produces.
 */

const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const NO_STORAGE = { auth: { persistSession: false, autoRefreshToken: false } };

export const SEEDED_ADMIN = { email: 'admin@acity.edu.gh', password: 'campusdash' };

function plain() {
  return createClient(LOCAL_SUPABASE.url, PUBLISHABLE, NO_STORAGE);
}

function service() {
  return createClient(LOCAL_SUPABASE.url, process.env.SUPABASE_SERVICE_ROLE_KEY, NO_STORAGE);
}

/** The cookie @supabase/ssr reads for this project: sb-<first host label>-auth-token. */
export const AUTH_COOKIE = `sb-${new URL(LOCAL_SUPABASE.url).hostname.split('.')[0]}-auth-token`;

export async function passwordSession({ email, password } = SEEDED_ADMIN) {
  const { data, error } = await plain().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

/** A session proved by an emailed code, the way a customer signs in. */
export async function otpSession(email) {
  const link = await service().auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error) throw link.error;
  const { data, error } = await plain().auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.data.properties.hashed_token,
  });
  if (error) throw error;
  return data.session;
}

/** The request cookies a browser holding this session would send. */
export function sessionCookies(session) {
  const encoded = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  return Object.fromEntries(createChunks(AUTH_COOKIE, encoded).map((c) => [c.name, c.value]));
}

/**
 * A throwaway Customer: an email identity with a customer_profiles row and no
 * other capability. Returns its id and a way to remove it again.
 */
export async function temporaryCustomer() {
  const email = `session-test-${randomUUID().slice(0, 8)}@acity.edu.gh`;
  const { data, error } = await service().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;

  await asService((c) =>
    c.query(
      `insert into public.customer_profiles (user_id, level) values ($1, '100')
       on conflict (user_id) do nothing`,
      [id]
    )
  );

  return {
    id,
    email,
    remove: async () => {
      // public.users and customer_profiles cascade from auth.users.
      await service().auth.admin.deleteUser(id);
    },
  };
}

/**
 * A throwaway NON-STUDENT VENDOR: an email identity that owns an ACTIVE store and
 * holds no Customer capability. The seeded vendors sign in by phone, which a
 * test cannot mint a session for, so this stands in for them.
 */
export async function temporaryVendor() {
  const email = `session-vendor-${randomUUID().slice(0, 8)}@acity.edu.gh`;
  const { data, error } = await service().auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const phone = `+23329${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

  const vendorId = await asService(async (c) => {
    const { rows } = await c.query(
      `insert into public.vendors (name, phone, status, is_accepting_orders, owner_user_id)
       values ('Session test store', $1, 'ACTIVE', false, $2) returning id`,
      [phone, id]
    );
    return rows[0].id;
  });

  return {
    id,
    email,
    vendorId,
    remove: async () => {
      // The owner foreign key RESTRICTs, so the store goes first.
      await asService((c) => c.query('delete from public.vendors where id = $1', [vendorId]));
      await service().auth.admin.deleteUser(id);
    },
  };
}

/**
 * A browser session for a SEEDED, PHONE-ONLY vendor identity.
 *
 * WHY THIS IS AWKWARD, and why the awkwardness is named here rather than
 * repeated in a suite: a vendor signs in with an SMS code, and a test cannot
 * receive one. GoTrue will only mint a session from something it can issue a
 * link for, so the identity is lent a confirmed school address for the duration
 * of the suite and has it taken away again afterwards.
 *
 * It is a LOAN, and restore() is not optional. A seeded actor left carrying an
 * address is exactly the kind of leak that makes one file's tests depend on
 * another having run first — which is how this helper came to exist: the vendor
 * status suite used to read an email off `vendor1Staff` that only
 * account-model.test.js had put there, so it passed in the full run and failed
 * on its own.
 *
 * Attaching an address grants NO capability. Customer is a customer_profiles
 * row and nothing else, so this identity still cannot order.
 */
export async function seededVendorSession(userId) {
  const email = `session-seeded-vendor-${randomUUID().slice(0, 8)}@acity.edu.gh`;

  const previous = await asService(async (c) => {
    // Read first, then write. A subquery in RETURNING would see the statement's
    // own snapshot, and reasoning about which value that is at every call site
    // is not worth saving a round trip in a test helper.
    const { rows } = await c.query('select email from auth.users where id = $1', [userId]);
    if (rows.length === 0) throw new Error(`no auth.users row for ${userId}`);
    await c.query('update auth.users set email = $2, email_confirmed_at = now() where id = $1', [
      userId,
      email,
    ]);
    return rows[0].email;
  });

  const cookies = sessionCookies(await otpSession(email));

  return {
    email,
    cookies,
    restore: () =>
      asService((c) =>
        c.query(
          // Cast, because a bare $2 inside the CASE has no column to take its
          // type from and Postgres refuses to guess.
          `update auth.users
              set email = $2::text,
                  email_confirmed_at =
                    case when $2::text is null then null else email_confirmed_at end
            where id = $1`,
          [userId, previous]
        )
      ),
  };
}

/** Decodes a JWT payload without verifying it. For assertions only. */
export function claimsOf(accessToken) {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
}
