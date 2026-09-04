'use server';

const CONTEXT = 'partner action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import * as partner from '@/lib/partner';
import * as scan from '@/lib/scan';

/**
 * Partner actions.
 *
 * Thin translations from a button to a database call. Nothing is decided here:
 * the database checks approval, availability, and whether this delivery is
 * theirs.
 */
/**
 * Never lets a raw error reach a screen. toUserError() logs the detail
 * server-side and returns a sentence a person can act on, classified so a lost
 * race does not read like a catastrophe.
 */
function fail(error) {
  return actionFailure(error, CONTEXT);
}

function outcome(result, successMessage) {
  return result.success
    ? { ok: true, message: successMessage }
    : { ok: false, message: result.reason ?? 'That is no longer possible.' };
}

async function run(fn, successMessage, paths = ['/partner']) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    return fail(error);
  }
  paths.forEach((path) => revalidatePath(path, 'layout'));
  return outcome(result, successMessage);
}

/**
 * One field, because the application adds one thing. Everything else the
 * reviewer needs is already on the account, and partner_apply() reads it from
 * there — this action could not pass a different student ID even if the form
 * sent one.
 */
export async function applyAction(_prev, formData) {
  try {
    await partner.apply({
      faceImagePath: String(formData.get('face_image_path') ?? '').trim(),
    });
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/partner', 'layout');
  // `submitted` is what switches the page from a form to a confirmation. A
  // message alone left the filled-in form on screen, which reads as "nothing
  // happened" and invites a second submission.
  return {
    ok: true,
    submitted: true,
    message: "Application submitted. We'll review it and let you know when a decision is made.",
  };
}

export async function setAvailabilityAction(formData) {
  try {
    await partner.setAvailability(formData.get('available') === 'true');
  } catch (error) {
    return fail(error);
  }
  revalidatePath('/partner', 'layout');
  return { ok: true };
}

export async function acceptDeliveryAction(_prev, formData) {
  return run(
    () => partner.acceptDelivery(String(formData.get('order_id') ?? '')),
    'Delivery accepted. Head to the vendor.',
    ['/partner', '/partner/offers', '/partner/delivery']
  );
}

export async function cancelDeliveryAction(_prev, formData) {
  return run(
    () =>
      partner.cancelDelivery(
        String(formData.get('order_id') ?? ''),
        String(formData.get('reason') ?? '').trim() || null
      ),
    'Cancelled. The order goes back to other Partners.',
    ['/partner', '/partner/offers', '/partner/delivery']
  );
}

export async function completeDeliveryAction(_prev, formData) {
  return run(
    () =>
      partner.completeDelivery(
        String(formData.get('order_id') ?? ''),
        String(formData.get('delivery_code') ?? '').trim()
      ),
    'Delivered. Your earning has been recorded.',
    ['/partner', '/partner/delivery']
  );
}

export async function reportAbsentAction(_prev, formData) {
  return run(
    () => partner.reportCustomerAbsent(String(formData.get('order_id') ?? '')),
    'Recorded. Please wait a few minutes and try to reach them again.',
    ['/partner', '/partner/delivery']
  );
}

export async function confirmAbsentAction(_prev, formData) {
  return run(
    () => partner.confirmCustomerAbsent(String(formData.get('order_id') ?? '')),
    'Closed as customer absent. Campus Dash support will follow up.',
    ['/partner', '/partner/delivery']
  );
}

// --- Scan delivery -----------------------------------------------------------
// Two reports, and they are reports. Campus Dash has no line into the
// university's scan system, so what a Partner presses here is their account of
// what the counter did — which is exactly why redeeming is a deliberate act and
// not a side effect of having accepted the job.

/**
 * "The restaurant honoured it and I have the food."
 *
 * This is also what puts the delivery into PICKED_UP, so it is the only road to
 * completing a scan errand. A Partner who never presses it cannot deliver.
 */
export async function reportScanRedeemedAction(_prev, formData) {
  return run(
    () => scan.reportScanRedeemed(str(formData, 'order_id')),
    'Scan redeemed. Take the food to the customer.',
    ['/partner', '/partner/delivery']
  );
}

/**
 * "They would not honour it."
 *
 * Records the failure and stops there. No refund is issued and no payout is
 * cancelled, because no policy says what should happen to the money — an
 * administrator resolves it. See docs/SCAN.md.
 */
export async function reportScanRefusedAction(_prev, formData) {
  const reason = str(formData, 'reason');
  if (!reason) {
    return { ok: false, message: 'Say what happened at the restaurant.' };
  }
  return run(
    () => scan.reportScanRefused(str(formData, 'order_id'), reason),
    'Recorded. Campus Dash will follow this up — do not pay for the food yourself.',
    ['/partner', '/partner/delivery']
  );
}

function str(formData, name) {
  return String(formData.get(name) ?? '').trim();
}
