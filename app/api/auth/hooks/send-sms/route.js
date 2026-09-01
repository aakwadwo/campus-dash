import { NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/auth/webhook-signature';
import { getSmsProvider, normaliseGhanaPhone } from '@/lib/sms';
import { config } from '@/lib/config';

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

  if (!phone || !otp) {
    console.error('[send-sms-hook] payload missing phone or otp');
    return NextResponse.json(
      { error: { http_code: 400, message: 'missing phone or otp' } },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await getSmsProvider().send(
      phone,
      `Campus Dash: your verification code is ${otp}. It expires shortly. Do not share it with anyone.`,
      { tag: 'AUTH_OTP', timeoutMs: PROVIDER_TIMEOUT_MS }
    );
  } catch (error) {
    // A provider that throws rather than returning. Treated as transient: we
    // genuinely do not know whether the message went out.
    console.error('[send-sms-hook] provider threw:', error.message);
    return retryable('could not deliver verification code');
  }

  if (!result.ok) {
    // The provider's own message, which never contains the API key or the
    // request URL — see lib/sms/arkesel.js.
    console.error(`[send-sms-hook] delivery failed: ${result.error}`);

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
