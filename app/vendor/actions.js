'use server';

const CONTEXT = 'vendor action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import {
  vendorAcceptOrder,
  vendorRejectOrder,
  vendorMarkPreparing,
  vendorMarkReady,
  vendorCompletePickupOrder,
  vendorSetAcceptingOrders,
} from '@/lib/orders/transitions';
import { updateProfile, addImage, removeImage, setPayoutDestination } from '@/lib/vendor';
import { syncPayoutSubaccount } from '@/lib/settlement/destinations';
import { uploadVendorImage, deleteVendorImage } from '@/lib/verification/documents';

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

/**
 * Never lets a raw error reach a screen. toUserError() logs the detail
 * server-side and returns a sentence a person can act on, classified so a lost
 * race does not read like a catastrophe.
 */
function fail(error) {
  return actionFailure(error, CONTEXT);
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
 * The customer shows their collection code; the vendor types in what they see.
 *
 * Self-pickup is still a handoff. The code is minted when the customer chooses
 * to collect and is on their own order screen — the vendor cannot read it, so
 * they cannot complete a collection that never happened.
 */
export async function completePickupAction(_prev, formData) {
  return run(
    () => vendorCompletePickupOrder(str(formData, 'order_id'), str(formData, 'pickup_code')),
    'Handed to the customer. Order complete.',
    str(formData, 'vendor_id')
  );
}

// --- The store itself --------------------------------------------------------

export async function updateProfileAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const walk = str(formData, 'walk_minutes');
  try {
    await updateProfile({
      vendorId,
      name: str(formData, 'name'),
      description: str(formData, 'description'),
      categoryId: str(formData, 'category_id'),
      locationId: str(formData, 'location_id'),
      locationNote: str(formData, 'location_note'),
      walkMinutes: walk === null ? null : Number(walk),
    });
  } catch (error) {
    return fail(error);
  }
  revalidatePath(`/vendor/${vendorId}`, 'layout');
  revalidatePath('/vendor/profile');
  return { ok: true, message: 'Store details saved.' };
}

/**
 * Uploads the object first, then records it.
 *
 * That order matters: a row pointing at an object that does not exist renders
 * as a broken image on every storefront, whereas an object with no row is
 * invisible and costs a few kilobytes. If the record fails, the object is
 * removed again rather than left behind.
 */
export async function addImageAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const file = formData.get('image');
  if (!file || typeof file === 'string' || file.size === 0) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  let uploaded;
  try {
    uploaded = await uploadVendorImage({ vendorId, file });
    await addImage({
      vendorId,
      storagePath: uploaded.path,
      contentType: uploaded.contentType,
      byteSize: uploaded.byteSize,
      caption: str(formData, 'caption'),
    });
  } catch (error) {
    if (uploaded?.path) await deleteVendorImage(uploaded.path).catch(() => {});
    return fail(error);
  }

  revalidatePath('/vendor/profile');
  revalidatePath(`/order/${vendorId}`);
  return { ok: true, message: 'Photo added.' };
}

export async function deleteImageAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  try {
    // The row goes first and hands back the path, so an object is only ever
    // deleted once the record authorising it is gone.
    const path = await removeImage(str(formData, 'image_id'));
    if (path) await deleteVendorImage(path).catch(() => {});
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/vendor/profile');
  revalidatePath(`/order/${vendorId}`);
  return { ok: true, message: 'Photo removed.' };
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

/**
 * The mobile money account this store is settled to.
 *
 * TWO STEPS, AND THE SECOND ONE IS ALLOWED TO FAIL. Saving the number is what
 * the vendor asked for and it either works or it does not. Registering that
 * number with the payment provider is what turns on automatic settlement, and
 * it depends on somebody else's API being up — so a failure there is reported
 * as "saved, not yet registered" rather than losing the number the vendor just
 * typed. An administrator can see the reason and retry.
 *
 * ONLY THE OWNER. vendor_set_payout_destination() re-checks
 * vendors.owner_user_id in SQL, so the vendor id in this form decides nothing.
 */
export async function savePayoutDestinationAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');

  try {
    await setPayoutDestination({
      vendorId,
      momoNetwork: str(formData, 'momo_network'),
      accountNumber: str(formData, 'account_number'),
      accountName: str(formData, 'account_name'),
    });
  } catch (error) {
    return fail(error);
  }

  const registered = await syncPayoutSubaccount({
    payeeType: 'VENDOR',
    payeeId: vendorId,
    businessName: str(formData, 'store_name') ?? 'Campus Dash vendor',
  });

  revalidatePath('/vendor/profile');

  return {
    ok: true,
    message: registered.ok
      ? 'Payout details saved. Your share of each order will be sent to this account.'
      : 'Payout details saved. We will finish setting them up with our payment provider shortly.',
  };
}
