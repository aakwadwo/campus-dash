/**
 * Forces anything that goes through lib/supabase/admin.js at the local stack.
 *
 * `.env.local` may legitimately name a HOSTED project — that is how the app is
 * run against one. The test suite must never follow it there: these tests write
 * notification rows and webhook events, and doing that to a real project would
 * corrupt live data on a whim. tests/helpers/db.js already pins its own pool to
 * 127.0.0.1; this pins the service-role client the same way.
 *
 * The values are the fixed local-development credentials every `supabase start`
 * produces. They are not secrets and grant nothing beyond a container on this
 * machine.
 *
 * Import this BEFORE importing any module that reads configuration.
 */
const LOCAL_URL = process.env.TEST_SUPABASE_URL || 'http://127.0.0.1:54321';
const LOCAL_SERVICE_KEY =
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

process.env.NEXT_PUBLIC_SUPABASE_URL = LOCAL_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = LOCAL_SERVICE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

export const LOCAL_SUPABASE = { url: LOCAL_URL };
