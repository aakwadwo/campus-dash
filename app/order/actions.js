'use server';

const CONTEXT = 'customer action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import {
  submitOrder,
  customerChooseFulfilment,
  customerRatePartner,
  customerCompletePickup,
} from '@/lib/orders/transitions';
import { quoteOrder } from '@/lib/customer';
import { quoteScanOrder, submitScanOrder } from '@/lib/scan';
import { startPayment, refreshPaymentState } from '@/lib/orders/payments';
import { startTiming } from '@/lib/observability/server-timing';
import { setMyEmail } from '@/lib/customer';

/**
 * Customer actions.
 *
 * The client sends menu item ids, quantities, a fulfilment choice and a
 * destination. It sends no prices, no totals and no fees — and if it did they
 * would be ignored, because quote_order() reads only ids and quantities and
 * submit_order() recomputes every figure from the menu and pricing_config.
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
 * The checkout total, priced by the server.
 *
 * The screen never adds prices up itself. Whatever it displays came from
 * quote_order(), which is the same arithmetic that will charge the customer —
 * so the number above the Pay button cannot disagree with the order.
 */
export async function quoteAction({
  vendorId,
  items,
  fulfilmentType = null,
  mealScan = false,
  wantsPack = false,
  destinationLocationId = null,
}) {
  try {
    // TWO PRICING SYSTEMS THAT NEVER MEET, and the switch is which one is
    // asked. A food order pays a percentage of a real subtotal; a Meal Scan
    // order pays a flat fee, because the "value" it covers is the store's price
    // for food Campus Dash did not sell. Neither function reads the other's
    // figures, and nothing is added up here.
    const quote = mealScan
      ? await quoteScanOrder({
          vendorId,
          items,
          fulfilmentType: fulfilmentType ?? 'PICKUP',
          destinationLocationId,
          wantsPack,
        })
      : await quoteOrder({ vendorId, items, fulfilmentType });
    return { ok: true, quote };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Place the order and take the customer to pay for it.
 *
 * ONE TAP, TWO SERVER STEPS. The order has to exist before a charge can be
 * created against it — the amount comes from the order, never from the request
 * — but the customer should not have to press Pay on a second screen to find
 * that out. So the order is created and the checkout is opened in the same
 * action, and the URL is RETURNED rather than followed here: the provider's
 * page is on another origin, and only a full browser navigation gets somebody
 * there.
 *
 * IF EITHER HALF FAILS the customer still has an order. It sits UNPAID on
 * /orders/<id> with a Pay button, and expire_stale_orders() sweeps it if they
 * walk away. Nothing is charged and no store has been told anything.
 */
export async function submitOrderAction(_prev, formData) {
  const vendorId = String(formData.get('vendor_id') ?? '');
  // CHOSEN, NEVER ASSUMED. The checkout starts with neither option selected,
  // and a request without an answer is refused rather than defaulted to one.
  const chosen = String(formData.get('fulfilment_type') ?? '');
  if (chosen !== 'PICKUP' && chosen !== 'DELIVERY') {
    return { ok: false, message: 'Choose how you want it: collect it, or a Campus Dash Partner.' };
  }
  const fulfilmentType = chosen;
  const destinationLocationId = String(formData.get('destination_location_id') ?? '') || null;
  // TWO NOTES, TWO READERS. Order information is about the food and goes to the
  // store; Additional information is for the Partner and only exists with one.
  const orderNote = String(formData.get('order_note') ?? '').trim() || null;
  const destinationNote =
    fulfilmentType === 'DELIVERY'
      ? String(formData.get('destination_note') ?? '').trim() || null
      : null;

  let items;
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]'));
  } catch {
    return { ok: false, message: 'Your basket could not be read. Try again.' };
  }
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'Your basket is empty.' };
  }
  if (fulfilmentType === 'DELIVERY' && !destinationLocationId) {
    return { ok: false, message: 'Choose where the Partner should bring it.' };
  }

  // REDEEM BY MEAL SCAN, decided at this checkout and nowhere else. It is a way
  // of PAYING rather than a different product, so it shares the basket, the
  // fulfilment choice, the destination and the single payment that follows.
  // What changes is which pricing function runs and that an image is attached.
  const mealScan = formData.get('meal_scan') === 'on';
  const scanImagePath = String(formData.get('scan_image_path') ?? '');
  // A REQUEST the database may overrule: the pack is compulsory with a Partner.
  const wantsPack = formData.get('wants_pack') === 'on';

  if (mealScan && !scanImagePath) {
    return { ok: false, message: 'Add a photo of your Meal Scan.' };
  }

  // Only these two fields survive. Anything else the basket carried is never
  // read.
  const lines = items.map((item) => ({
    menuItemId: String(item.menuItemId),
    quantity: Number(item.quantity),
  }));

  // THE CHECKOUT'S CRITICAL PATH, measured: one log line per Pay tap, split
  // into creating the order and opening the provider's checkout, so a slow
  // lunch rush can be pinned on the database or on Paystack. Fixed tokens only;
  // no id or amount is logged.
  const timing = startTiming();

  let order;
  try {
    order = await timing.measure('submit', () =>
      mealScan
        ? submitScanOrder({
            vendorId,
            items: lines,
            fulfilmentType,
            destinationLocationId: fulfilmentType === 'DELIVERY' ? destinationLocationId : null,
            scanImagePath,
            contentType: String(formData.get('content_type') ?? ''),
            byteSize: Number(formData.get('byte_size') ?? 0),
            orderNote,
            destinationNote,
            wantsPack,
          })
        : submitOrder({
            vendorId,
            items: lines,
            fulfilmentType,
            destinationLocationId: fulfilmentType === 'DELIVERY' ? destinationLocationId : null,
            destinationNote,
            orderNote,
          })
    );
  } catch (error) {
    return fail(error);
  }

  const orderId = order.order_id;
  revalidatePath('/orders');

  let payment;
  try {
    payment = await timing.measure('payment', () => startPayment(orderId));
  } catch (error) {
    // The order is real and payable. Send them to it rather than losing it.
    console.error('[order] checkout could not be opened:', error.message);
    return { ok: true, orderId, orderHref: `/orders/${orderId}` };
  } finally {
    console.log(`[timing] checkout ${timing.summary()}`);
  }

  if (!payment.ok) {
    return { ok: true, orderId, orderHref: `/orders/${orderId}` };
  }

  return {
    ok: true,
    orderId,
    orderHref: `/orders/${orderId}`,
    redirectUrl: payment.redirectUrl ?? null,
  };
}

/**
 * Changing pickup or delivery after the order exists and before it is paid for.
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
            ? 'You will collect this order yourself.'
            : 'A Campus Dash Partner will bring it. The GH₵5 fee has been added.',
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
 * The customer types in the four digits the vendor read out, and collects.
 *
 * THE VENDOR HOLDS THE CODE. The person taking the food is the person who
 * performs the act, exactly as a Partner types in what a vendor reads them —
 * whoever holds the secret must not also be the one confirming, or the code
 * proves nothing. So there is no function anywhere that shows a customer their
 * own collection code.
 */
export async function completePickupAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  const code = String(formData.get('pickup_code') ?? '').trim();

  if (!/^\d{4}$/.test(code)) {
    return { ok: false, message: 'Enter the 4 digits the vendor gave you.' };
  }

  let result;
  try {
    result = await customerCompletePickup(orderId, code);
  } catch (error) {
    return fail(error);
  }

  revalidatePath(`/orders/${orderId}`);
  revalidatePath('/orders');
  return result.success
    ? { ok: true, message: 'Collected. Enjoy it.' }
    : { ok: false, message: result.reason ?? 'That code was not accepted.' };
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
 * A charge that never came back, given up on by the person waiting for it.
 *
 * THE SERVER DECIDES WHETHER IT IS ACTUALLY STUCK.
 * customer_abandon_stuck_payment() refuses while the payment is younger than
 * payment_pending_timeout_seconds, and the sentence it returns is written for
 * the customer — so this asks rather than deciding for itself, and a tap made
 * two seconds after paying cannot cancel a charge that is merely slow.
 *
 * Nothing is refunded here and nothing could be: a payment that reached this
 * function never succeeded. It is marked FAILED, which puts the order back to
 * "Ready to pay" with the Pay button on it. The pg_cron sweep does the same
 * thing eventually; this is for the person who is standing there now.
 */
export async function abandonPaymentAction(_prev, formData) {
  return customerChoice(
    formData,
    'customer_abandon_stuck_payment',
    'That payment has been cancelled. Nothing was taken — you can try again.'
  );
}

/**
 * Leaving an order that has not been paid for.
 *
 * ONLY AN UNPAID ONE. customer_abandon_unpaid_order() is guarded on the payment
 * state, so an order that has been paid, or has a payment in flight, is refused
 * with a sentence rather than cancelled. Nothing was charged and no store has
 * seen it, so there is nothing to undo.
 */
export async function abandonUnpaidOrderAction(_prev, formData) {
  const result = await customerChoice(
    formData,
    'customer_abandon_unpaid_order',
    'Order cancelled. Nothing was charged.'
  );
  if (result.ok) revalidatePath('/orders');
  return result;
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
