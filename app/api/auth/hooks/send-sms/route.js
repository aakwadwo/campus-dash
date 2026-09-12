import { NextResponse, after } from 'next/server';
import { verifyWebhookSignature } from '@/lib/auth/webhook-signature';
import { getSmsProvider, normaliseGhanaPhone } from '@/lib/sms';
import { config } from '@/lib/config';
// TEMPORARY — see lib/observability/otp-trace.js. Remove with the diagnosis.
import { otpTrace } from '@/lib/observability/otp-trace';

export const dynamic = 'force-dynamic';

/**
 * Supabase Auth Send SMS Hook.
 *
 * Supabase generates and validates the OTP itself — we never see a code we are
 * responsible for checking. It hands us the message to DELIVER, which routes
 * phone OTP through the same SmsProvider seam as every order notification:
 * FakeSmsProvider in development, ArkeselSmsProvider in production.
 *
 *   signInWithOtp(phone) → Supabase Auth → THIS ROUTE → SmsProvider → Arkesel
 *
 * Every request is HMAC-verified. Without that this route is an open
 * SMS-sending endpoint that anyone who learned the URL could drive, at our cost
 * and to numbers of their choosing.
 *
 * SUPABASE'S CONTRACT, which shapes everything below:
 *
 *   - Five seconds TOTAL for the invocation, including Supabase's own retries.
 *     That is the whole budget, so the provider call is bounded well inside it.
 *   - Responses must be application/json. 200, 202 and 204 are success.
 *   - 429 and 503 are retried, up to three times with a two-second backoff, and
 *     only when a non-empty retry-after header is present. Everything else is
 *     final — 400 and 403 surface to the user as a 500.
 *
 *   https://supabase.com/docs/guides/auth/auth-hooks
 */

/**
 * How long the background Arkesel call may take.
 *
 * NOT a slice of Supabase's five seconds any more. The response has already
 * gone by the time this is used, so the only thing this bounds is how long a
 * stuck request may hold the invocation open. Arkesel answers in one to four
 * seconds in practice; fifteen is the adapter's own default and is generous
 * enough that a slow-but-successful send completes rather than being cut off,
 * which is the failure this whole change exists to stop.
 */
const BACKGROUND_TIMEOUT_MS = 15_000;

/**
 * Hands work off to run after the response has been sent.
 *
 * after() is the whole point of this route's design, but it THROWS when there
 * is no request scope around it — a direct invocation, or a runtime that does
 * not provide one. An exception there would turn a working send into a 500 and
 * no SMS at all, which is a far worse failure than the one being fixed, so the
 * fallback runs the same work inline and returns its promise.
 *
 * The fallback is not a second code path in production: on Vercel, inside a
 * real request, after() always applies. It matters because whatever calls this
 * route directly is not Supabase and has no five-second budget to protect.
 */
function schedule(work) {
  try {
    after(work);
    return null;
  } catch {
    return work();
  }
}

export async function POST(request) {
  const receivedAt = Date.now();

  // The signature covers the EXACT bytes received, so the body must be read raw
  // and parsed only after verification.
  const rawBody = await request.text();

  const { valid, reason } = verifyWebhookSignature({
    body: rawBody,
    headers: request.headers,
    secret: config.sendSmsHookSecret(),
  });

  if (!valid) {
    console.error(`[send-sms-hook] REJECTED: ${reason}`);
    // Deliberately vague to the caller; the detail stays in our logs.
    return NextResponse.json(
      { error: { http_code: 401, message: 'invalid signature' } },
      { status: 401 }
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: { http_code: 400, message: 'malformed payload' } },
      { status: 400 }
    );
  }

  const phone = normaliseGhanaPhone(payload?.user?.phone);
  const otp = payload?.sms?.otp;

  // Supabase's own send time, from the signed header. The gap to `receivedAt`
  // is Supabase → Vercel network time PLUS any cold start, which cannot be
  // measured from inside the handler any other way.
  //
  // READ IT AS AN UPPER BOUND, NOT A MEASUREMENT. The header is whole seconds,
  // so this carries up to 1000ms of positive bias; the true latency is
  // somewhere in [value - 1000, value]. Across several attempts the MINIMUM is
  // the honest estimate.
  const supabaseSentAt = Number(request.headers.get('webhook-timestamp'));

  // Supabase stamps a FRESH webhook id on every delivery, retries included —
  // measured, not assumed: one failing signInWithOtp produced three invocations
  // with three different ids, 6ms apart. So `wid` does not group a retry with
  // its original. What it does give is an exact count of how many times we were
  // asked to send, which is the only way to tell one OTP redelivered from two
  // OTPs requested — the question behind "did they type an older code?".
  // Retries arrive within milliseconds and share a phone tag; a genuine second
  // request is seconds or minutes later.
  const trace = otpTrace('hook', phone, { startedAt: receivedAt });
  trace('received', {
    wid: request.headers.get('webhook-id'),
    bodyLen: rawBody.length,
    sinceSupabaseMs: Number.isFinite(supabaseSentAt)
      ? receivedAt - supabaseSentAt * 1000
      : undefined,
  });

  if (!phone || !otp) {
    console.error('[send-sms-hook] payload missing phone or otp');
    return NextResponse.json(
      { error: { http_code: 400, message: 'missing phone or otp' } },
      { status: 400 }
    );
  }

  const message = `Campus Dash: your verification code is ${otp}. It expires shortly. Do not share it with anyone.`;

  // Lengths, never contents. `otpLen` is what proves the template neither
  // truncated nor reformatted the code Supabase generated.
  const provider = getSmsProvider();
  trace('validated', {
    provider: provider.name,
    otpLen: String(otp).length,
    otpDigits: /^\d+$/.test(String(otp)),
    msgLen: message.length,
  });

  // THE HANDOFF. Everything that can be judged has been judged: the signature
  // is verified, the payload is well formed, the number is sendable and the
  // message is built. What remains is one HTTP call whose ANSWER Supabase does
  // not need and cannot wait for.
  //
  // Arkesel accepts and delivers the message but acknowledges it after
  // Supabase's five seconds — measured at 3856ms against a 3856ms budget in
  // production, with the SMS arriving anyway. Waiting for that acknowledgement
  // was failing a send that had already happened, and the 503 it returned made
  // Supabase RETRY, which is how one sign-in produced several codes that each
  // invalidated the last.
  //
  // after() runs the call once the response has been sent, in the same
  // invocation, which Vercel keeps alive for exactly this. Supabase gets its
  // 2xx inside the budget; Arkesel gets as long as it needs.
  const inline = schedule(async () => {
    try {
      trace('provider.start', { background: true, timeoutMs: BACKGROUND_TIMEOUT_MS });
      const result = await provider.send(phone, message, {
        tag: 'AUTH_OTP',
        // No longer racing Supabase, so the provider gets a realistic bound
        // rather than whatever was left of a budget it could never meet.
        timeoutMs: BACKGROUND_TIMEOUT_MS,
        trace,
      });

      if (result.ok) {
        trace('provider.done', { ok: true, elapsedMs: result.elapsedMs, balance: result.balance });
        return;
      }

      // THE ONE THING THIS COSTS US, stated plainly rather than buried: the
      // response has already gone, so a rejection here cannot be told to
      // Supabase or to the person waiting. It has to be findable in the log,
      // because the log is now the only place it exists. The provider's own
      // message never contains the API key or the request URL — see
      // lib/sms/arkesel.js.
      console.error(
        `[send-sms-hook] BACKGROUND delivery failed after responding 200: ${result.error}` +
          (result.providerCode ? ` (provider code ${result.providerCode})` : '') +
          ` — the customer is waiting for a code that will not arrive; they can use Resend`
      );
      trace('provider.failed', { background: true, code: result.providerCode });
    } catch (error) {
      console.error(
        `[send-sms-hook] BACKGROUND delivery threw after responding 200: ${error.message}`
      );
      trace('provider.threw', { background: true });
    }
  });

  // Only ever set by the no-request-scope fallback above; in production this is
  // null and the response goes out while Arkesel is still being called.
  if (inline) await inline;

  // Supabase's contract is a 2xx with a JSON body, and nothing about the
  // provider. No output is required; an empty 200 is a successful response.
  trace('respond', { status: 200, handedOff: true });
  return NextResponse.json({});
}
