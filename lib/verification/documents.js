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

export {
  BUCKET as VERIFICATION_BUCKET,
  MAX_BYTES,
  ALLOWED as ALLOWED_MIME_TYPES,
  KINDS as DOCUMENT_KINDS,
};
