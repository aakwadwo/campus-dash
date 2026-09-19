'use server';

const CONTEXT = 'admin action';

import { actionFailure } from '@/lib/errors';
import { authoriseAdminAction } from '@/lib/auth/session';

import { revalidatePath } from 'next/cache';
import * as admin from '@/lib/admin';
import { scanImageUrl } from '@/lib/scan';
import { purgePartnerDocuments } from '@/lib/admin/documents';
import { runSettlement, retryFailedPayouts, periodFor } from '@/lib/settlement';
import { pesewasFromCedisInput, formatPesewas } from '@/lib/util/money';
import { normaliseGhanaPhone } from '@/lib/sms';

/**
 * Server actions for the admin module.
 *
 * Each one is a thin translation from FormData to a database call. The database
 * re-checks is_admin(), validates, and writes the audit row in the same
 * transaction as the change.
 *
 * EVERY EXPORT STARTS WITH authoriseAdminAction(), and that is not a
 * duplicate of the database check. A server action is a public POST endpoint:
 * the admin layout never runs in front of it. Settlement and payout retries go
 * through the service-role client, which bypasses is_admin() entirely, so for
 * those the guard is the only thing standing between a stranger and a payout
 * run. It also enforces what the database cannot see: that the session is a
 * password sign-in inside the admin time limit. tests/admin-action-auth.test.js
 * fails if an export is added without it.
 *
 * Errors are returned rather than thrown so the form can show what went wrong
 * — an admin needs to read "3 order lines reference this item", not a stack.
 */
function ok(message) {
  return { ok: true, message };
}

/**
 * Never lets a raw error reach a screen. toUserError() logs the detail
 * server-side and returns a sentence a person can act on, classified so a lost
 * race does not read like a catastrophe.
 */
function fail(error) {
  return actionFailure(error, CONTEXT);
}

async function run(fn, successMessage, paths = ['/admin']) {
  try {
    const result = await fn();
    paths.forEach((path) => revalidatePath(path, 'layout'));
    return ok(typeof successMessage === 'function' ? successMessage(result) : successMessage);
  } catch (error) {
    return fail(error);
  }
}

const str = (formData, key) => {
  const value = formData.get(key);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? null : trimmed;
};

const num = (formData, key) => {
  const value = str(formData, key);
  return value === null ? null : Number(value);
};

// --- Vendors ----------------------------------------------------------------

/**
 * Creates a CATALOGUE ENTRY, not an account.
 *
 * A business that wants a dashboard registers itself at /vendor/signup. This
 * exists for the other case: a restaurant Campus Dash lists so a prepaid meal
 * can be fetched from it, which has signed up for nothing and operates nothing.
 * The row has no owner, so nobody can sign in as it.
 */
export async function createVendorAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.createVendor({
        name: str(formData, 'name'),
        phone: str(formData, 'phone'),
        reason: str(formData, 'reason'),
        categoryId: str(formData, 'category_id'),
        locationId: str(formData, 'location_id'),
        locationNote: str(formData, 'location_note'),
        walkMinutes: num(formData, 'walk_minutes'),
      }),
    (v) => `Created ${v.name}. It is DRAFT and not accepting orders yet.`,
    ['/admin/vendors']
  );
}

/**
 * Creates a store that HAS AN ACCOUNT, for a vendor recruited in person.
 *
 * The other door, /vendor/signup, is unchanged and is still how a business
 * registers itself. This is for the store that will never type its own details
 * in: an administrator takes them at the counter, the owner signs in with the
 * number that was verified there, and the store lands PENDING_APPROVAL in the
 * SAME queue — so approval, the audit row and the welcome SMS are the existing
 * ones rather than a second path that skips them.
 */
export async function createVendorAccountAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const phone = normaliseGhanaPhone(str(formData, 'phone') ?? '');
  if (!phone) {
    return { ok: false, message: 'Enter a valid Ghanaian phone number, e.g. 020 123 4567.' };
  }

  return run(
    () =>
      admin.createVendorAccount({
        storeName: str(formData, 'name'),
        ownerPhone: phone,
        applicantName: str(formData, 'applicant_name'),
        categoryId: str(formData, 'category_id'),
        description: str(formData, 'description'),
        ownerIsStudent: formData.get('owner_is_student') === 'yes',
        locationId: str(formData, 'location_id'),
        locationNote: str(formData, 'location_note'),
        walkMinutes: num(formData, 'walk_minutes'),
        reason: str(formData, 'reason'),
      }),
    (v) => `Created ${v.name}. It is awaiting approval — approve it on its own page.`,
    ['/admin/vendors']
  );
}

/**
 * Deletes a store that has never traded, and the owner identity if the store
 * was the only thing it held.
 *
 * WHAT IT WILL NOT DO IS DECIDED IN SQL. admin_delete_vendor() refuses a store
 * with orders or settlement records and says how many, because those rows are
 * what reconciles the money. Suspension is the control for a store that has
 * traded.
 */
export async function deleteVendorAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.deleteVendor({
        vendorId: str(formData, 'vendor_id'),
        reason: str(formData, 'reason'),
      }),
    (result) => `Deleted ${result?.name ?? 'the store'}.`,
    ['/admin/vendors']
  );
}

/**
 * Deletes an account that has never ordered, with every capability row on it.
 *
 * The same refusals, in the same place: an administrator, the caller, a store
 * owner, or anybody with an order, a settlement record or a rating against
 * them is refused by the database with a sentence saying why.
 */
export async function deleteCustomerAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.deleteCustomer({
        userId: str(formData, 'user_id'),
        reason: str(formData, 'reason'),
      }),
    (result) => `Deleted ${result?.name ?? 'the account'}.`,
    ['/admin/customers']
  );
}

export async function updateVendorAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.updateVendor({
        vendorId: str(formData, 'vendor_id'),
        reason: str(formData, 'reason'),
        name: str(formData, 'name'),
        phone: str(formData, 'phone'),
        categoryId: str(formData, 'category_id'),
        description: str(formData, 'description'),
        locationId: str(formData, 'location_id'),
        locationNote: str(formData, 'location_note'),
        walkMinutes: num(formData, 'walk_minutes'),
      }),
    'Vendor updated.',
    ['/admin/vendors']
  );
}

/**
 * Approve or reject a store application.
 *
 * APPROVAL DOES NOT OPEN THE STORE — going live is the vendor's own decision.
 * A rejection carries a reason because the applicant can correct it and
 * resubmit, and a rejection they cannot read is a dead end. The owner is told
 * by SMS; a failed message never un-does the decision.
 */
export async function reviewVendorAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const approved = str(formData, 'decision') === 'APPROVE';
  return run(
    () =>
      admin.reviewVendor({
        vendorId: str(formData, 'vendor_id'),
        approved,
        reason: str(formData, 'reason'),
      }),
    approved
      ? 'Approved. The owner has been texted and can open the store when they are ready.'
      : 'Rejected. The owner has been texted and can correct the application and resubmit.',
    ['/admin/vendors']
  );
}

export async function setVendorStatusAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.setVendorStatus({
        vendorId: str(formData, 'vendor_id'),
        status: str(formData, 'status'),
        reason: str(formData, 'reason'),
      }),
    (v) => `Vendor is now ${v.status}.`,
    ['/admin/vendors']
  );
}

/**
 * Whether this restaurant honours campus meal scans.
 *
 * Off for every vendor until somebody says otherwise, because a scan errand
 * sends a Partner to a counter expecting to be served for free — and being
 * wrong about that costs the Partner a walk and the customer their lunch.
 */
export async function setVendorScansAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.setVendorScans({
        vendorId: str(formData, 'vendor_id'),
        accepts: str(formData, 'accepts') === 'true',
        reason: str(formData, 'reason'),
      }),
    (v) =>
      v.can_accept_scans
        ? 'This restaurant now accepts meal scans.'
        : 'This restaurant no longer accepts meal scans.',
    ['/admin/vendors']
  );
}

// --- Vendor categories --------------------------------------------------------

export async function createVendorCategoryAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.createVendorCategory({
        slug: str(formData, 'slug'),
        name: str(formData, 'name'),
        sortOrder: num(formData, 'sort_order'),
        reason: str(formData, 'reason'),
      }),
    (c) => `Added ${c.name}.`,
    ['/admin/vendors']
  );
}

/**
 * Rename, reorder or disable a category.
 *
 * DISABLING IS NOT DELETING and touches no vendor row: a disabled category
 * disappears from the sign-up form and the customer filter, the stores already
 * in it keep trading, and every historical order keeps the category it was
 * placed under.
 */
export async function updateVendorCategoryAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const active = formData.get('is_active');
  return run(
    () =>
      admin.updateVendorCategory({
        categoryId: str(formData, 'category_id'),
        name: str(formData, 'name'),
        sortOrder: num(formData, 'sort_order'),
        isActive: active === null ? null : active === 'true',
        reason: str(formData, 'reason'),
      }),
    'Category updated.',
    ['/admin/vendors']
  );
}

// --- Vendor images ------------------------------------------------------------

export async function addVendorImageAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const vendorId = str(formData, 'vendor_id');
  const file = formData.get('image');
  if (!file || typeof file === 'string' || file.size === 0) {
    return { ok: false, message: 'Choose an image to upload.' };
  }

  let uploaded;
  try {
    const { uploadVendorImage, deleteVendorImage } = await import('@/lib/verification/documents');
    uploaded = await uploadVendorImage({ vendorId, file });
    try {
      await admin.addVendorImage({
        vendorId,
        storagePath: uploaded.path,
        contentType: uploaded.contentType,
        byteSize: uploaded.byteSize,
        caption: str(formData, 'caption'),
      });
    } catch (error) {
      // A row pointing at nothing renders as a broken image on every
      // storefront; an object with no row is invisible. Undo the upload.
      await deleteVendorImage(uploaded.path).catch(() => {});
      throw error;
    }
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }

  revalidateStorePhotos(vendorId);
  return { ok: true, message: 'Photo added.' };
}

export async function deleteVendorImageAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const vendorId = str(formData, 'vendor_id');
  try {
    const { deleteVendorImage } = await import('@/lib/verification/documents');
    // The row goes first and hands back the path, so an object is only ever
    // deleted once the record authorising it is gone.
    const path = await admin.deleteVendorImage(str(formData, 'image_id'));
    if (path) await deleteVendorImage(path).catch(() => {});
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }
  revalidateStorePhotos(vendorId);
  return { ok: true, message: 'Photo removed.' };
}

export async function setVendorPrimaryImageAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const vendorId = str(formData, 'vendor_id');
  try {
    await admin.setVendorPrimaryImage(str(formData, 'image_id'));
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }
  revalidateStorePhotos(vendorId);
  return { ok: true, message: 'Main photo changed.' };
}

/** Every page a store's photo appears on, the customer-facing ones included. */
function revalidateStorePhotos(vendorId) {
  revalidatePath(`/admin/vendors/${vendorId}`);
  revalidatePath(`/order/${vendorId}`);
  revalidatePath('/order');
  revalidatePath('/scan');
  revalidatePath('/');
}

// --- Menu items -------------------------------------------------------------

export async function createMenuItemAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () => {
      const price = pesewasFromCedisInput(formData.get('price_cedis'));
      return admin.createMenuItem({
        vendorId: str(formData, 'vendor_id'),
        name: str(formData, 'name'),
        description: str(formData, 'description'),
        pricePesewas: price,
        reason: str(formData, 'reason'),
        sortOrder: num(formData, 'sort_order') ?? 0,
      });
    },
    'Menu item created.',
    ['/admin/vendors']
  );
}

export async function updateMenuItemAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () => {
      const raw = formData.get('price_cedis');
      const price = raw === null || String(raw).trim() === '' ? null : pesewasFromCedisInput(raw);
      return admin.updateMenuItem({
        menuItemId: str(formData, 'menu_item_id'),
        reason: str(formData, 'reason'),
        name: str(formData, 'name'),
        description: str(formData, 'description'),
        pricePesewas: price,
        sortOrder: num(formData, 'sort_order'),
      });
    },
    'Menu item updated. Orders already placed keep their original price.',
    ['/admin/vendors']
  );
}

export async function setMenuItemAvailableAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.setMenuItemAvailable({
        menuItemId: str(formData, 'menu_item_id'),
        available: formData.get('available') === 'true',
        reason: str(formData, 'reason'),
      }),
    (item) => `${item.name} is now ${item.is_available ? 'available' : 'unavailable'}.`,
    ['/admin/vendors']
  );
}

export async function deleteMenuItemAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.deleteMenuItem({
        menuItemId: str(formData, 'menu_item_id'),
        reason: str(formData, 'reason'),
      }),
    (deleted) => (deleted ? 'Menu item deleted.' : 'Menu item was already gone.'),
    ['/admin/vendors']
  );
}

// --- Locations --------------------------------------------------------------

export async function createLocationAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.createLocation({
        kind: str(formData, 'kind'),
        name: str(formData, 'name'),
        reason: str(formData, 'reason'),
        parentId: str(formData, 'parent_id'),
        isDeliverable: formData.get('is_deliverable') === 'on',
        walkMinutes: num(formData, 'walk_minutes'),
        sortOrder: num(formData, 'sort_order') ?? 0,
      }),
    (l) => `Created ${l.name}.`,
    ['/admin/locations']
  );
}

export async function updateLocationAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.updateLocation({
        locationId: str(formData, 'location_id'),
        reason: str(formData, 'reason'),
        name: str(formData, 'name'),
        isDeliverable: formData.has('is_deliverable')
          ? formData.get('is_deliverable') === 'on'
          : null,
        walkMinutes: num(formData, 'walk_minutes'),
        sortOrder: num(formData, 'sort_order'),
      }),
    'Location updated.',
    ['/admin/locations']
  );
}

export async function setLocationActiveAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.setLocationActive({
        locationId: str(formData, 'location_id'),
        active: formData.get('active') === 'true',
        reason: str(formData, 'reason'),
      }),
    (l) =>
      l.is_active
        ? `${l.name} is active again.`
        : `${l.name} deactivated, along with everything beneath it.`,
    ['/admin/locations']
  );
}

export async function deleteLocationAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.deleteLocation({
        locationId: str(formData, 'location_id'),
        reason: str(formData, 'reason'),
      }),
    (deleted) => (deleted ? 'Location deleted.' : 'Location was already gone.'),
    ['/admin/locations']
  );
}

// --- Partners ---------------------------------------------------------------

export async function reviewPartnerAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.reviewPartner({
        userId: str(formData, 'user_id'),
        status: str(formData, 'status'),
        reason: str(formData, 'reason'),
        notes: str(formData, 'notes'),
      }),
    (p) => `Partner application ${p.status.toLowerCase()}.`,
    ['/admin/partners']
  );
}

/**
 * Irreversible. The confirmation lives in the form; the authorisation and the
 * choice of WHAT may be deleted live in purgePartnerDocuments(), which
 * re-derives the allowed paths itself and ignores anything else.
 */
export async function purgePartnerDocumentsAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      purgePartnerDocuments({
        userId: str(formData, 'user_id'),
        // No paths from the form at all. The server looks up what this Partner
        // actually has, which is the only list that can be right.
        reason: str(formData, 'reason'),
      }),
    'Verification documents deleted.',
    ['/admin/partners']
  );
}

// --- Accounts ----------------------------------------------------------------

/**
 * Suspends or reinstates an account.
 *
 * `suspend` arrives as an explicit "true"/"false" rather than a checkbox,
 * because "suspend" and "reinstate" are two different decisions and a control
 * whose meaning depends on the row's current state is a control an operator
 * misreads at speed.
 *
 * THE AUTHORISATION AND THE SELF-SUSPENSION REFUSAL BOTH LIVE IN SQL.
 * admin_set_user_suspended() re-checks is_admin(), demands a reason and rejects
 * `p_user_id = auth.uid()` itself. Nothing here is a substitute for that.
 */
export async function setUserSuspendedAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const suspend = str(formData, 'suspend');
  if (suspend !== 'true' && suspend !== 'false') {
    return { ok: false, message: 'Say explicitly whether this account is being suspended.' };
  }

  return run(
    () =>
      admin.setUserSuspended({
        userId: str(formData, 'user_id'),
        suspended: suspend === 'true',
        reason: str(formData, 'reason'),
      }),
    (u) =>
      u.is_suspended
        ? 'Account suspended. Every capability it held (ordering, delivering, vendor staff) is now refused.'
        : 'Account reinstated. The capabilities it holds are available again; a Partner must go online themselves.',
    ['/admin/customers', '/admin/partners']
  );
}

// --- Order overrides ---------------------------------------------------------

export async function cancelOrderAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.cancelOrder({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Order cancelled. Any money taken is marked for refund.',
    ['/admin/orders']
  );
}

export async function completeOrderAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.completeOrder({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Order force-completed.',
    ['/admin/orders']
  );
}

export async function reassignDeliveryAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.reassignDelivery({
        orderId: str(formData, 'order_id'),
        reason: str(formData, 'reason'),
      }),
    'Partner removed. The order is back in the pool with a fresh pickup code.',
    ['/admin/orders']
  );
}

export async function markRefundedAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.markRefunded({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Marked as refunded.',
    ['/admin/orders']
  );
}

export async function resolveDisputeAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.resolveDispute({
        orderId: str(formData, 'order_id'),
        reason: str(formData, 'reason'),
        notes: str(formData, 'notes'),
      }),
    'Dispute closed.',
    ['/admin/orders']
  );
}

// --- Settlement --------------------------------------------------------------

/**
 * Runs a settlement batch. Safe to press twice: the run for a period is
 * returned rather than recreated, its allocations are already claimed, and its
 * payouts are already on their way.
 *
 * "Sent" here means the provider accepted the transfer. It is PAID only once
 * the transfer event arrives — see hard rule 11.
 */
export async function runSettlementAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const payeeType = str(formData, 'payee_type');
  try {
    const { periodStart, periodEnd } = periodFor(payeeType);
    const result = await runSettlement({ payeeType, periodStart, periodEnd });
    revalidatePath('/admin/settlements', 'layout');
    // Deferred money is not a failure and not an absence: it is owed, it is
    // still in the pool, and a later run will move it. Saying so is the whole
    // point of the threshold being visible.
    const deferred = result.deferredPayees
      ? ` ${formatPesewas(result.deferredPesewas)} held for ${result.deferredPayees} ` +
        `${result.deferredPayees === 1 ? 'payee' : 'payees'} under the minimum, still owed, ` +
        `and swept into a later run.`
      : '';

    // A PARTNER RUN SENDS NOTHING, on purpose. It gathers what is owed into
    // payouts and stops; the money leaves when a person sends it and records
    // the reference. Saying "0 payouts sent" here would read as a failure.
    if (result.manual) {
      return {
        ok: true,
        message: result.awaitingManualSettlement
          ? `${result.awaitingManualSettlement} ${
              result.awaitingManualSettlement === 1 ? 'Partner is' : 'Partners are'
            } ready to be paid. Send the money, then record each one below.` + deferred
          : 'Nothing was owed for that period.' + deferred,
      };
    }

    return {
      ok: result.failed === 0,
      message:
        result.attempted === 0
          ? deferred
            ? 'Nothing was moved.' + deferred
            : 'Nothing was owed for that period.'
          : `${result.accepted} of ${result.attempted} payouts sent to the provider.` +
            (result.failed ? ` ${result.failed} failed, and you can retry them.` : '') +
            deferred,
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * A person recording that they sent a Partner their money.
 *
 * THE REFERENCE IS THE EVIDENCE and the database refuses without one: a manual
 * settlement has no provider event behind it, so what the operator typed is the
 * only thing linking the row to a real transfer. Appends to admin_actions.
 */
export async function settlePayoutManuallyAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const reference = str(formData, 'reference');
  if (!reference) {
    return { ok: false, message: 'Record the transfer reference you sent it with.' };
  }

  return run(
    () =>
      admin.settlePayoutManually({
        payoutId: str(formData, 'payout_id'),
        reference,
        reason: str(formData, 'reason') ?? 'Paid by hand at the weekly run',
      }),
    'Recorded as paid.',
    ['/admin/settlements']
  );
}

/**
 * Sets where a vendor's or Partner's settlement money goes.
 *
 * The account number is validated and normalised in the database, and the
 * change is audited there in the same transaction. Changing the number clears
 * the provider's recipient code, so the next transfer cannot go to the old one.
 */
export async function setPayoutDestinationAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.setPayoutDestination({
        payeeType: str(formData, 'payee_type'),
        payeeId: str(formData, 'payee_id'),
        momoNetwork: str(formData, 'momo_network'),
        accountNumber: str(formData, 'account_number'),
        accountName: str(formData, 'account_name'),
        reason: str(formData, 'reason'),
      }),
    'Payout destination saved.',
    ['/admin/settlements']
  );
}

export async function retryPayoutsAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  try {
    const results = await retryFailedPayouts(str(formData, 'run_id'));
    revalidatePath('/admin/settlements', 'layout');
    const sent = results.filter((r) => r.ok).length;
    return { ok: true, message: `${sent} of ${results.length} retried payouts were accepted.` };
  } catch (error) {
    return fail(error);
  }
}

// --- Pilot configuration -----------------------------------------------------

/** Blank means "leave alone", so a partial edit cannot reset what it never saw. */
/**
 * Registers an existing payout destination with the payment provider.
 *
 * A retry, and it exists because the registration can fail for reasons that
 * have nothing to do with the number: Paystack unreachable, split not enabled
 * on the account, a name the network rejects. The destination is saved either
 * way, so this is the button that finishes the job later.
 */
/**
 * Records that a customer's reward was honoured, and what it was.
 *
 * THE SCREEN THAT CALLED THIS IS GONE — /admin/community was a report rather
 * than an operational destination and came off the console — but the action and
 * admin_settle_customer_reward() behind it are untouched, because the reward
 * ledger is a real record and removing a page is not a reason to stop being
 * able to write to it. It is reachable from the customer's own record.
 */
export async function settleCustomerRewardAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.settleCustomerReward({
        rewardId: str(formData, 'reward_id'),
        notes: str(formData, 'notes'),
      }),
    'Recorded.',
    ['/admin/customers']
  );
}

export async function syncPayoutDestinationAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const payeeType = str(formData, 'payee_type');
  const payeeId = str(formData, 'payee_id');

  return run(
    async () => {
      const result = await admin.syncPayoutDestination({
        payeeType,
        payeeId,
        businessName: str(formData, 'payee_name') ?? 'Campus Dash payee',
      });
      if (!result.ok) throw new Error(result.error ?? result.skipped ?? 'could not register');
      return result;
    },
    'Registered with the payment provider.',
    ['/admin/settlements']
  );
}

export async function updateConfigAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  return run(
    () =>
      admin.updateConfig({
        reason: str(formData, 'reason'),
        serviceFeeBps: num(formData, 'service_fee_bps'),
        deliveryFeePesewas: num(formData, 'delivery_fee_pesewas'),
        partnerSearchSeconds: num(formData, 'partner_search_seconds'),
        customerAbsentWaitSeconds: num(formData, 'customer_absent_wait_seconds'),
        paymentPendingTimeoutSeconds: num(formData, 'payment_pending_timeout_seconds'),
        minPayoutPesewas: num(formData, 'min_payout_pesewas'),
        customerPollSeconds: num(formData, 'customer_poll_seconds'),
        scanServiceFeePesewas: num(formData, 'scan_service_fee_pesewas'),
        maxActiveDeliveriesPerPartner: num(formData, 'max_active_deliveries_per_partner'),
        partnerMinPayoutPesewas: num(formData, 'partner_min_payout_pesewas'),
        scanPackFeePesewas: num(formData, 'scan_pack_fee_pesewas'),
        // A CHECKBOX IS ALWAYS PRESENT OR ABSENT, never null, so this one field
        // does not follow the "blank means leave alone" rule the rest of the
        // form does. An unticked box is a deliberate "off", and the form
        // renders its current value as the default so a save cannot flip it by
        // accident.
        partnerDeliveryEnabled: formData.get('partner_delivery_enabled') === 'on',
      }),
    'Settings saved. Fee changes apply to the next order.',
    ['/admin/pilot']
  );
}

// --- Scan delivery -----------------------------------------------------------

/**
 * Mints a short-lived link to one customer's meal scan.
 *
 * THE AUTHORISATION IS NOT HERE. scan_image_path() decides, in SQL, whether the
 * caller may see this scan at all — customer, currently-assigned Partner, or
 * admin — and returns nothing otherwise. This action cannot widen that, and an
 * administrator who is somehow not an administrator gets null rather than a URL.
 *
 * Deliberately an ACTION rather than something the page renders on load: viewing
 * a student's meal voucher should be a thing somebody chose to do, and the link
 * expires on its own so a copied URL is dead by the time it is shared.
 */
export async function viewScanAction(_prev, formData) {
  const denied = await authoriseAdminAction();
  if (denied) return denied;

  const orderId = str(formData, 'order_id');
  if (!orderId) return { ok: false, message: 'No order was named.' };

  try {
    const url = await scanImageUrl(orderId);
    if (!url) {
      return {
        ok: false,
        message: 'No scan is available for this order, or you are not authorised to see it.',
      };
    }
    // The URL is handed to the browser and never logged: it is a bearer link to
    // a private document for as long as it lives.
    return { ok: true, message: 'Link ready. It expires shortly.', url };
  } catch (error) {
    return actionFailure(error, CONTEXT);
  }
}
