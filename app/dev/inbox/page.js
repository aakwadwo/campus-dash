import { notFound } from 'next/navigation';
import { isDevInboxEnabled, recent } from '@/lib/sms/dev-inbox';
import { recentFromDatabase } from '@/lib/sms/dev-inbox-db';

/**
 * Development SMS inbox — every message the fake provider "sent", newest first.
 *
 * Manual end-to-end testing needs four signed-in roles at once, and each sign-in
 * needs an OTP. Reading them out of the server terminal while switching browser
 * profiles is where a walkthrough goes wrong, so they are readable here instead.
 *
 * Two sources, merged newest-first, because an OTP arrives by a different route
 * depending on which Supabase the app is pointed at:
 *
 *   - In-memory buffer — everything FakeSmsProvider sent from this process:
 *     every order notification, plus phone OTPs when the Send SMS Hook is our
 *     HTTPS route (the local stack, and production).
 *   - public.dev_sms_outbox — phone OTPs from a HOSTED development project,
 *     where Supabase Auth cannot reach localhost and the hook is a Postgres
 *     function instead. Optional; absent unless supabase/dev/sms-hook.sql was
 *     installed. Read with the service-role key, because the table has RLS on
 *     and no policies.
 *
 * THREE INDEPENDENT GATES, because this page displays one-time passcodes:
 *
 *   1. Not production. NODE_ENV is set by the build, not by a request.
 *   2. The provider must actually be the fake. With a real provider the
 *      messages are not merely hidden — nothing ever recorded them.
 *   3. Nothing is retained: the buffer is process memory, and the table prunes
 *      itself to the last 25 messages and fifteen minutes on every write.
 *
 * A production build renders 404 here. There is no flag, header or cookie that
 * turns it on, because the only safe audience for this page is a developer who
 * already controls the machine it runs on.
 */

export const dynamic = 'force-dynamic';

/** Pulls the passcode out so a tester can read it at a glance. */
function findCode(message) {
  return message.match(/\b(\d{4,8})\b/)?.[1] ?? null;
}

export default async function DevInboxPage() {
  if (!isDevInboxEnabled()) notFound();

  const messages = [...recent(), ...(await recentFromDatabase())]
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
    .slice(0, 25);

  return (
    <main className="mx-auto max-w-2xl p-4">
      <h1 className="text-xl font-semibold">Development SMS inbox</h1>
      <p className="text-muted mt-1 text-sm">
        The last {messages.length === 0 ? '25' : messages.length} messages the fake provider
        handled, newest first. Nothing is retained: the buffer is cleared by restarting the dev
        server, and hosted OTPs are pruned after fifteen minutes. Returns 404 in a production build.
      </p>

      {messages.length === 0 ? (
        <p className="mt-6 rounded border border-dashed p-6 text-center text-sm">
          Nothing sent yet. Request a sign-in code and reload.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {messages.map((m) => {
            const code = findCode(m.message);
            return (
              <li key={m.id} className="rounded border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-sm font-semibold">{m.phoneNumber}</span>
                  <span className="text-muted text-xs">
                    {m.tag ? `${m.tag} · ` : ''}
                    {new Date(m.sentAt).toLocaleTimeString()}
                  </span>
                </div>
                {code && (
                  <p className="mt-2 font-mono text-3xl tracking-widest tabular-nums">{code}</p>
                )}
                <p className="text-muted mt-2 text-sm whitespace-pre-wrap">{m.message}</p>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
