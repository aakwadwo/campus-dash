import { after } from 'next/server';

/**
 * Runs notification work AFTER the response, when there is a response to wait
 * for.
 *
 * WHY. An SMS is a request to Arkesel, and Arkesel takes seconds to accept one:
 * Mark Ready waited 2.0–2.4s in production for a message the vendor never sees,
 * and a Paystack webhook took 5–11s to answer although the payment committed in
 * a tenth of a second. The state transition is what the person is waiting for;
 * the message is a consequence of it.
 *
 * WHAT STAYS SYNCHRONOUS. Everything that decides whether the action succeeded:
 * authorisation, validation, the conditional UPDATE, idempotency. Callers only
 * pass work here once the transition has already committed and returned
 * success, so a deferred message can never announce something that did not
 * happen. Deduplication lives inside notify() and travels with the task: it is
 * part of sending, not part of the transition.
 *
 * HOW. `after()` hands the task to the platform's waitUntil, so on Vercel the
 * invocation stays alive until it settles. Outside a request — the test runner,
 * the in-process fake payment poller, a script — there is nothing to defer
 * past, `after()` throws, and the task runs inline and is awaited exactly as it
 * was before. So the returned promise means "scheduled" inside a request and
 * "done" outside one.
 *
 * Every task swallows its own failure, as the notification layer always has: a
 * message that did not go out must never surface as a failed action.
 */
export function deferNotification(label, task) {
  let deferred = false;

  const run = async () => {
    const started = performance.now();
    try {
      await task();
    } catch (error) {
      console.error(`[notify] ${label} failed:`, error?.message ?? error);
    } finally {
      // One line per deferred task, so production logs can tell notification
      // time apart from the request that scheduled it.
      if (deferred) {
        console.log(`[timing] notify ${label} ${Math.round(performance.now() - started)}ms`);
      }
    }
  };

  try {
    after(run);
    deferred = true;
    return Promise.resolve();
  } catch {
    return run();
  }
}
