import { NextResponse } from 'next/server';
import { createClient as createPlainClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Where the reset link in the email lands.
 *
 * It is a ROUTE and not a page because its whole job is to spend the token and
 * then get out of the way: a page would run this again on every render,
 * including the one after the password form posts, and a recovery token is good
 * exactly once.
 *
 * TWO SHAPES, because the email template decides which one arrives and a hosted
 * project may still be on Supabase's default:
 *
 *   ?token_hash=…&type=recovery   what supabase/templates/reset-password.html
 *                                 sends.
 *   ?code=…                       what Supabase's default {{ .ConfirmationURL }}
 *                                 redirects to under the PKCE flow.
 *
 * WHY token_hash IS VERIFIED ON A PLAIN CLIENT AND NOT THE SSR ONE.
 * @supabase/ssr runs the PKCE flow, so its verifyOtp() looks for the code
 * verifier cookie that resetPasswordForEmail() left in the browser that ASKED
 * for the link. Mail apps routinely open links in a different browser — on a
 * phone, usually — and there the cookie does not exist, so the SSR client
 * rejects a perfectly good token and the person is told their link expired.
 * A plain client holds no verifier and simply asks the auth server, which
 * answers with the session; that session is then installed on the SSR client so
 * the cookies land exactly as they would have. Verified by Supabase Auth either
 * way — we never check a token ourselves.
 *
 * The ?code= branch keeps the SSR client, because an authorisation code is
 * meaningless without the verifier that belongs to it.
 */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  const tokenHash = params.get('token_hash');
  const type = params.get('type');
  const code = params.get('code');

  const supabase = await createClient();
  let failed = true;

  if (tokenHash && type === 'recovery') {
    const plain = createPlainClient(config.supabaseUrl(), config.supabasePublishableKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await plain.auth.verifyOtp({
      type: 'recovery',
      token_hash: tokenHash,
    });

    if (error) {
      console.error('[auth] recovery verifyOtp failed:', error.message);
    } else if (data?.session) {
      // Hand the verified session to the cookie-backed client, which is what
      // the reset page and the password action read.
      const { error: setError } = await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      if (setError) console.error('[auth] recovery setSession failed:', setError.message);
      failed = Boolean(setError);
    } else {
      console.error('[auth] recovery verifyOtp returned no session');
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) console.error('[auth] recovery code exchange failed:', error.message);
    failed = Boolean(error);
  } else {
    console.error('[auth] recovery link carried neither a token_hash nor a code');
  }

  // One destination for every failure — an expired link, a spent one and a
  // mistyped one are the same fact to the person reading it: ask for another.
  if (failed) {
    return NextResponse.redirect(new URL('/login/admin/forgot?link=expired', request.url));
  }

  return NextResponse.redirect(new URL('/login/admin/reset', request.url));
}
