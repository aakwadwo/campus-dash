import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { NOTIFICATION_EVENT } from '@/lib/notifications';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * DEVELOPMENT ONLY — places a test order so the vendor module can be exercised
 * before the customer ordering UI exists in Phase 6.
 *
 * Returns 404 in production. It is the one thing in the application that calls
 * submit_order_for(), which places an order as a nominated customer and is
 * therefore never granted to a client role.
 *
 * It goes through the real submit path, so prices are snapshotted, fees are
 * server-calculated, and the vendor's new-order SMS fires exactly as it will
 * for a real customer.
 */
export async function POST(request) {
  if (config.isProduction()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  // Sensible defaults so the route is usable with an empty body.
  const vendorId = body.vendorId ?? (await firstOpenVendor(supabase));
  const customerId = body.customerId ?? (await firstCustomer(supabase));
  const fulfilment = body.fulfilment ?? 'DELIVERY';
  const items = body.items ?? (await firstTwoItems(supabase, vendorId));
  const destination = body.destinationId ?? (await firstDeliverableLocation(supabase));

  if (!vendorId || !customerId || !items?.length) {
    return NextResponse.json(
      { error: 'could not resolve a vendor, customer or menu items — is the database seeded?' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.rpc('submit_order_for', {
    p_customer_id: customerId,
    p_vendor_id: vendorId,
    p_fulfilment_type: fulfilment,
    p_items: items,
    p_destination_location_id: fulfilment === 'DELIVERY' ? destination : null,
    p_destination_note: null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const order = Array.isArray(data) ? data[0] : data;

  // The same notification a real submission will fire in Phase 6.
  await notifyOrderEvent(NOTIFICATION_EVENT.ORDER_SUBMITTED, order.order_id);

  return NextResponse.json({ ...order, vendorId, customerId, fulfilment });
}

async function firstOpenVendor(supabase) {
  const { data } = await supabase
    .from('vendors')
    .select('id')
    .eq('status', 'ACTIVE')
    .eq('is_accepting_orders', true)
    .order('name')
    .limit(1);
  return data?.[0]?.id ?? null;
}

/** Prefers a plain customer over an admin or someone who staffs a stall. */
async function firstCustomer(supabase) {
  const { data: staff } = await supabase.from('vendor_users').select('user_id');
  const excluded = new Set((staff ?? []).map((row) => row.user_id));

  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('is_admin', false)
    .order('created_at');

  return (data ?? []).find((user) => !excluded.has(user.id))?.id ?? data?.[0]?.id ?? null;
}

async function firstTwoItems(supabase, vendorId) {
  if (!vendorId) return [];
  const { data } = await supabase
    .from('menu_items')
    .select('id')
    .eq('vendor_id', vendorId)
    .eq('is_available', true)
    .order('sort_order')
    .limit(2);
  return (data ?? []).map((item, index) => ({ menu_item_id: item.id, quantity: index + 1 }));
}

async function firstDeliverableLocation(supabase) {
  const { data } = await supabase
    .from('locations')
    .select('id')
    .eq('is_deliverable', true)
    .eq('is_active', true)
    .order('sort_order')
    .limit(1);
  return data?.[0]?.id ?? null;
}
