'use server';

const CONTEXT = 'partner action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import * as partner from '@/lib/partner';

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

export async function applyAction(_prev, formData) {
  try {
    await partner.apply({
      studentIdNumber: String(formData.get('student_id_number') ?? '').trim(),
      classYear: String(formData.get('class_year') ?? '').trim(),
      email: String(formData.get('email') ?? '').trim(),
      studentIdImagePath: String(formData.get('student_id_image_path') ?? '').trim(),
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
