import { notFound } from 'next/navigation';
import { isDevInboxEnabled, recent } from '@/lib/sms/dev-inbox';

/**
 * Development SMS inbox — every message the fake provider "sent", newest first.
 *
 * Manual end-to-end testing needs four signed-in roles at once, and each sign-in
 * needs an OTP. Reading them out of the server terminal while switching browser
 * profiles is where a walkthrough goes wrong, so they are readable here instead.
 *
 * THREE INDEPENDENT GATES, because this page displays one-time passcodes:
 *
 *   1. Not production. NODE_ENV is set by the build, not by a request.
 *   2. The provider must actually be the fake. With a real provider the
 *      messages are not merely hidden — nothing ever recorded them.
 *   3. Messages exist only in this process's memory, so a restart empties it
 *      and nothing is ever written to the database or a log.
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

  const messages = recent();

  return (
    <main className="mx-auto max-w-2xl p-4">
      <h1 className="text-xl font-semibold">Development SMS inbox</h1>
      <p className="text-muted mt-1 text-sm">
        The last {messages.length === 0 ? '25' : messages.length} messages the fake provider
        handled, newest first. Held in memory only — restarting the dev server clears this. Returns
        404 in a production build.
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
