'use server';

const CONTEXT = 'vendor action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import { vendorMarkReady, vendorSetAcceptingOrders } from '@/lib/orders/transitions';
import {
  updateProfile,
  addImage,
  removeImage,
  setPrimaryImage,
  setPayoutDestination,
  setMenuItemAvailable,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  clearMenuItemImage,
} from '@/lib/vendor';
import { vendorRedeemScan, vendorRefuseScan } from '@/lib/scan';
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
 * The store says the meal scan is good.
 *
 * THIS IS THE STORE'S ACT, and it used to be the Partner's. A Partner standing
 * at a counter reporting that an entitlement had been honoured was recording an
 * account of something nobody had checked; the restaurant is the only party
 * that can actually judge it, and the only one holding the food.
 *
 * It is separate from pressing Ready on purpose. Verifying a scan and handing
 * food over are different claims, and collapsing them would lose the one that
 * matters on the day a scan turns out to be dead.
 */
export async function redeemScanAction(_prev, formData) {
  const orderId = str(formData, 'order_id');
  const vendorId = str(formData, 'vendor_id');
  return run(() => vendorRedeemScan(orderId), 'Scan verified. Mark it ready when the food is.', [
    `/vendor/${vendorId}`,
    `/vendor/${vendorId}/orders/${orderId}`,
  ]);
}

/**
 * The store says the scan cannot be honoured.
 *
 * NO MONEY MOVES. What the customer paid is a Campus Dash fee, and whether it
 * is refunded is a decision nobody has made — so the order stops here and an
 * administrator picks it up, rather than a database function inventing a refund
 * policy.
 */
export async function refuseScanAction(_prev, formData) {
  const orderId = str(formData, 'order_id');
  const vendorId = str(formData, 'vendor_id');
  const reason = str(formData, 'reason');

  if (!reason) return { ok: false, message: 'Say why the scan could not be honoured.' };

  return run(
    () => vendorRefuseScan(orderId, reason),
    'Recorded. Campus Dash will follow it up with the customer.',
    [`/vendor/${vendorId}`, `/vendor/${vendorId}/orders/${orderId}`]
  );
}

/**
 * Sold out, withdrawn, or back on.
 *
 * THREE ACTS, ONE CALL, and the reason is what keeps them apart. A sold-out
 * mark is cleared when the store next reopens, because running out of jollof is
 * a fact about a service; a withdrawn item stays off until somebody puts it
 * back, because that was a decision.
 *
 * Either way the customer keeps SEEING the item, marked, because a dish that
 * vanishes reads as a store that stopped selling it.
 */
export async function setMenuItemAvailableAction(_prev, formData) {
  const available = formData.get('available') === 'true';
  const reason = formData.get('reason') === 'WITHDRAWN' ? 'WITHDRAWN' : 'SOLD_OUT';
  const name = str(formData, 'name') ?? 'That item';

  try {
    await setMenuItemAvailable(str(formData, 'menu_item_id'), available, reason);
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${str(formData, 'vendor_id')}`);

  return {
    ok: true,
    message: available
      ? `${name} is back on the menu.`
      : reason === 'WITHDRAWN'
        ? `${name} is off the menu until you put it back.`
        : `${name} is marked sold out. It comes back when you reopen.`,
  };
}

export async function createMenuItemAction(_prev, formData) {
  const vendorId = str(formData, 'vendor_id');
  const name = str(formData, 'name');
  const price = parsePrice(formData.get('price'));

  if (!name) return { ok: false, message: 'Give the item a name.' };
  if (price === null) return { ok: false, message: 'Give the item a price, like 35 or 35.50.' };

  try {
    await createMenuItem({
      vendorId,
      name,
      pricePesewas: price,
      description: str(formData, 'description'),
      scanEligible: formData.get('scan_eligible') === 'on',
    });
  } catch (error) {
    return fail(error);
  }

  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${vendorId}`);
  return { ok: true, message: `${name} added to your menu.` };
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
  const price = parsePrice(formData.get('price'));

  if (formData.get('price') && price === null) {
    return { ok: false, message: 'Give the item a price, like 35 or 35.50.' };
  }

  try {
    await updateMenuItem({
      menuItemId: str(formData, 'menu_item_id'),
      name: str(formData, 'name'),
      pricePesewas: price,
      // An empty box means "clear the description", which is different from
      // "leave it alone" — so the empty string is passed through rather than
      // collapsed to null by str().
      description: String(formData.get('description') ?? '').trim(),
      scanEligible: formData.get('scan_eligible') === 'on',
    });
  } catch (error) {
    return fail(error);
  }

  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${vendorId}`);
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

  revalidatePath('/vendor/menu');
  revalidatePath(`/order/${vendorId}`);
  return { ok: true, message: `${name} removed from your menu.` };
}

/**
 * "35" and "35.50" both mean pesewas in the end, and neither may become a float.
 *
 * Parsed as two integer parts and combined, rather than multiplied by 100:
 * `35.35 * 100` is 3534.9999999999995 in IEEE 754, and rounding that is a habit
 * that eventually rounds the wrong way on somebody's money.
 */
function parsePrice(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/[^\d.]/g, '');
  if (!text || !/^\d+(\.\d{1,2})?$/.test(text)) return null;

  const [cedis, pesewas = ''] = text.split('.');
  const value = Number(cedis) * 100 + Number(pesewas.padEnd(2, '0'));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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
  // Open or closed shows on the board, and reopening clears sold-out marks on
  // the menu and the storefront. No order screen under the board depends on it.
  revalidatePath(`/vendor/${vendorId}`);
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
