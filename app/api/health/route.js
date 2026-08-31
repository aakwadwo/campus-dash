import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Foundation check for Phase 1.
 *
 * Reports whether the environment is wired up and whether Supabase is actually
 * reachable. Never echoes a secret's value — only whether it is present.
 */
export async function GET() {
  const env = {
    supabaseUrl: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
    supabaseAnonKey: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  };

  let supabase = 'not_configured';
  if (config.isSupabaseConfigured()) {
    try {
      const client = await createClient();
      // No session is expected here; we only care that the auth service answers.
      const { error } = await client.auth.getUser();
      supabase = !error || error.name === 'AuthSessionMissingError' ? 'reachable' : 'error';
    } catch {
      supabase = 'unreachable';
    }
  }

  const ready = Object.values(env).every(Boolean) && supabase === 'reachable';

  return NextResponse.json({
    ok: true,
    ready,
    phase: 'Phase 1 — foundation',
    env,
    supabase,
    adapters: { sms: config.smsProvider(), payment: config.paymentProvider() },
  });
}
