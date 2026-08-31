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
 */
export async function POST(request) {
  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers.entries());

  const { status, body } = await processPaymentWebhook({ rawBody, headers });
  return NextResponse.json(body, { status });
}
