import { NextResponse } from 'next/server';
import { getPendingCount } from '@/lib/vendor';

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
  try {
    const pending = await getPendingCount(vendorId);
    return NextResponse.json({ pending: pending ?? 0 });
  } catch {
    return NextResponse.json({ pending: 0 }, { status: 200 });
  }
}
