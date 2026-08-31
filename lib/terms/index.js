import 'server-only';

import { createClient } from '@/lib/supabase/server';

/**
 * Terms acceptance.
 *
 * A user is asked once per VERSION, not once per login. Publishing a new
 * version is what makes an acceptance outstanding again — which is the whole
 * reason acceptances record a version rather than a boolean.
 */
async function rpc(fn, args) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export function outstandingTerms() {
  return rpc('my_outstanding_terms', {});
}

export async function currentTerms(audience) {
  const rows = await rpc('current_terms', { p_audience: audience });
  return Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null);
}

export function acceptTerms(termsId) {
  return rpc('accept_terms', { p_terms_id: termsId });
}
