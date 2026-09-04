'use server';

const CONTEXT = 'scan order action';

import { redirect } from 'next/navigation';
import { actionFailure } from '@/lib/errors';
import { quoteScanOrder, submitScanOrder } from '@/lib/scan';

/**
 * Prices one scan errand.
 *
 * The client sends a restaurant and a destination and gets back what it will
 * cost. It never sends a price, and nothing it sends is used as one — the
 * figures come from price_scan_order(), which reads pricing_config and refuses
 * outright when the scan fee has not been configured.
 */
export async function quoteScanAction({ vendorId, destinationLocationId }) {
  try {
    const quote = await quoteScanOrder({ vendorId, destinationLocationId });
    return { ok: true, quote };
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }
}

/**
 * Creates the errand and sends the customer to it to pay.
 *
 * The scan path in the form was produced by our own upload route from the
 * signed-in session; submit_scan_order() re-checks that it belongs to this
 * account before attaching it, so a tampered field fails in the database rather
 * than here.
 */
export async function submitScanOrderAction(_prev, formData) {
  let orderId;

  try {
    const result = await submitScanOrder({
      vendorId: String(formData.get('vendor_id') ?? ''),
      destinationLocationId: String(formData.get('destination_location_id') ?? ''),
      scanImagePath: String(formData.get('scan_image_path') ?? ''),
      contentType: String(formData.get('content_type') ?? ''),
      byteSize: Number(formData.get('byte_size') ?? 0),
      destinationNote: String(formData.get('destination_note') ?? '').trim() || null,
    });
    orderId = result?.order_id;
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }

  // Payment happens on the order screen, the same one a food order uses. The
  // errand is not dispatched until it is paid for.
  redirect(`/orders/${orderId}`);
}
