'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { submitOrder } from '@/lib/orders/transitions';
import { quoteOrder } from '@/lib/customer';
import { startPayment, refreshPaymentState } from '@/lib/orders/payments';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { NOTIFICATION_EVENT } from '@/lib/notifications';

/**
 * Customer actions.
 *
 * The client sends menu item ids, quantities, a fulfilment choice and a
 * destination. It sends no prices, no totals and no fees — and if it did they
 * would be ignored, because price_order() reads only ids and quantities.
 */
function fail(error) {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

/**
 * The basket total, priced by the server.
 *
 * The screen never adds prices up itself. Whatever it displays came from
 * price_order(), which is the same function that will charge the customer — so
 * the number on the review screen cannot disagree with the order.
 */
export async function quoteAction({ vendorId, fulfilmentType, items, destinationLocationId }) {
  try {
    const quote = await quoteOrder({
      vendorId,
      fulfilmentType,
      items,
      destinationLocationId,
    });
    return { ok: true, quote };
  } catch (error) {
    return fail(error);
  }
}

export async function submitOrderAction(_prev, formData) {
  const vendorId = String(formData.get('vendor_id') ?? '');
  const fulfilmentType = formData.get('fulfilment_type') === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
  const destinationLocationId = String(formData.get('destination_location_id') ?? '') || null;
  const destinationNote = String(formData.get('destination_note') ?? '').trim() || null;

  let items;
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]'));
  } catch {
    return { ok: false, message: 'Your basket could not be read. Try again.' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Your basket is empty.' };
  }

  let order;
  try {
    order = await submitOrder({
      vendorId,
      fulfilmentType,
      // Only these two fields survive. Anything else the basket carried is
      // never read.
      items: items.map((item) => ({
        menuItemId: String(item.menuItemId),
        quantity: Number(item.quantity),
      })),
      destinationLocationId: fulfilmentType === 'DELIVERY' ? destinationLocationId : null,
      destinationNote,
    });
  } catch (error) {
    return fail(error);
  }

  await notifyOrderEvent(NOTIFICATION_EVENT.ORDER_SUBMITTED, order.order_id);
  redirect(`/orders/${order.order_id}`);
}

export async function payOrderAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  try {
    const result = await startPayment(orderId);
    if (!result.ok) return { ok: false, message: result.reason };
  } catch (error) {
    return fail(error);
  }
  revalidatePath(`/orders/${orderId}`);
  return { ok: true, message: 'Payment started.' };
}

/** Polled by the payment screen while a charge is in flight. */
export async function refreshOrderAction(orderId) {
  try {
    await refreshPaymentState(orderId);
  } catch {
    // A transient failure just means the next poll tries again.
  }
  revalidatePath(`/orders/${orderId}`);
}

// --- When nobody takes the delivery ------------------------------------------

/**
 * The food exists and is paid for, so the customer decides — the order is never
 * cancelled out from under them, and the vendor does nothing either way.
 */
export async function keepWaitingAction(_prev, formData) {
  return customerChoice(formData, 'customer_keep_waiting', 'Looking again for a Partner.');
}

export async function collectInsteadAction(_prev, formData) {
  return customerChoice(
    formData,
    'customer_collect_instead',
    'Go to the vendor and collect your order.'
  );
}

export async function disputeAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('customer_dispute_delivery', {
      p_order_id: orderId,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    const envelope = Array.isArray(data) ? data[0] : data;
    revalidatePath(`/orders/${orderId}`);
    return envelope?.success
      ? { ok: true, message: 'Reported. Campus Dash support will look into it.' }
      : { ok: false, message: envelope?.reason ?? 'Could not report that.' };
  } catch (error) {
    return fail(error);
  }
}

async function customerChoice(formData, fn, successMessage) {
  const orderId = String(formData.get('order_id') ?? '');
  try {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(fn, { p_order_id: orderId });
    if (error) throw new Error(error.message);

    const envelope = Array.isArray(data) ? data[0] : data;
    revalidatePath(`/orders/${orderId}`);
    return envelope?.success
      ? { ok: true, message: successMessage }
      : { ok: false, message: envelope?.reason ?? 'That is no longer possible.' };
  } catch (error) {
    return fail(error);
  }
}
