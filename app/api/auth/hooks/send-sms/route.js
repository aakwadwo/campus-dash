import { NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/auth/webhook-signature';
import { getSmsProvider, normaliseGhanaPhone } from '@/lib/sms';

export const dynamic = 'force-dynamic';

/**
 * Supabase Auth Send SMS Hook.
 *
 * Supabase generates and validates the OTP itself — we never see a code we are
 * responsible for checking. It hands us the message to DELIVER, which routes
 * phone OTP through our own SmsProvider abstraction: FakeSmsProvider prints it
 * to this server's console in development, and a Ghana provider drops in later
 * with no change to anything else.
 *
 * Every request is HMAC-verified. Without that this route is an open
 * SMS-sending endpoint.
 */
export async function POST(request) {
  // The signature covers the EXACT bytes received, so the body must be read raw
  // and parsed only after verification.
  const rawBody = await request.text();

  const { valid, reason } = verifyWebhookSignature({
    body: rawBody,
    headers: request.headers,
    secret: process.env.SEND_SMS_HOOK_SECRET,
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

  try {
    const result = await getSmsProvider().send(
      phone,
      `Campus Dash: your verification code is ${otp}. It expires shortly. Do not share it with anyone.`,
      { tag: 'AUTH_OTP' }
    );
    if (!result.ok) throw new Error(result.error ?? 'sms provider reported failure');
  } catch (error) {
    console.error('[send-sms-hook] delivery failed:', error.message);
    // A non-2xx tells Supabase the OTP did not go out, so it fails the sign-in
    // rather than leaving the user waiting for a message that never arrives.
    return NextResponse.json(
      { error: { http_code: 500, message: 'could not deliver verification code' } },
      { status: 500 }
    );
  }

  return NextResponse.json({});
}
