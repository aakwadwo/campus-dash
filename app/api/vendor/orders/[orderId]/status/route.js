import { NextResponse } from 'next/server';
import { getOrderDetail } from '@/lib/vendor';
import { startTiming } from '@/lib/observability/server-timing';

export const dynamic = 'force-dynamic';

/**
 * Where one order stands, for a vendor screen that is waiting on somebody else.
 *
 * The store's order screen shows a handoff code and then has nothing to do but
 * wait for the customer or Partner to type it in. This is what it polls to find
 * out that they have.
 *
 * AUTHORISATION IS THE DATABASE'S. vendor_order_detail() returns a row only to
 * the staff of this order's store (or an administrator), and only for a paid
 * order — anyone else gets 404, which does not confirm the order exists.
 *
 * FIVE STATE FIELDS, AND NOTHING ELSE. The row carries items and the vendor's
 * own amount; none of that is sent, because a screen polling every few seconds
 * needs to know whether to refresh, not to re-download the order. No total, no
 * fee, no Partner earning is in the row to begin with — see migration
 * 20260930000001 — and none is added here.
 */
export async function GET(_request, { params }) {
  const { orderId } = await params;
  const timing = startTiming();

  let order;
  try {
    order = await timing.measure('db', () => getOrderDetail(orderId));
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  if (!order) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  return NextResponse.json(
    {
      order_status: order.order_status,
      delivery_status: order.delivery_status,
      payment_status: order.payment_status,
      handoff_code_available: Boolean(order.handoff_code_available),
      // THE STORE'S OWN COMPLETION. Handing a bag to a Partner ends the store's
      // part while order_status stays READY for the customer's sake, so without
      // this the code sat on the counter screen until somebody navigated away.
      vendor_completed_at: order.vendor_completed_at ?? null,
    },
    { headers: { 'Cache-Control': 'no-store', 'Server-Timing': timing.header() } }
  );
}
