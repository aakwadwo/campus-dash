import { NextResponse } from 'next/server';
import { processPaymentWebhook } from '@/lib/payments/webhook';

export const dynamic = 'force-dynamic';

/**
 * Payment provider callback.
 *
 * The signature covers the exact bytes received, so the body is read raw and
 * parsed only inside the provider adapter after verification.
 *
 * This route is public by necessity — a provider cannot sign in. The signature
 * IS the authentication, which is why processPaymentWebhook verifies before it
 * does anything else.
 *
 * The `[provider]` segment is passed through and CHECKED. It names which
 * adapter the caller believes it is talking to, and a deployment configured for
 * a different one must refuse rather than hand the payload to whichever adapter
 * happens to be selected — see providerGuard() in lib/payments/webhook.js.
 */
export async function POST(request, { params }) {
  const { provider } = await params;
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const { status, body } = await processPaymentWebhook({ provider, rawBody, headers });
  return NextResponse.json(body, { status });
}
