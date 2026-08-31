import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { getUser } from '@/lib/auth/session';

const BUCKET = 'partner-documents';
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Uploads a Partner verification image.
 *
 * Goes through the service-role client because the bucket is private with NO
 * storage policies — nothing reads or writes it through the API. The applicant
 * never receives a storage URL, only the application form's confirmation that
 * a file was accepted.
 *
 * The path is derived from the signed-in user's id, never from the request, so
 * one applicant cannot write into another's folder.
 */
export async function uploadPartnerDocument({ kind, file }) {
  const user = await getUser();
  if (!user) throw new Error('authentication required');

  if (kind !== 'student-id' && kind !== 'face') {
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

export { BUCKET as PARTNER_DOCUMENTS_BUCKET, MAX_BYTES, ALLOWED as ALLOWED_MIME_TYPES };
