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
 * Permanently removes a Partner's verification documents once the retention
 * period has passed. Storage first, then the database paths — if the object
 * delete fails we keep the paths so the file is not orphaned unreferenced.
 */
export async function purgePartnerDocuments({ userId, paths, reason }) {
  const me = await getCapabilities();
  if (!me.is_admin) throw new Error('admin privileges required');

  const supabase = createAdminClient();
  const targets = paths.filter(Boolean);

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

export { BUCKET as PARTNER_DOCUMENTS_BUCKET };
