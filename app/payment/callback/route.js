import { NextResponse } from 'next/server';
import { verifyAndApplyPayment } from '@/lib/orders/payments';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Where the provider's hosted checkout sends the customer back to.
 *
 * THIS ARRIVAL IS NOT PROOF OF PAYMENT. It is an unauthenticated GET that
 * anyone can type, and a customer who abandons the checkout is redirected here
 * exactly like one who paid. So it decides nothing: it asks the provider,
 * server to server, what actually happened, and applies that verified answer.
 * The signed webhook does the same thing from the other direction, and whichever
 * arrives first wins — confirm_payment() is idempotent.
 *
 * There is no session check, on purpose. The reference is a UUID we issued, the
 * route reveals nothing about it, and requiring a cookie would strand anyone
 * whose browser dropped the session across the provider's domain. The page it
 * redirects to still refuses to render an order that is not yours.
 */
export async function GET(request) {
  const params = request.nextUrl.searchParams;
  // Paystack sends both; they carry the same value.
  const reference = params.get('reference') ?? params.get('trxref');

  if (!reference || !UUID.test(reference)) {
    return NextResponse.redirect(new URL('/orders', request.url));
  }

  let orderId = null;
  try {
    const result = await verifyAndApplyPayment(reference);
    orderId = result.orderId ?? null;
  } catch (error) {
    // The customer still needs to land somewhere useful. The order screen polls
    // and reconciles on its own, so a failure here delays the answer rather
    // than losing it.
    console.error('[payments] callback verification failed:', error.message);
  }

  return NextResponse.redirect(new URL(orderId ? `/orders/${orderId}` : '/orders', request.url));
}
