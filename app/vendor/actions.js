'use server';

const CONTEXT = 'vendor action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import { vendorMarkReady, vendorSetAcceptingOrders } from '@/lib/orders/transitions';
import {
  updateProfile,
  addImage,
  removeImage,
  setPayoutDestination,
  setMenuItemAvailable,
  getOrderDetail,
} from '@/lib/vendor';
import { syncPayoutSubaccount } from '@/lib/settlement/destinations';
import { uploadVendorImage, deleteVendorImage } from '@/lib/verification/documents';

/**
 * Vendor actions.
 *
 * Each is a translation from a button press to a database call. Nothing is
 * decided here: the database checks that the caller staffs this vendor, that the
 * order is in a state the move is legal from, and writes the transition log.
 *
 * THERE IS NO ACCEPT AND NO REJECT. Orders arrive paid for, so the store's only
 * order button is "Ready for pickup". The old transitions still exist in the
 * database for the sake of orders placed before that changed, but no client
 * role can execute them — see the migration.
 *
 * A rejected transition comes back as { success: false, reason } — routine, not
 * exceptional. A colleague who marked the same order ready a second earlier is
 * normal in a busy kitchen, and the message says so plainly.
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

/**
 * "Ready for pickup" — the store's one button, and deliberately not called
 * "Done". Done would be a lie: nobody has the food yet, and the handoff still
 * has to be proved with a code.
 */
export async function markReadyAction(_prev, formData) {
  const orderId = str(formData, 'order_id');
  const result = await run(
    () => vendorMarkReady(orderId),
    'Ready for pickup. Read the code out to whoever collects it.',
    str(formData, 'vendor_id')
  );
  if (!result.ok) return result;

  // A DELIVERY NOBODY HAS TAKEN YET has no one at the counter and no code to
  // read out, so saying so would send the store looking for a Partner who does
  // not exist. The wording is chosen from the order as it now stands; the
  // transition itself is unchanged. If the order cannot be read back, the
  // general message stands.
  const order = await getOrderDetail(orderId).catch(() => null);
  if (order?.fulfilment_type === 'DELIVERY' && !order.partner_assigned) {
    return {
      ok: true,
      message:
        'Ready for pickup. It is waiting for a Partner, and the code appears here when one arrives.',
    };
  }
  return result;
}

/**
 * Sold out, or back on today's menu.
 *
 * The customer keeps seeing the item — marked sold out — because a dish that
 * vanishes reads as a store that stopped selling it. Every sold-out mark is
 * cleared when the store next reopens, so nobody has to walk back through the
 * menu in the morning.
 */
export async function setMenuItemAvailableAction(_prev, formData) {
  const available = formData.get('available') === 'true';
  const name = str(formData, 'name') ?? 'That item';
  try {
    await setMenuItemAvailable(str(formData, 'menu_item_id'), available);
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${str(formData, 'vendor_id')}`);
  return {
    ok: true,
    message: available ? `${name} is back on the menu.` : `${name} is marked sold out.`,
  };
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
  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${vendorId}`);
  return {
    ok: true,
    // REOPENING CLEARS THE SOLD-OUT MARKS, and the message says so rather than
    // leaving a vendor to discover it. Running out of jollof is a fact about a
    // service, not a property of the dish.
    message: accepting
      ? 'Open for orders. Everything on your menu is available again.'
      : 'Closed. No new orders will arrive. Orders already in your kitchen are unaffected.',
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
