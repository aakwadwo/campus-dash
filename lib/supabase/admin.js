import 'server-only';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { config } from '@/lib/config';

/**
 * Service-role client. BYPASSES ROW LEVEL SECURITY.
 *
 * Use only where the server is the authority and has already checked
 * permissions itself: price calculation, order state transitions, Partner
 * assignment, payment/webhook handling, settlement, admin overrides.
 *
 * The `server-only` import above makes the build fail loudly if this file is
 * ever pulled into a client component.
 */
export function createAdminClient() {
  return createSupabaseClient(config.supabaseUrl(), config.supabaseServiceRoleKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
