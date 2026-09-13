import { NextResponse } from 'next/server';
import { getPendingCount, getActiveCount } from '@/lib/vendor';
import { startTiming } from '@/lib/observability/server-timing';

export const dynamic = 'force-dynamic';

/**
 * Count of orders still waiting for an answer. Polled by the board for the
 * in-app alert.
 *
 * No authorisation is performed here on purpose: vendor_pending_count() checks
 * is_vendor_staff() itself, so a vendor probing another vendor's id gets 0
 * rather than a number they should not have.
 */
export async function GET(_request, { params }) {
  const { vendorId } = await params;
  const timing = startTiming();
  try {
    // Both counts in one round trip: `pending` drives the badge and the chime,
    // `active` is the only one that moves when a handoff completes an order.
    const [pending, active] = await timing.measure('db', () =>
      Promise.all([getPendingCount(vendorId), getActiveCount(vendorId)])
    );
    return NextResponse.json(
      { pending: pending ?? 0, active: active ?? 0 },
      { headers: { 'Server-Timing': timing.header() } }
    );
  } catch {
    return NextResponse.json({ pending: 0 }, { status: 200 });
  }
}
