'use server';

const CONTEXT = 'admin action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import * as admin from '@/lib/admin';
import { purgePartnerDocuments } from '@/lib/admin/documents';
import { runSettlement, retryFailedPayouts, periodFor } from '@/lib/settlement';
import { pesewasFromCedisInput } from '@/lib/util/money';

/**
 * Server actions for the admin module.
 *
 * Each one is a thin translation from FormData to a database call. No decision
 * is made here: the database re-checks is_admin(), validates, and writes the
 * audit row in the same transaction as the change.
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

export async function createVendorAction(_prev, formData) {
  return run(
    () =>
      admin.createVendor({
        name: str(formData, 'name'),
        phone: str(formData, 'phone'),
        reason: str(formData, 'reason'),
        locationId: str(formData, 'location_id'),
        locationNote: str(formData, 'location_note'),
        walkMinutes: num(formData, 'walk_minutes'),
      }),
    (v) => `Created ${v.name}. It is DRAFT and not accepting orders yet.`,
    ['/admin/vendors']
  );
}

export async function updateVendorAction(_prev, formData) {
  return run(
    () =>
      admin.updateVendor({
        vendorId: str(formData, 'vendor_id'),
        reason: str(formData, 'reason'),
        name: str(formData, 'name'),
        phone: str(formData, 'phone'),
        locationId: str(formData, 'location_id'),
        locationNote: str(formData, 'location_note'),
        walkMinutes: num(formData, 'walk_minutes'),
      }),
    'Vendor updated.',
    ['/admin/vendors']
  );
}

export async function setVendorStatusAction(_prev, formData) {
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

export async function addVendorUserAction(_prev, formData) {
  return run(
    () =>
      admin.addVendorUser({
        vendorId: str(formData, 'vendor_id'),
        phone: str(formData, 'phone'),
        reason: str(formData, 'reason'),
      }),
    'Staff member added.',
    ['/admin/vendors']
  );
}

export async function removeVendorUserAction(_prev, formData) {
  return run(
    () =>
      admin.removeVendorUser({
        vendorId: str(formData, 'vendor_id'),
        userId: str(formData, 'user_id'),
        reason: str(formData, 'reason'),
      }),
    'Staff member removed.',
    ['/admin/vendors']
  );
}

// --- Menu items -------------------------------------------------------------

export async function createMenuItemAction(_prev, formData) {
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

export async function purgePartnerDocumentsAction(_prev, formData) {
  return run(
    () =>
      purgePartnerDocuments({
        userId: str(formData, 'user_id'),
        paths: [str(formData, 'student_id_image_path'), str(formData, 'face_image_path')],
        reason: str(formData, 'reason'),
      }),
    'Verification documents deleted.',
    ['/admin/partners']
  );
}

// --- Order overrides ---------------------------------------------------------

export async function cancelOrderAction(_prev, formData) {
  return run(
    () =>
      admin.cancelOrder({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Order cancelled. Any money taken is marked for refund.',
    ['/admin/orders']
  );
}

export async function completeOrderAction(_prev, formData) {
  return run(
    () =>
      admin.completeOrder({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Order force-completed.',
    ['/admin/orders']
  );
}

export async function reassignDeliveryAction(_prev, formData) {
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
  return run(
    () =>
      admin.markRefunded({ orderId: str(formData, 'order_id'), reason: str(formData, 'reason') }),
    'Marked as refunded.',
    ['/admin/orders']
  );
}

export async function resolveDisputeAction(_prev, formData) {
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
 * payouts are already PAID.
 */
export async function runSettlementAction(_prev, formData) {
  const payeeType = str(formData, 'payee_type');
  try {
    const { periodStart, periodEnd } = periodFor(payeeType);
    const result = await runSettlement({ payeeType, periodStart, periodEnd });
    revalidatePath('/admin/settlements', 'layout');
    return {
      ok: result.failed === 0,
      message:
        result.attempted === 0
          ? 'Nothing was owed for that period.'
          : `${result.paid} of ${result.attempted} payouts sent.` +
            (result.failed ? ` ${result.failed} failed — you can retry them.` : ''),
    };
  } catch (error) {
    return fail(error);
  }
}

export async function retryPayoutsAction(_prev, formData) {
  try {
    const results = await retryFailedPayouts(str(formData, 'run_id'));
    revalidatePath('/admin/settlements', 'layout');
    const paid = results.filter((r) => r.ok).length;
    return { ok: true, message: `${paid} of ${results.length} retried payouts succeeded.` };
  } catch (error) {
    return fail(error);
  }
}

// --- Pilot configuration -----------------------------------------------------

/** Blank means "leave alone", so a partial edit cannot reset what it never saw. */
export async function updateConfigAction(_prev, formData) {
  return run(
    () =>
      admin.updateConfig({
        reason: str(formData, 'reason'),
        serviceFeeBps: num(formData, 'service_fee_bps'),
        deliveryFeePesewas: num(formData, 'delivery_fee_pesewas'),
        vendorResponseSeconds: num(formData, 'vendor_response_seconds'),
        partnerSearchSeconds: num(formData, 'partner_search_seconds'),
        customerAbsentWaitSeconds: num(formData, 'customer_absent_wait_seconds'),
        paymentPendingTimeoutSeconds: num(formData, 'payment_pending_timeout_seconds'),
        minPayoutPesewas: num(formData, 'min_payout_pesewas'),
        customerPollSeconds: num(formData, 'customer_poll_seconds'),
      }),
    'Settings saved. Fee changes apply to the next order.',
    ['/admin/pilot']
  );
}
