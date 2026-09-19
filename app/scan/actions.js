'use server';

const CONTEXT = 'scan order action';

import { revalidatePath } from 'next/cache';
import { actionFailure } from '@/lib/errors';
import { quoteScanOrder, submitScanOrder } from '@/lib/scan';
import { startPayment } from '@/lib/orders/payments';

/**
 * Prices one meal-scan order.
 *
 * The client sends a store, item ids, quantities, a fulfilment choice and
 * whether it wants a pack, and gets back what it will cost. It never sends a
 * price, and nothing it sends is used as one — the figures come from
 * price_scan_order(), which reads pricing_config, re-checks that every item is
 * scan-eligible, and refuses outright when the scan fee has not been
 * configured.
 *
 * The pack request is a request. A Partner order is charged for one whatever
 * arrives here, and the quote says so in pack_is_compulsory.
 */
export async function quoteScanAction({
  vendorId,
  items,
  fulfilmentType = 'PICKUP',
  destinationLocationId = null,
  wantsPack = false,
}) {
  try {
    const quote = await quoteScanOrder({
      vendorId,
      items,
      fulfilmentType,
      destinationLocationId,
      wantsPack: Boolean(wantsPack),
    });
    return { ok: true, quote };
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }
}

/**
 * Creates the order and opens the checkout.
 *
 * ONE TAP, TWO SERVER STEPS, exactly as a food order does it — the order has to
 * exist before a charge can be created against it, but nobody should have to
 * press Pay on a second screen to find that out. The URL is RETURNED rather
 * than followed, because the provider's page is on another origin and only a
 * full browser navigation gets somebody there.
 *
 * The scan path in the form was produced by our own upload route from the
 * signed-in session; submit_scan_order() re-checks that it belongs to this
 * account before attaching it, so a tampered field fails in the database rather
 * than here.
 */
export async function submitScanOrderAction(_prev, formData) {
  const vendorId = String(formData.get('vendor_id') ?? '');
  // CHOSEN, NEVER ASSUMED: the checkout starts with neither option selected.
  const chosen = String(formData.get('fulfilment_type') ?? '');
  if (chosen !== 'PICKUP' && chosen !== 'DELIVERY') {
    return { ok: false, message: 'Choose how you want it: collect it, or a Campus Dash Partner.' };
  }
  const fulfilmentType = chosen;
  const destinationLocationId = String(formData.get('destination_location_id') ?? '') || null;
  const destinationNote = String(formData.get('destination_note') ?? '').trim() || null;
  const details = String(formData.get('details') ?? '').trim() || null;
  // A REQUEST, and the database may overrule it. The checkbox does not exist
  // on a Partner order, so this arrives false there and the pack is charged
  // anyway — which is the point of deciding it in SQL rather than here.
  const wantsPack = formData.get('wants_pack') === 'on';
  const scanImagePath = String(formData.get('scan_image_path') ?? '');

  let items;
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]'));
  } catch {
    return { ok: false, message: 'Your order could not be read. Try again.' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Choose at least one item.' };
  }
  if (!scanImagePath) {
    return { ok: false, message: 'Attach your meal scan.' };
  }
  if (fulfilmentType === 'DELIVERY' && !destinationLocationId) {
    return { ok: false, message: 'Choose where the Partner should bring it.' };
  }

  let order;
  try {
    order = await submitScanOrder({
      vendorId,
      // Only these two fields survive. Anything else the basket carried is
      // never read.
      items: items.map((item) => ({
        menuItemId: String(item.menuItemId),
        quantity: Number(item.quantity),
      })),
      fulfilmentType,
      destinationLocationId: fulfilmentType === 'DELIVERY' ? destinationLocationId : null,
      scanImagePath,
      contentType: String(formData.get('content_type') ?? ''),
      byteSize: Number(formData.get('byte_size') ?? 0),
      details,
      destinationNote,
      wantsPack,
    });
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }

  const orderId = order?.order_id;
  revalidatePath('/orders');

  let payment;
  try {
    payment = await startPayment(orderId);
  } catch (error) {
    // The order is real and payable. Send them to it rather than losing it.
    console.error('[scan] checkout could not be opened:', error.message);
    return { ok: true, orderId, orderHref: `/orders/${orderId}` };
  }

  return {
    ok: true,
    orderId,
    orderHref: `/orders/${orderId}`,
    redirectUrl: payment?.ok ? (payment.redirectUrl ?? null) : null,
  };
}
