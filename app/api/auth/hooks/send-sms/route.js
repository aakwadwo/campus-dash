import { NextResponse } from 'next/server';
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
 * Bounds the provider call so the whole handler answers inside Supabase's five
 * seconds. Arkesel normally responds in well under a second; if it does not,
 * failing fast and letting Supabase retry beats holding the budget open until
 * it expires and the customer is told nothing at all.
 */
const PROVIDER_TIMEOUT_MS = 3500;

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

  let result;
  try {
    trace('provider.start');
    result = await provider.send(phone, message, {
      tag: 'AUTH_OTP',
      timeoutMs: PROVIDER_TIMEOUT_MS,
      trace,
    });
    trace('provider.done', {
      ok: result.ok,
      code: result.providerCode,
      elapsedMs: result.elapsedMs,
      balance: result.balance,
    });
  } catch (error) {
    // A provider that throws rather than returning. Treated as transient: we
    // genuinely do not know whether the message went out.
    console.error('[send-sms-hook] provider threw:', error.message);
    trace('provider.threw');
    return retryable('could not deliver verification code');
  }

  if (!result.ok) {
    // The provider's own message, which never contains the API key or the
    // request URL — see lib/sms/arkesel.js.
    console.error(`[send-sms-hook] delivery failed: ${result.error}`);
    trace('respond', { status: result.retryable ? 503 : 500, retryable: result.retryable });

    // Asking again only helps when the failure was transient. A rejected sender
    // ID or an unreachable number produces the same answer every time, and
    // retrying it just burns the five-second budget before Supabase gives up.
    return result.retryable
      ? retryable('could not deliver verification code')
      : NextResponse.json(
          { error: { http_code: 500, message: 'could not deliver verification code' } },
          { status: 500 }
        );
  }

  // No output is required; an empty 200 is a successful response.
  trace('respond', { status: 200 });
  return NextResponse.json({});
}

/**
 * A 503 with a non-empty retry-after is the only shape Supabase will retry.
 * Two seconds is its own backoff, and three retries still fit the budget.
 */
function retryable(message) {
  return NextResponse.json(
    { error: { http_code: 503, message } },
    { status: 503, headers: { 'retry-after': '2' } }
  );
}
