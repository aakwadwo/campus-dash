import RecoveryClient from './recovery-client';

export const metadata = { title: 'Opening your reset link' };
export const dynamic = 'force-dynamic';

/**
 * Where the reset link in the email lands.
 *
 * This page does NOT spend the token, and that is deliberate. Cookies are
 * read-only in a Server Component, so verifying here would establish a session
 * that could never be written down — which is precisely how this flow used to
 * fail: the token was spent, the page redirected to the password form, the form
 * found no session, and everybody ended up back at "enter your email" with a
 * link that had already been burned. The work happens in a Server Action, which
 * can write cookies. See completeAdminRecovery in ../recovery-actions.js.
 *
 * THREE SHAPES ARRIVE HERE, because which one is sent depends on the project's
 * email template and flow setting — neither of which this application controls:
 *
 *   ?token_hash=…&type=recovery   supabase/templates/reset-password.html
 *   ?code=…                       the PKCE exchange
 *   #access_token=…&refresh_token=…
 *                                 Supabase's DEFAULT template. A fragment is
 *                                 stripped by the browser before the request is
 *                                 made, so no server has ever seen it and none
 *                                 can. The client finishes that one.
 *
 * Supporting all three is what makes the link work whether or not the template
 * has been applied to the project.
 */
export default async function AdminRecoverPage({ searchParams }) {
  const params = await searchParams;
  const str = (v) => (typeof v === 'string' && v ? v : null);

  return (
    <RecoveryClient
      tokenHash={str(params?.type) === 'recovery' ? str(params?.token_hash) : null}
      code={str(params?.code)}
      // Supabase reports an expired or already-spent link in the query string.
      // Passed through so the client does not waste a round trip on it.
      rejected={Boolean(str(params?.error) || str(params?.error_code))}
    />
  );
}
