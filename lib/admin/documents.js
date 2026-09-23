import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { getCapabilities } from '@/lib/auth/session';

import { getPlatformConfig } from '@/lib/platform-config';

const BUCKET = 'partner-documents';

/**
 * Mints a short-lived signed URL for a Partner verification document.
 *
 * This is the ONLY way one of these images is ever exposed. The bucket is
 * private with no storage policies, so nothing reads it through the API.
 *
 * The service-role client is needed to sign, which means the admin check cannot
 * be delegated to RLS — it is made explicitly here, and it is the reason this
 * function exists at all rather than callers signing URLs themselves.
 */
export async function getPartnerDocumentUrl(path) {
  if (!path) return null;

  const me = await getCapabilities();
  if (!me.is_admin) {
    throw new Error('admin privileges required to view verification documents');
  }

  // Never let a caller-supplied path escape the bucket.
  if (path.includes('..') || path.startsWith('/')) {
    throw new Error('invalid document path');
  }

  // Long enough to look at an ID photo, short enough that a leaked link is
  // dead. Configurable, because "long enough" is an operational judgement.
  const { document_signed_url_seconds: ttl } = await getPlatformConfig();

  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, ttl);

  if (error) {
    // A missing object is normal until Phase 8 adds uploads.
    console.error(`[admin] could not sign ${path}:`, error.message);
    return null;
  }
  return data.signedUrl;
}

/**
 * Signed URLs for many documents in ONE storage request, keyed by path.
 *
 * The applications screen used to sign two paths per application one after
 * another — for every application ever made, so the screen got slower with
 * every student who had ever applied. Same checks as getPartnerDocumentUrl():
 * an administrator only, and no path may escape the bucket.
 */
export async function getPartnerDocumentUrls(paths) {
  const wanted = [...new Set((paths ?? []).filter(Boolean))];
  if (wanted.length === 0) return new Map();

  const me = await getCapabilities();
  if (!me.is_admin) {
    throw new Error('admin privileges required to view verification documents');
  }
  if (wanted.some((path) => path.includes('..') || path.startsWith('/'))) {
    throw new Error('invalid document path');
  }

  const { document_signed_url_seconds: ttl } = await getPlatformConfig();
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(wanted, ttl);
  if (error) {
    console.error('[admin] could not sign documents:', error.message);
    return new Map();
  }
  return new Map(
    (data ?? [])
      .filter((row) => row.signedUrl && !row.error)
      .map((row) => [row.path, row.signedUrl])
  );
}

/**
 * Permanently removes a Partner's verification documents once the retention
 * period has passed. Storage first, then the database paths — if the object
 * delete fails we keep the paths so the file is not orphaned unreferenced.
 */
/**
 * Deletes a Partner's verification documents once the retention period is up.
 *
 * BOTH PARTNER DOCUMENTS, and the paths are re-derived server-side rather than
 * taken from the request. A form that posted somebody else's path, or a
 * customer's, deletes nothing.
 *
 * What "both" means has changed. Campus Dash no longer asks for a face
 * photograph, so a current application has only a student ID — but applications
 * made before that change still have one on file, and it is the more sensitive
 * of the two. Purging one and not the other would leave whichever was missed
 * in storage forever, because admin_clear_partner_documents() clears both
 * columns and nothing would then know the object was still there.
 *
 * Irreversible: the storage objects go and the columns are cleared in the same
 * operation. Re-verifying means asking the person for a new photograph.
 */
export async function purgePartnerDocuments({ userId, paths, reason }) {
  const me = await getCapabilities();
  if (!me.is_admin) throw new Error('admin privileges required');

  const supabase = createAdminClient();

  // `paths` is optional and is only ever a filter. A screen that does not know
  // the paths — admin_partner_detail deliberately returns only whether a
  // document EXISTS — can purge without one making a round trip through the
  // browser.
  const allowed = await partnerDocumentPathsFor(userId);
  const targets = (paths ?? allowed).filter(Boolean).filter((path) => allowed.includes(path));

  if (targets.length > 0) {
    const { error } = await supabase.storage.from(BUCKET).remove(targets);
    if (error) throw new Error(`could not delete documents: ${error.message}`);
  }

  // Clearing the paths runs as the SIGNED-IN ADMIN, not the service role: the
  // function records who acted via auth.uid(), and admin_actions.admin_user_id
  // is NOT NULL. A service-role call would have no identity to record.
  const asUser = await createClient();
  const { error: rpcError } = await asUser.rpc('admin_clear_partner_documents', {
    p_user_id: userId,
    p_reason: reason,
  });
  if (rpcError) throw new Error(rpcError.message);
}

/**
 * The storage objects the retention purge may delete for this account.
 *
 * Read from the Partner profile, which is where both paths live. A customer's
 * own documents are not reachable from here at all.
 */
async function partnerDocumentPathsFor(userId) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('partner_profiles')
    .select('student_id_image_path, face_image_path')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`could not read the partner profile: ${error.message}`);
  return [data?.student_id_image_path, data?.face_image_path].filter(Boolean);
}

export { BUCKET as PARTNER_DOCUMENTS_BUCKET };
