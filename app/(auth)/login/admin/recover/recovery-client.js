'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { completeAdminRecovery } from '../recovery-actions';

/**
 * Turns a reset link of any shape into a session, then gets out of the way.
 *
 * Two routes through here, and the difference is only where the token is:
 *
 *   in the QUERY STRING — handed to a Server Action, because only an action can
 *   write the session cookie. A Server Component cannot, which is the bug this
 *   flow used to have.
 *
 *   in the FRAGMENT — read here, because `location.hash` is never sent to a
 *   server. The browser client's setSession writes the same cookies.
 *
 * Every outcome navigates, so there is no error state to render: a link that
 * does not work sends people to the forgot page, which explains itself.
 *
 * RUN ONCE, AND THE REF IS NOT OPTIONAL. A recovery token is single-use, and
 * React StrictMode runs every effect twice in development — so the first call
 * spent the token, the second was told "Email link is invalid or has expired",
 * and the second answer is the one that landed. It looked exactly like a broken
 * link and was in fact a working one being spent twice. The ref survives
 * StrictMode's simulated remount, so the exchange happens once per visit.
 */
export default function RecoveryClient({ tokenHash, code, rejected }) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const fail = () => router.replace('/login/admin/forgot?link=expired');
    const done = () => router.replace('/login/admin/reset');

    if (rejected) {
      fail();
      return;
    }

    // NO `cancelled` FLAG, AND NO CLEANUP. The usual guard against acting on a
    // resolved promise after unmount is exactly wrong here: StrictMode runs the
    // cleanup between its two passes, so the flag was already true by the time
    // the exchange came back and the navigation was silently dropped — the page
    // sat on "One moment" forever with a perfectly good session in hand. The
    // token is spent the instant the request leaves, so the answer must always
    // be acted on. Both outcomes navigate, and navigation is idempotent.
    if (tokenHash || code) {
      completeAdminRecovery({ tokenHash, code }).then((result) => (result?.ok ? done() : fail()));
      return;
    }

    // Nothing in the query string, so the tokens are in the fragment — or there
    // are none at all and somebody typed the path.
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');

    if (params.get('error') || params.get('error_code') || !accessToken || !refreshToken) {
      fail();
      return;
    }

    // Spent: take the tokens out of the address bar before handing them over, so
    // a session does not sit there to be shoulder-read or pasted into chat.
    window.history.replaceState(null, '', window.location.pathname);

    // Handed to the SAME server action the query-string shapes use. The browser
    // is the only thing that can READ a fragment; the server is the only thing
    // that can write the session cookie. This is the seam between those facts.
    completeAdminRecovery({ accessToken, refreshToken }).then((result) =>
      result?.ok ? done() : fail()
    );
  }, [router, tokenHash, code, rejected]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <p className="text-muted text-xs font-medium tracking-[0.2em] uppercase">Campus Dash</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Opening your reset link</h1>
      <p className="text-muted mt-2 text-sm leading-relaxed" role="status">
        One moment.
      </p>
    </main>
  );
}
