import { NextResponse } from 'next/server';
import { getMyOrderSignal } from '@/lib/customer';
import { startTiming } from '@/lib/observability/server-timing';

export const dynamic = 'force-dynamic';

/**
 * Has anything moved on this order? For the customer's order screen, which
 * polls this while it waits on a store, a Partner or a payment.
 *
 * ONE SMALL QUESTION. The screen used to re-render in full on every tick to
 * find out; this answers with an opaque signature, and the screen re-renders
 * only when it changes. See customer_order_signal().
 *
 * AUTHORISATION IS THE DATABASE'S: the signature exists only for the caller's
 * own order, and anything else is 404 without saying whether it exists.
 */
export async function GET(_request, { params }) {
  const { orderId } = await params;
  const timing = startTiming();

  let signal;
  try {
    signal = await timing.measure('db', () => getMyOrderSignal(orderId));
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  if (!signal) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json(
    { signal },
    { headers: { 'Cache-Control': 'no-store', 'Server-Timing': timing.header() } }
  );
}
