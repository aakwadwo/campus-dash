'use server';

import { revalidatePath } from 'next/cache';
import {
  vendorAcceptOrder,
  vendorRejectOrder,
  vendorMarkPreparing,
  vendorMarkReady,
  vendorConfirmPickup,
  vendorCompletePickupOrder,
  vendorSetAcceptingOrders,
} from '@/lib/orders/transitions';

/**
 * Vendor actions.
 *
 * Each is a translation from a button press to a database call. Nothing is
 * decided here: the database checks that the caller staffs this vendor, that the
 * order is in a state the move is legal from, and writes the transition log.
 *
 * A rejected transition comes back as { success: false, reason } — routine, not
 * exceptional. Losing a race with a colleague who tapped ACCEPT first is normal
 * in a busy kitchen, and the message says so plainly.
 */
function outcome(result, successMessage) {
  return result.success
    ? { ok: true, message: successMessage }
    : { ok: false, message: result.reason ?? 'That is no longer possible.' };
}

function fail(error) {
  return { ok: false, message: error instanceof Error ? error.message : String(error) };
}

async function run(fn, successMessage, vendorId) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    return fail(error);
  }
  revalidatePath(`/vendor/${vendorId}`, 'layout');
  return outcome(result, successMessage);
}

const str = (formData, key) => {
  const value = formData.get(key);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
};

export async function acceptOrderAction(_prev, formData) {
  return run(
    () => vendorAcceptOrder(str(formData, 'order_id')),
    'Order accepted.',
    str(formData, 'vendor_id')
  );
}

export async function rejectOrderAction(_prev, formData) {
  return run(
    () => vendorRejectOrder(str(formData, 'order_id'), str(formData, 'reason')),
    'Order rejected. The customer has been told, and has not been charged.',
    str(formData, 'vendor_id')
  );
}

export async function markPreparingAction(_prev, formData) {
  return run(
    () => vendorMarkPreparing(str(formData, 'order_id')),
    'Started preparing.',
    str(formData, 'vendor_id')
  );
}

export async function markReadyAction(_prev, formData) {
  return run(
    () => vendorMarkReady(str(formData, 'order_id')),
    'Marked ready.',
    str(formData, 'vendor_id')
  );
}

/**
 * The Partner reads their code aloud; the vendor types in what they hear.
 *
 * The vendor cannot READ the stored code — order_secrets has no policy and no
 * grant for anyone — so they cannot confirm a handoff that never happened.
 */
export async function confirmPartnerPickupAction(_prev, formData) {
  return run(
    () => vendorConfirmPickup(str(formData, 'order_id'), str(formData, 'pickup_code')),
    'Handed over. The Partner now has the delivery address.',
    str(formData, 'vendor_id')
  );
}

export async function completePickupAction(_prev, formData) {
  return run(
    () => vendorCompletePickupOrder(str(formData, 'order_id')),
    'Handed to the customer. Order complete.',
    str(formData, 'vendor_id')
  );
}

export async function setAcceptingOrdersAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const accepting = formData.get('accepting') === 'true';
  try {
    await vendorSetAcceptingOrders(vendorId, accepting);
  } catch (error) {
    return fail(error);
  }
  revalidatePath(`/vendor/${vendorId}`, 'layout');
  return {
    ok: true,
    message: accepting ? 'You are open for orders.' : 'Closed. No new orders will arrive.',
  };
}
