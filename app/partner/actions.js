'use server';

const CONTEXT = 'partner action';

import { actionFailure } from '@/lib/errors';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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

/**
 * `paths` are PAGES, not layouts. The Partner layout draws a header and an area
 * switcher and nothing about a delivery, so invalidating it with every job
 * (as `'layout'` on /partner did) re-derived nothing that could have changed.
 */
async function run(fn, successMessage, paths = ['/partner']) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    return fail(error);
  }
  paths.forEach((path) => revalidatePath(path));
  return outcome(result, successMessage);
}

/**
 * ONE DOCUMENT AND ONE AGREEMENT: a photograph of the student ID, and the
 * Partner terms.
 *
 * Everything else a reviewer needs — name, level, verified school address — is
 * already on the account, and partner_apply() reads it from there. This action
 * could not pass a different applicant's details even if the form sent them.
 *
 * The terms id comes from the SERVER, not the form: current_terms() returns the
 * published version and partner_apply() refuses anything that is not the latest
 * one, so a stale tab cannot record an acceptance of superseded terms.
 */
export async function applyAction(_prev, formData) {
  if (formData.get('accept_terms') !== 'on') {
    return { ok: false, message: 'You must accept the Partner terms to apply.' };
  }

  try {
    const { currentTerms } = await import('@/lib/terms');
    const terms = await currentTerms('PARTNER');

    await partner.apply({
      studentIdImagePath: String(formData.get('student_id_image_path') ?? '').trim(),
      termsId: terms?.terms_id ?? null,
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
    message: 'Application received. We will let you know once someone has read it.',
  };
}

export async function setAvailabilityAction(formData) {
  try {
    await partner.setAvailability(formData.get('available') === 'true');
  } catch (error) {
    return fail(error);
  }
  // Home, where the switch is, and the offer list, which is empty while offline.
  revalidatePath('/partner');
  revalidatePath('/partner/offers');
  return { ok: true };
}

/**
 * First valid acceptance wins, and that is decided in partner_accept_delivery()
 * — atomically, with the slot index behind it. Nothing here changes that.
 *
 * A WIN REDIRECTS. The next thing a Partner needs is where to walk, so the
 * delivery screen comes back as this action's response instead of the offer
 * list being re-rendered first and then navigated away from. redirect() throws,
 * so it sits outside the try; a loss or an error returns a message as before.
 */
export async function acceptDeliveryAction(_prev, formData) {
  const orderId = String(formData.get('order_id') ?? '');
  let result;
  try {
    result = await partner.acceptDelivery(orderId);
  } catch (error) {
    return fail(error);
  }
  if (!result.success) return outcome(result);

  // Home lists what this Partner is carrying.
  revalidatePath('/partner');
  redirect(`/partner/delivery?order=${encodeURIComponent(orderId)}`);
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

/**
 * The Partner types in the code the VENDOR reads out at the counter.
 *
 * The direction reversed: the person who is about to walk away with somebody's
 * dinner is the one who performs the act. There is no function that shows a
 * Partner this code, and there must not be — possession of the secret is what
 * the handoff proves.
 */
export async function confirmPickupAction(_prev, formData) {
  return run(
    () =>
      partner.confirmPickup(
        String(formData.get('order_id') ?? ''),
        String(formData.get('pickup_code') ?? '').trim()
      ),
    'Collected. Take it to the customer.',
    ['/partner', '/partner/delivery']
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

function str(formData, name) {
  return String(formData.get(name) ?? '').trim();
}
