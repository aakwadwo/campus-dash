import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth/session';
import { config } from '@/lib/config';

// The bucket keeps its original name. It is infrastructure, referenced by
// scripts/verify-hosted.mjs and by the hosted project itself, and renaming it
// would be a storage migration for a cosmetic gain. What it holds is now one
// thing: the student ID photograph a Partner application carries.
const BUCKET = 'partner-documents';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
// `face` IS DELIBERATELY ABSENT. Partner onboarding no longer asks for a face
// photograph — the verified school address already established who the
// applicant is — so the endpoint that accepted one is closed rather than left
// open for a form that no longer exists. Existing stored photographs are
// untouched and are removed on the ordinary retention schedule.
const KINDS = new Set(['student-id']);

/**
 * A campus meal scan goes somewhere else entirely.
 *
 * Different bucket, because it is a different subject with a different
 * retention and a different set of readers: a verification document is looked
 * at once by an administrator, whereas a scan is handed to a Partner for the
 * length of one errand. Keeping them apart means a policy change to one can
 * never widen the other.
 *
 * PDF is accepted alongside images because the university issues some
 * entitlements that way, and a student should not have to screenshot a PDF to
 * use the app.
 */
const SCAN_BUCKET = 'scan-documents';
const SCAN_ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SCAN_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Uploads one verification image for the signed-in account.
 *
 * Goes through the service-role client because the bucket is private with NO
 * storage policies — nothing reads or writes it through the API. The uploader
 * never receives a storage URL, only a path the server will accept back on the
 * matching RPC.
 *
 * The path is derived from the signed-in user's id, never from the request, so
 * one person cannot write into another's folder.
 *
 * This endpoint cannot tell a camera capture from a gallery file, and does not
 * pretend to. The control that matters is that an administrator reads every
 * Partner application by hand before approving anyone.
 */
export async function uploadVerificationDocument({ kind, file }) {
  const user = await getUser();
  if (!user) throw new Error('authentication required');

  if (!KINDS.has(kind)) {
    throw new Error('unknown document kind');
  }
  if (!ALLOWED.has(file.type)) {
    throw new Error('Please use a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is too large. Please use one under 5 MB.');
  }

  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${user.id}/${kind}.${extension}`;

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });

  if (error) throw new Error(`Could not save that image: ${error.message}`);

  return { path };
}

/**
 * A storefront photograph goes somewhere else again — a PUBLIC bucket.
 *
 * That is the honest shape of the thing. An unauthenticated visitor browsing
 * the marketplace has to see these, and minting a signed URL per photo per page
 * load would be real cost for no secret: a picture of a plate of jollof is
 * advertising. What stays locked down is WRITING — the bucket has no storage
 * policies at all, so every object in it went through this function, which
 * checks who is asking before it uploads anything.
 */
const VENDOR_IMAGE_BUCKET = 'vendor-images';

export async function uploadVendorImage({ vendorId, file }) {
  const user = await getUser();
  if (!user) throw new Error('authentication required');

  if (!ALLOWED.has(file.type)) {
    throw new Error('Please use a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That image is too large. Please use one under 5 MB.');
  }

  // AUTHORISATION, before a byte is written. The RPC that records the row
  // checks owner-or-admin again, but an unauthorised caller should not get as
  // far as leaving an orphaned object in the bucket to prove it.
  const supabase = createAdminClient();
  const { data: allowed, error: checkError } = await supabase.rpc('is_vendor_staff', {
    p_vendor_id: vendorId,
  });
  if (checkError) throw new Error(checkError.message);

  if (!allowed) {
    const { data: isAdmin } = await supabase
      .from('users')
      .select('is_admin, is_suspended')
      .eq('id', user.id)
      .maybeSingle();
    if (!isAdmin?.is_admin || isAdmin.is_suspended) {
      throw new Error('not authorised for this store');
    }
  }

  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${vendorId}/${crypto.randomUUID()}.${extension}`;

  const { error } = await supabase.storage
    .from(VENDOR_IMAGE_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw new Error(`Could not save that image: ${error.message}`);

  return { path, contentType: file.type, byteSize: file.size };
}

/** Removes the object. The ROW is removed by vendor_delete_image(), which authorises. */
export async function deleteVendorImage(path) {
  const supabase = createAdminClient();
  const { error } = await supabase.storage.from(VENDOR_IMAGE_BUCKET).remove([path]);
  if (error) throw new Error(error.message);
}

/**
 * The public URL a storefront renders. Public bucket, so no signing is needed.
 *
 * process.env is read only in lib/config.js — this goes through the accessor,
 * which also trims a pasted /rest/v1 endpoint back to the origin.
 */
export function vendorImageUrl(path) {
  if (!path) return null;
  return `${config.supabaseUrl()}/storage/v1/object/public/${VENDOR_IMAGE_BUCKET}/${path}`;
}

/**
 * Uploads one campus meal scan for the signed-in account.
 *
 * The path is `<user_id>/scans/<random>.<ext>` and is built HERE, from the
 * session — never from anything the request said. submit_scan_order() then
 * re-checks that the path starts with the caller's own id before it will attach
 * the scan to an order, so a forged path fails twice.
 *
 * A fresh random name per upload, rather than a fixed one like the verification
 * documents use: a student may run several scan errands, and overwriting the
 * previous scan would destroy the artifact behind an order that is still live.
 */
export async function uploadScan({ file }) {
  const user = await getUser();
  if (!user) throw new Error('authentication required');

  if (!SCAN_ALLOWED.has(file.type)) {
    throw new Error('Please upload the scan as a JPEG, PNG, WebP or PDF.');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('That file is too large. Please use one under 5 MB.');
  }

  const path = `${user.id}/scans/${crypto.randomUUID()}.${SCAN_EXTENSION[file.type]}`;

  const supabase = createAdminClient();
  const { error } = await supabase.storage
    .from(SCAN_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });

  if (error) throw new Error(`Could not save that scan: ${error.message}`);

  return { path, contentType: file.type, byteSize: file.size };
}

export {
  BUCKET as VERIFICATION_BUCKET,
  SCAN_BUCKET,
  VENDOR_IMAGE_BUCKET,
  MAX_BYTES,
  ALLOWED as ALLOWED_MIME_TYPES,
  SCAN_ALLOWED as ALLOWED_SCAN_MIME_TYPES,
  KINDS as DOCUMENT_KINDS,
};
