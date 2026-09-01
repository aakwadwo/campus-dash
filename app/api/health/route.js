import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Environment and connectivity check.
 *
 * Reports whether the environment is wired up and whether Supabase actually
 * answers — the first thing to look at after pointing the app at a new project.
 * Never echoes a secret's value, only whether it is present.
 */
export async function GET() {
  const presence = config.presence();
  // Only what this deployment actually needs counts towards "ready". Arkesel is
  // required once it is the selected provider, and irrelevant before that.
  const env = {
    supabaseUrl: presence.supabaseUrl,
    supabasePublishableKey: presence.supabasePublishableKey,
    supabaseServiceRoleKey: presence.supabaseServiceRoleKey,
    ...(config.smsProvider() === 'arkesel'
      ? {
          arkeselApiKey: presence.arkeselApiKey,
          arkeselSenderId: presence.arkeselSenderId,
          arkeselWebhookSecret: presence.arkeselWebhookSecret,
        }
      : {}),
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
    // The origin is safe to echo and is the fastest way to confirm which
    // project this deployment is actually talking to.
    project: config.isSupabaseConfigured() ? config.supabaseUrl() : null,
    env,
    supabase,
    adapters: { sms: config.smsProvider(), payment: config.paymentProvider() },
  });
}
