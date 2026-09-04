import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth/session';

// The bucket keeps its original name. It is infrastructure, referenced by
// scripts/verify-hosted.mjs and by the hosted project itself, and renaming it
// would be a storage migration for a cosmetic gain. What changed is what it
// holds: student ID photographs now arrive at CUSTOMER onboarding rather than
// with a Partner application, and the live face photograph still arrives with
// the application.
const BUCKET = 'partner-documents';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const KINDS = new Set(['student-id', 'face']);

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
 * ON THE FACE PHOTOGRAPH: this endpoint cannot tell a camera capture from a
 * gallery file, and does not pretend to. The browser form offers no file input
 * for it, which is a deterrent; the actual control is that an administrator
 * compares the face against the student ID by hand before approving anyone.
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
  MAX_BYTES,
  ALLOWED as ALLOWED_MIME_TYPES,
  SCAN_ALLOWED as ALLOWED_SCAN_MIME_TYPES,
  KINDS as DOCUMENT_KINDS,
};
