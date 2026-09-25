'use server';

const CONTEXT = 'vendor action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import { vendorMarkReady, vendorSetAcceptingOrders } from '@/lib/orders/transitions';
import {
  updateProfile,
  updateLocation,
  addImage,
  removeImage,
  setPrimaryImage,
  setPayoutDestination,
  getMyVendors,
  setMenuItemAvailable,
  setMenuItemActive,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  clearMenuItemImage,
} from '@/lib/vendor';
import { vendorRedeemScan, vendorRefuseScan } from '@/lib/scan';
import { deferNotification } from '@/lib/notifications/defer';
import { notifyOrderEvent } from '@/lib/orders/notify';
import { NOTIFICATION_EVENT } from '@/lib/notifications';
import { syncPayoutSubaccount } from '@/lib/settlement/destinations';
import { uploadVendorImage, deleteVendorImage } from '@/lib/verification/documents';
import { readPricingForm, parsePositiveCedis } from '@/lib/util/item-price';
import { readVendorLocation } from '@/lib/util/vendor-location';

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

async function run(fn, successMessage, paths) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    return fail(error);
  }
  paths.forEach((path) => revalidatePath(path));
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
  const vendorId = str(formData, 'vendor_id');
  // The order screen this was pressed on, and the board it returns to. Nothing
  // else a store sees changes when one order is made.
  //
  // NO READ-BACK. This used to fetch the order again only to choose between two
  // wordings. The screen is re-rendered from the server in this same response,
  // and it already says which case it is — the code to read out, or "Waiting for
  // a Partner" — so the extra round trip bought a sentence the page now shows.
  return run(
    () => vendorMarkReady(orderId),
    'Ready for pickup. Read the code out to whoever collects it.',
    [`/vendor/${vendorId}`, `/vendor/${vendorId}/orders/${orderId}`]
  );
}

/**
 * The store says the Meal Scan is good.
 *
 * THIS IS THE STORE'S ACT, and it used to be the Partner's. A Partner standing
 * at a counter reporting that an entitlement had been honoured was recording an
 * account of something nobody had checked; the restaurant is the only party
 * that can actually judge it, and the only one holding the food.
 *
 * IT IS THE GATE. On a Partner order the same statement that records the
 * approval opens the search, so nobody is sent for an order whose entitlement
 * has not been looked at. That is why it is separate from pressing Ready:
 * verifying a scan and handing food over are different claims.
 */
export async function redeemScanAction(_prev, formData) {
  const orderId = str(formData, 'order_id');
  const vendorId = str(formData, 'vendor_id');
  return run(
    () => vendorRedeemScan(orderId),
    'Meal Scan approved. Mark it ready when the food is.',
    [`/vendor/${vendorId}`, `/vendor/${vendorId}/orders/${orderId}`]
  );
}

/**
 * The store says the Meal Scan is not valid.
 *
 * IRREVERSIBLE, AND IT ENDS THE ORDER. vendor_refuse_scan() cancels it in the
 * same statement, so nothing can be prepared, marked ready or dispatched
 * against it afterwards, and there is no path that attaches a second scan to a
 * paid order. The screen asks the store to confirm before this is ever called.
 *
 * NO MONEY MOVES. What the customer paid is a Campus Dash fee, and whether it
 * is refunded is a decision nobody has made — so an administrator picks it up
 * from the exceptions list rather than a database function inventing a refund
 * policy. The customer is TEXTED, because this ends their order while they are
 * not looking at it.
 */
export async function refuseScanAction(_prev, formData) {
  const orderId = str(formData, 'order_id');
  const vendorId = str(formData, 'vendor_id');
  const reason = str(formData, 'reason');

  if (!reason) return { ok: false, message: 'Say why the Meal Scan is not valid.' };

  let result;
  try {
    result = await vendorRefuseScan(orderId, reason);
  } catch (error) {
    return fail(error);
  }

  // AFTER THE TRANSITION, AND ONLY IF IT HAPPENED. A refusal that lost a race
  // changed nothing, and texting somebody that their order is over would be
  // the loudest possible way to be wrong.
  if (result.success) {
    await deferNotification(NOTIFICATION_EVENT.SCAN_REFUSED, () =>
      notifyOrderEvent(NOTIFICATION_EVENT.SCAN_REFUSED, orderId)
    );
  }

  revalidatePath(`/vendor/${vendorId}`);
  revalidatePath(`/vendor/${vendorId}/orders/${orderId}`);
  return outcome(result, 'Recorded. The customer has been told they need to order again.');
}

/**
 * ON or OFF — whether the store is serving this item right now.
 *
 * THE CATALOGUE IS PERSISTENT. Off removes nothing: the item keeps its price,
 * its description and its history, and customers simply stop seeing it. What
 * moves with it is the store, because a store with nothing on is a store that
 * is shut — so the message reports the state the DATABASE ended in rather than
 * the one this button was aiming at.
 */
export async function setMenuItemActiveAction(_prev, formData) {
  const active = formData.get('active') === 'true';
  const name = str(formData, 'name') ?? 'That item';
  const vendorId = str(formData, 'vendor_id');

  let result;
  try {
    result = await setMenuItemActive(str(formData, 'menu_item_id'), active);
  } catch (error) {
    return fail(error);
  }
  revalidateMenu(vendorId);

  return {
    ok: true,
    message: active
      ? `${name} is on the menu.`
      : result?.store_open
        ? `${name} is off the menu. It stays in your items.`
        : `${name} was the last one on, so your store is now closed.`,
  };
}

/**
 * Sold out, or back on.
 *
 * A DIFFERENT THING FROM OFF, and deliberately a different button. The customer
 * keeps SEEING a sold-out item, marked, because a dish that vanishes reads as a
 * store that stopped selling it; a dish marked sold out reads as a store that
 * is busy. The mark clears itself when the store next opens.
 */
export async function setMenuItemAvailableAction(_prev, formData) {
  const available = formData.get('available') === 'true';
  const name = str(formData, 'name') ?? 'That item';

  try {
    await setMenuItemAvailable(str(formData, 'menu_item_id'), available);
  } catch (error) {
    return fail(error);
  }
  revalidateMenu(str(formData, 'vendor_id'));

  return {
    ok: true,
    message: available
      ? `${name} is available again.`
      : `${name} is marked sold out. It comes back when you next open.`,
  };
}

/**
 * Every screen a menu change reaches. The store's own board is on the list
 * because turning the last item off closes the shop, and the board is where a
 * vendor reads whether they are open.
 */
function revalidateMenu(vendorId) {
  revalidatePath('/vendor/menu');
  revalidatePath(`/vendor/${vendorId}`);
  revalidatePath(`/order/${vendorId}`);
  revalidatePath('/order');
}

/**
 * Whether Campus Dash has turned meal scans on for this store.
 *
 * Asked HERE, on the server, and not taken from the form: the option is not
 * shown to a store without scans, and a form that sends it anyway is refused
 * rather than trusted. The database refuses it again on the write.
 */
async function storeTakesScans(vendorId) {
  const vendors = await getMyVendors();
  return Boolean(vendors.find((v) => v.vendor_id === vendorId)?.can_accept_scans);
}

const SCANS_OFF = 'Meal scans are not turned on for your store.';

export async function createMenuItemAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const name = str(formData, 'name');
  const pricing = readPricingForm(formData);

  if (!name) return { ok: false, message: 'Give the item a name.' };
  if (pricing.message) return { ok: false, message: pricing.message };

  const wantsScan = !pricing.value && formData.get('scan_eligible') === 'on';
  if (wantsScan && !(await storeTakesScans(vendorId))) return { ok: false, message: SCANS_OFF };

  const price = pricing.value ? null : parsePositiveCedis(formData.get('price'));
  if (!pricing.value && price === null) {
    return { ok: false, message: 'Give the item a price, like 35 or 35.50.' };
  }

  try {
    await createMenuItem({
      vendorId,
      name,
      pricePesewas: price,
      description: str(formData, 'description'),
      scanEligible: wantsScan,
      pricing: pricing.value,
    });
  } catch (error) {
    return fail(error);
  }

  revalidateMenu(vendorId);
  return { ok: true, message: `${name} added to your items. Turn it on when you are serving it.` };
}

/**
 * Editing an item.
 *
 * A PRICE CHANGE REACHES NO EXISTING ORDER. price_order() snapshots every figure
 * onto the order at submission and order_items keeps its own copy, so this moves
 * what the next customer is quoted and nothing else — which is the whole reason
 * a store can be trusted with its own prices.
 */
export async function updateMenuItemAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const pricing = readPricingForm(formData);
  if (pricing.message) return { ok: false, message: pricing.message };

  // A variable item keeps its fixed price untouched; the form does not show it.
  const price = pricing.value ? null : parsePositiveCedis(formData.get('price'));

  if (!pricing.value && formData.get('price') && price === null) {
    return { ok: false, message: 'Give the item a price, like 35 or 35.50.' };
  }

  // A STORE WITHOUT SCANS NEVER TOUCHES THE FLAG. Its form has no checkbox, so
  // reading the missing box as "off" would silently clear a flag set while
  // scans were on, and it would be lost when Campus Dash turns them back on.
  const scans = await storeTakesScans(vendorId);
  if (!scans && formData.get('scan_eligible') === 'on') return { ok: false, message: SCANS_OFF };

  try {
    await updateMenuItem({
      menuItemId: str(formData, 'menu_item_id'),
      name: str(formData, 'name'),
      pricePesewas: price,
      // An empty box means "clear the description", which is different from
      // "leave it alone" — so the empty string is passed through rather than
      // collapsed to null by str().
      description: String(formData.get('description') ?? '').trim(),
      scanEligible: scans ? !pricing.value && formData.get('scan_eligible') === 'on' : null,
      // FIXED is sent too, so choosing "One price" returns a variable item to
      // its fixed price. No field at all means the store cannot see the
      // choice, and the item's mode is left exactly as it is.
      pricing: pricing.value ?? (pricing.mode ? { mode: pricing.mode } : undefined),
    });
  } catch (error) {
    return fail(error);
  }

  revalidateMenu(vendorId);
  return { ok: true, message: 'Saved.' };
}

/**
 * Removing an item for good.
 *
 * REFUSED IF ANYBODY HAS ORDERED IT, in SQL, and the message says what to do
 * instead. Deleting it would either orphan those order lines or rewrite what
 * somebody was charged for.
 */
export async function deleteMenuItemAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const name = str(formData, 'name') ?? 'That item';

  try {
    const path = await clearMenuItemImage(str(formData, 'menu_item_id'));
    await deleteMenuItem(str(formData, 'menu_item_id'));
    // The row is gone, so the object it pointed at is unreachable. Removing it
    // after the row means a failure here costs a stray file rather than a
    // menu item pointing at nothing.
    if (path) await deleteVendorImage(path).catch(() => {});
  } catch (error) {
    return fail(error);
  }

  revalidateMenu(vendorId);
  return { ok: true, message: `${name} removed from your items.` };
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
  // The board's heading is the only place under /vendor/<id> a store's details
  // appear, so the page — not the whole segment and its order screens.
  revalidatePath(`/vendor/${vendorId}`);
  revalidatePath('/vendor/profile');
  return { ok: true, message: 'Store details saved.' };
}

/**
 * On or off campus, and where exactly. Its own form and its own write, so a
 * store that has never said where it is can say so without re-saving (and
 * re-validating) every other detail. Ownership is checked in SQL.
 */
export async function updateLocationAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const location = readVendorLocation(formData);
  if (!location.ok) return { ok: false, message: location.message };
  try {
    await updateLocation({ vendorId, area: location.area, details: location.details });
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/vendor/profile');
  return { ok: true, message: 'Location saved.' };
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

  revalidateStorePhotos(vendorId);
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
  revalidateStorePhotos(vendorId);
  return { ok: true, message: 'Photo removed.' };
}

export async function setPrimaryImageAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  try {
    await setPrimaryImage(str(formData, 'image_id'));
  } catch (error) {
    return fail(error);
  }
  revalidateStorePhotos(vendorId);
  return { ok: true, message: 'Main photo changed.' };
}

/**
 * Every page a store's photo appears on. The landing page and the marketplace
 * were missing from this list, so a new photo reached the store's own page and
 * nowhere a customer actually looks first.
 */
function revalidateStorePhotos(vendorId) {
  revalidatePath('/vendor/profile');
  revalidatePath(`/order/${vendorId}`);
  revalidatePath('/order');
  revalidatePath('/scan');
  revalidatePath('/');
}

export async function setAcceptingOrdersAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const accepting = formData.get('accepting') === 'true';
  try {
    await vendorSetAcceptingOrders(vendorId, accepting);
  } catch (error) {
    return fail(error);
  }
  // Open or closed shows on the board, and both directions move the menu:
  // opening clears sold-out marks, closing takes every item off.
  revalidateMenu(vendorId);
  return {
    ok: true,
    // BOTH CONSEQUENCES ARE SAID OUT LOUD rather than left to be discovered.
    // Closing empties the active menu — the items are all still there — and
    // opening clears the sold-out marks, because running out of jollof is a
    // fact about a service and not a property of the dish.
    message: accepting
      ? 'Open for orders. Everything on your menu is available again.'
      : 'Closed, and your menu is cleared. Your items are all still here — turn them on when you next open. Orders already in your kitchen are unaffected.',
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

  // REGISTERED WITH PAYSTACK ONLY FOR AN APPROVED STORE. A live subaccount for
  // an applicant who may be rejected is payment routing set up for nobody; an
  // applicant's details are registered when the store is approved.
  const mine = await getMyVendors().catch(() => []);
  const approved = mine.some((v) => v.vendor_id === vendorId && v.status === 'ACTIVE');

  const registered = approved
    ? await syncPayoutSubaccount({
        payeeType: 'VENDOR',
        payeeId: vendorId,
        businessName: str(formData, 'store_name') ?? 'Campus Dash vendor',
      })
    : null;

  revalidatePath('/vendor/profile');
  revalidatePath('/vendor/application');

  // WHAT IS TRUE, AND NOT MORE. Paystack paying the store's share into its
  // subaccount at checkout is what a registration turns on; when the money then
  // reaches the phone is Paystack's settlement schedule, not a promise we make.
  return {
    ok: true,
    message: !approved
      ? 'Payout details saved. They are set up for payment when your store is approved.'
      : registered?.ok
        ? 'Payout details saved. Your share of each order is now paid to you through Paystack when the customer pays.'
        : 'Payout details saved. We will finish setting them up with our payment provider shortly.',
  };
}
