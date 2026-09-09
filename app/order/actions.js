'use server';

const CONTEXT = 'customer action';

import { actionFailure } from '@/lib/errors';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  submitOrder,
  customerChooseFulfilment,
  customerRatePartner,
} from '@/lib/orders/transitions';
import { quoteOrder } from '@/lib/customer';
import { startPayment, refreshPaymentState } from '@/lib/orders/payments';
import { setMyEmail } from '@/lib/customer';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { NOTIFICATION_EVENT } from '@/lib/notifications';

/**
 * Customer actions.
 *
 * The client sends menu item ids and quantities, and later a fulfilment choice
 * and a destination. It sends no prices, no totals and no fees — and if it did
 * they would be ignored, because price_order() reads only ids and quantities
 * and customer_choose_fulfilment() recomputes from the order's own snapshot.
 */
/**
 * Never lets a raw error reach a screen. toUserError() logs the detail
 * server-side and returns a sentence a person can act on, classified so a lost
 * race does not read like a catastrophe.
 */
function fail(error) {
  return actionFailure(error, CONTEXT);
}

/**
 * The basket total, priced by the server.
 *
 * The screen never adds prices up itself. Whatever it displays came from
 * price_order(), which is the same function that will charge the customer — so
 * the number on the review screen cannot disagree with the order.
 */
export async function quoteAction({ vendorId, items }) {
  try {
    const quote = await quoteOrder({ vendorId, items });
    return { ok: true, quote };
  } catch (error) {
    return fail(error);
  }
}

export async function submitOrderAction(_prev, formData) {
  const vendorId = String(formData.get('vendor_id') ?? '');

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
      // Only these two fields survive. Anything else the basket carried is
      // never read.
      items: items.map((item) => ({
        menuItemId: String(item.menuItemId),
        quantity: Number(item.quantity),
      })),
    });
  } catch (error) {
    return fail(error);
  }

  await notifyOrderEvent(NOTIFICATION_EVENT.ORDER_SUBMITTED, order.order_id);
  redirect(`/orders/${order.order_id}`);
}

/**
 * Pickup or delivery, chosen after the vendor has accepted.
 *
 * No amount crosses this boundary. The delivery fee and the new total are
 * recomputed in the database from the order's own price snapshot, so the screen
 * that asked the question cannot influence the answer's price.
 */
export async function chooseFulfilmentAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  const fulfilmentType = formData.get('fulfilment_type') === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
  const destinationLocationId = String(formData.get('destination_location_id') ?? '') || null;
  const destinationNote = String(formData.get('destination_note') ?? '').trim() || null;

  if (fulfilmentType === 'DELIVERY' && !destinationLocationId) {
    return { ok: false, message: 'Choose where the Partner should bring it.' };
  }

  let result;
  try {
    result = await customerChooseFulfilment({
      orderId,
      fulfilmentType,
      destinationLocationId: fulfilmentType === 'DELIVERY' ? destinationLocationId : null,
      destinationNote,
    });
  } catch (error) {
    return fail(error);
  }

  revalidatePath(`/orders/${orderId}`);
  return result.success
    ? {
        ok: true,
        message:
          fulfilmentType === 'PICKUP'
            ? 'You will collect this order. Pay to send it to the kitchen.'
            : 'A Partner will bring it. Pay to send the order to the kitchen.',
      }
    : { ok: false, message: result.reason ?? 'That is no longer possible.' };
}

/**
 * Starts a payment and hands back where to send the customer.
 *
 * The redirect URL is RETURNED rather than followed here: the provider's
 * checkout is on another origin, and a full browser navigation from the client
 * is what actually gets someone there. Dropping it would leave a payment
 * created and never presented.
 */
export async function payOrderAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  try {
    const result = await startPayment(orderId);
    if (!result.ok) {
      return { ok: false, needsEmail: Boolean(result.needsEmail), message: result.reason };
    }
    revalidatePath(`/orders/${orderId}`);
    return {
      ok: true,
      redirectUrl: result.redirectUrl ?? null,
      message: result.redirectUrl ? 'Taking you to the payment page…' : 'Payment started.',
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Stores a REAL email address against the account.
 *
 * Paystack will not open a checkout without one. It is asked for, never
 * invented: a synthesised address would send the customer's receipt nowhere and
 * put a fiction in our own records. Nothing else about the account changes —
 * this is not a verification step, and it is not the Partner application.
 */
export async function saveEmailAction(_prev, formData) {
  const email = String(formData.get('email') ?? '').trim();
  const orderId = String(formData.get('order_id') ?? '');

  if (!email) return { ok: false, message: 'Enter your email address.' };

  try {
    await setMyEmail(email);
  } catch (error) {
    return fail(error);
  }

  if (orderId) revalidatePath(`/orders/${orderId}`);
  revalidatePath('/account');
  return { ok: true, message: 'Saved.' };
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

/**
 * Rates the Partner who brought a completed order.
 *
 * Takes an order id and a number of stars, and NOT a Partner. The database
 * reads the Partner off the order, checks the order belongs to the caller and
 * is actually complete, and refuses a second rating on the order's own primary
 * key — so there is nothing a hand-built request can aim at somebody else and
 * no way to leave two.
 */
export async function ratePartnerAction({ orderId, stars, comment }) {
  const value = Number(stars);
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    return { ok: false, message: 'Choose between one and five stars.' };
  }

  try {
    const result = await customerRatePartner({
      orderId: String(orderId ?? ''),
      stars: value,
      comment: String(comment ?? '').trim() || null,
    });
    if (!result.success) return { ok: false, message: result.reason ?? 'Could not save that.' };
  } catch (error) {
    return fail(error);
  }

  revalidatePath(`/orders/${orderId}`);
  return { ok: true };
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
